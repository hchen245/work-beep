// agent 循环：OpenAI 兼容接口流式 + 工具调用循环。
// 从 ChatView 抽出（原 send()）：UI 状态走 chat store，API 历史自持，
// 工具列表每轮现取注册表（内置工具 ∪ 活跃插件注入工具），派发前做 schema 校验。
import { reactive } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import OpenAI from "openai";
import { useChatStore } from "../stores/chat";
import type { ChatMessage } from "../stores/chat";
import { execute, getOpenAITools, realName, resetToolChain } from "../tools/registry";

// OpenAI 兼容接口，配置见 .env.example
// VITE_LLM_API_URL 填服务商文档给的完整 baseURL（一般已含 /v1），代码原样透传
// 配置来源：dev 走 Vite 构建期注入的 import.meta.env（读仓库根目录 .env）；
// release（打包 exe）构建期没有 .env，回退到运行时读基准目录 .env（Rust root_env，
// release 锚 exe 同目录、dev 锚仓库根目录）。加载一次后缓存。
interface LlmConfig {
    url?: string;
    key?: string;
    model: string;
}

let cfgPromise: Promise<LlmConfig> | null = null;

function loadConfig(): Promise<LlmConfig> {
    if (cfgPromise) return cfgPromise;
    cfgPromise = (async () => {
        const env: Record<string, string | undefined> = {};
        // import.meta.env 缺失时回退读运行时 .env（release 场景）
        if (!import.meta.env.VITE_LLM_API_URL) {
            const text = await invoke<string>("root_env").catch(() => "");
            for (const line of text.split(/\r?\n/)) {
                const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
                if (m) env[m[1]] = m[2];
            }
        }
        return {
            url: import.meta.env.VITE_LLM_API_URL ?? env.VITE_LLM_API_URL,
            key: import.meta.env.VITE_LLM_API_KEY ?? env.VITE_LLM_API_KEY,
            model: import.meta.env.VITE_LLM_MODEL ?? env.VITE_LLM_MODEL ?? "gpt-4o-mini",
        };
    })();
    return cfgPromise;
}

// 桌面应用 key 本来就在前端，本地服务也不校验 key
// timeout 120s：三视图验收会把 PNG 放进下一次请求，30s 不够
// maxRetries 0：429 只由 harness 的 withRateLimitRetry 处理，避免和 SDK 重试叠加
// 客户端随首份配置懒创建（配置是运行时异步读到的，不能模块顶层建）
let client: OpenAI | null = null;

function clientOf(cfg: LlmConfig): OpenAI {
    if (!client) {
        client = new OpenAI({
            baseURL: cfg.url ?? "",
            apiKey: cfg.key || "local",
            dangerouslyAllowBrowser: true,
            timeout: 120_000,
            maxRetries: 0,
        });
    }
    return client;
}

// 系统提示：助手人设 + 工具纪律 + 排版要求，不进 UI 消息列表
const SYSTEM_PROMPT = [
    "你是 blenderBeeper 的 Blender Agent。",
    "",
    "你必须遵守以下规则：",
    "1. 当用户要求创建、删除、移动、旋转、缩放或修改 Blender 场景中的对象时，必须实际调用提供的 Blender 工具完成操作。",
    "2. 不要只向用户解释如何在 Blender 中操作，也不要让用户自己手动完成本可由工具完成的操作。",
    "3. 只能调用当前提供的工具，不得虚构不存在的工具或声称执行了实际上没有执行的操作。",
    "4. 工具已拆成多条链。每条新用户任务必须先调用 get_toolchain 获取当前需要的那一条，不要沿用上一任务的链。",
    "5. 链：scene（查/清场景）、object（增删移物体）、mesh（改网格）、modifier（修改器）、material（材质）、light（灯）、camera（相机）、view（视口）、render（出图）、files（工作区文件）。",
    "6. 改已有物体前先 blender.scene_list_objects。链里没有的工具不许用别的命令冒充。",
    "7. 多部件模型保持独立 object，不要为了出图做 Boolean。出整体三视图用 render 链的 blender.render_scene_views。",
    "8. 文件工具在 files 链。如果完成任务需要多个操作，应继续调用必要的工具，直到任务完成或达到工具调用上限。",
    "9. 如果工具返回错误，根据错误信息修正操作；无法完成时明确说明失败原因。",
    "10. 只有在工具成功执行后，才能告诉用户相应操作已经完成。",
    "11. 完成后用简短中文总结实际完成的操作。",
].join("\n");

// API 侧会话历史（含 system / assistant 的 tool_calls / 工具结果），与 UI 消息分开维护
const apiHistory: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
];
// 仅 appendRenderedViews 推入的验收图消息。清旧图时只删这些对象。
const harnessRenderMessages = new Set<OpenAI.ChatCompletionMessageParam>();

const MAX_TOOL_ROUNDS = 50;
const MAX_HARNESS_ITERATIONS = 5;
// 首次请求之外的 429 重试次数。同一请求原地重试，不推进 tool round / harness iteration。
const MAX_RATE_LIMIT_RETRIES = 5;

// 当前请求的取消控制器，停止按钮（■）触发
let abortCtrl: AbortController | null = null;

// llama.cpp / vLLM 用 chat_template_kwargs.enable_thinking 控制思考。
// OpenAI 官方与 Azure OpenAI 不认该字段，带上会 400 Unknown parameter。
// 其它兼容网关若同样拒绝，本会话后续请求不再带上。
let skipChatTemplateKwargs = false;

// gpt-6 等推理模型在 /v1/chat/completions 里默认带 reasoning，
// 与 function tools 冲突，必须显式 reasoning_effort=none。命中过该 400 的模型记在这里。
const reasoningNoneModels = new Set<string>();

function isOfficialOpenAI(url: string | undefined): boolean {
    if (!url) return false;
    try {
        const host = new URL(url).hostname.toLowerCase();
        return host === "api.openai.com" || host.endsWith(".openai.azure.com");
    } catch {
        return false;
    }
}

function supportsChatTemplateKwargs(url: string | undefined): boolean {
    if (skipChatTemplateKwargs || !url || isOfficialOpenAI(url)) return false;
    try {
        new URL(url);
        return true;
    } catch {
        return false;
    }
}

function modelNeedsReasoningNone(model: string): boolean {
    if (reasoningNoneModels.has(model)) return true;
    // o 系列、gpt-5 / gpt-6 默认会推理；chat completions + 工具时必须关掉
    return /^(o\d|gpt-5|gpt-6)/i.test(model);
}

function rejectedChatTemplateKwargs(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /unknown parameter/i.test(msg) && /chat_template_kwargs/.test(msg);
}

function rejectedToolsWithReasoning(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /function tools with reasoning_effort/i.test(msg);
}

function resetApiHistory() {
    apiHistory.splice(1);
    harnessRenderMessages.clear();
    apiHistory[0] = { role: "system", content: SYSTEM_PROMPT };
    console.log("[HARNESS] api history reset", { messages: apiHistory.length });
}

function dropPreviousRenderedViews() {
    if (harnessRenderMessages.size === 0) return;
    let removed = 0;
    for (let i = apiHistory.length - 1; i >= 1; i--) {
        if (!harnessRenderMessages.has(apiHistory[i])) continue;
        apiHistory.splice(i, 1);
        removed++;
    }
    harnessRenderMessages.clear();
    console.log("[HARNESS] drop previous rendered views", { removed, messages: apiHistory.length });
}

type RateLimitError = InstanceType<typeof OpenAI.APIError>;

function isRateLimitError(err: unknown): err is RateLimitError {
    return err instanceof OpenAI.APIError && err.status === 429;
}

function rateLimitWaitMs(err: RateLimitError, attempt: number): number {
    const msHeader = err.headers?.get("retry-after-ms");
    if (msHeader) {
        const ms = Number(msHeader);
        if (Number.isFinite(ms) && ms >= 0) return ms;
    }
    const after = err.headers?.get("retry-after");
    if (after) {
        const seconds = Number(after);
        if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
        const when = Date.parse(after);
        if (Number.isFinite(when)) return Math.max(0, when - Date.now());
    }
    const exp = Math.min(60_000, 1000 * 2 ** attempt);
    return Math.round(exp / 2 + Math.random() * (exp / 2));
}

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

async function withRateLimitRetry<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await run();
        } catch (err) {
            if (signal.aborted || !isRateLimitError(err) || attempt >= MAX_RATE_LIMIT_RETRIES) throw err;
            const waitMs = rateLimitWaitMs(err, attempt);
            console.log("[HARNESS] rate limit", {
                attempt: attempt + 1,
                maxAttempts: MAX_RATE_LIMIT_RETRIES + 1,
                waitMs,
            });
            await sleepWithAbort(waitMs, signal);
        }
    }
}

type HarnessVerdict = {
    pass?: boolean;
    priority_fixes?: unknown;
    overall_score?: unknown;
};

function bytesToBase64(bytes: Uint8Array): string {
    const chunkSize = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

async function pngToDataUrl(path: string): Promise<string> {
    const bytes = await readFile(path);
    return `data:image/png;base64,${bytesToBase64(bytes)}`;
}

function parseHarnessJson(text: string): HarnessVerdict | null {
    const trimmed = text.trim();
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = fence ? fence[1].trim() : trimmed;
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
        const obj = JSON.parse(raw.slice(start, end + 1)) as HarnessVerdict;
        if (typeof obj?.pass === "boolean") return obj;
    } catch {
        return null;
    }
    return null;
}

function failFixInstruction(fixes: unknown[]): string {
    return (
        "视觉验收未通过（pass=false）。请只根据下列 priority_fixes 修改当前场景中的现有物体。" +
        "不要清场、不要 Boolean 合并、不要从零重建。" +
        "改物体前用 get_toolchain 切到对应链；改完后必须 get_toolchain 切到 render，再调用 blender.render_scene_views 生成 front/right/top。\n" +
        JSON.stringify(fixes, null, 2)
    );
}

/** render_scene_views 成功时把三张 PNG 写入 apiHistory，返回 true 表示下一轮进入 JUDGE_ONLY。 */
async function appendRenderedViews(toolName: string, result: string, originalUserRequest: string): Promise<boolean> {
    const name = realName(toolName);
    if (name !== "blender.render_scene_views") return false;

    let data: {
        ok?: boolean;
        output_dir?: string;
        views?: { ok?: boolean; path?: string }[];
        results?: { ok?: boolean; path?: string }[];
        data?: {
            ok?: boolean;
            output_dir?: string;
            views?: { ok?: boolean; path?: string }[];
            results?: { ok?: boolean; path?: string }[];
        };
    };
    try {
        data = JSON.parse(result);
    } catch {
        console.log("[HARNESS] rendered views attached", { count: 0, reason: "result 不是 JSON" });
        return false;
    }
    if (data?.data && typeof data.data === "object") {
        data = { ...data, ...data.data };
    }
    if (!data?.ok) {
        console.log("[HARNESS] rendered views attached", { count: 0, reason: "ok 不为 true" });
        return false;
    }

    const renderedViews = Array.isArray(data.views)
        ? data.views
        : Array.isArray(data.results)
          ? data.results
          : [];
    if (renderedViews.length === 0) {
        console.log("[HARNESS] rendered views attached", { count: 0, reason: "没有 views/results" });
        return false;
    }

    if (typeof data.output_dir === "string" && data.output_dir) {
        await invoke("set_workspace", { path: data.output_dir });
    }

    const imageParts: OpenAI.Chat.ChatCompletionContentPart[] = [];
    const paths: string[] = [];
    for (const view of renderedViews) {
        if (!view?.ok || typeof view.path !== "string") continue;
        try {
            const url = await pngToDataUrl(view.path);
            imageParts.push({ type: "image_url", image_url: { url } });
            paths.push(view.path);
        } catch (err) {
            console.error("[HARNESS] rendered views attached", { path: view.path, error: err });
        }
    }
    if (imageParts.length === 0) {
        console.log("[HARNESS] rendered views attached", { count: 0, reason: "没有读到 PNG" });
        return false;
    }

    dropPreviousRenderedViews();
    console.log("[HARNESS] rendered views attached", { count: imageParts.length, paths });
    const renderMessage: OpenAI.ChatCompletionMessageParam = {
        role: "user",
        content: [
            {
                type: "text",
                text: `你现在是 Blender 建模结果的视觉验收器。

用户最初的建模要求是：
"${originalUserRequest}"

请根据刚刚生成的 front、right、top 三张正交渲染图，
判断当前模型是否满足这个要求。

只根据图片中真实可见的内容判断，不要根据文件名、对象名或工具参数猜测。

请严格返回以下 JSON，不要输出 Markdown，不要补充其它文字：

{
  "pass": true,
  "overall_score": 0.0,
  "views": {
    "front": {"score": 0.0, "issues": []},
    "right": {"score": 0.0, "issues": []},
    "top": {"score": 0.0, "issues": []}
  },
  "critical_issues": [],
  "priority_fixes": []
}

评分范围是 0 到 1。

pass=true 的条件：
- overall_score >= 0.80
- 每个视图 score >= 0.70
- critical_issues 为空

如果模型明显缺少用户要求的主要结构，pass 必须为 false。
`,
            },
            ...imageParts,
        ],
    };
    apiHistory.push(renderMessage);
    harnessRenderMessages.add(renderMessage);
    return true;
}

export function stop() {
    abortCtrl?.abort();
}

export async function send() {
    const chat = useChatStore();
    const text = chat.input.trim();
    if (!text || chat.sending) return;

    // 配置运行时懒加载（只加载一次，修改 .env 需重启应用）：
    // dev 读仓库根目录 .env（Vite 注入），release 读 exe 同目录 .env
    const cfg = await loadConfig();
    if (!cfg.url) {
        chat.messages.push({
            role: "assistant",
            content: "未读到 LLM 配置：请把 .env 放到 exe 同目录（dev 为项目根目录，格式见 .env.example），重启应用后生效",
        });
        return;
    }
    const llm = clientOf(cfg);
    resetApiHistory();
    resetToolChain();

    const originalUserRequest = text;
    chat.messages.push({ role: "user", content: text });
    apiHistory.push({ role: "user", content: text });
    chat.input = "";
    chat.sending = true;
    abortCtrl = new AbortController();

    // 每一轮 LLM 请求换一条助手消息，避免建模文字和验收 JSON 拼进同一 content。
    // 必须是 reactive：普通对象 push 进数组后，改原始引用不会触发 Vue 更新。
    let reply = reactive<ChatMessage>({ role: "assistant", content: "", think: "" });
    chat.messages.push(reply);
    let harnessRound = 0;
    // BUILD 可调用工具。JUDGE_ONLY 只看图出 JSON，请求不带 tools，模型若仍给出 tool_calls 也不执行。
    let awaitingHarness = false;
    let harnessNags = 0;

    try {
        for (let round = 0; ; round++) {
            if (round > 0) {
                reply = reactive<ChatMessage>({ role: "assistant", content: "", think: "" });
                chat.messages.push(reply);
            }
            const judging = awaitingHarness;
            console.log("[HARNESS] harness state", {
                state: judging ? "JUDGE_ONLY" : harnessRound > 0 ? "FIX" : "BUILD",
                round,
                harnessRound,
            });

            // 官方 OpenAI 不带 chat_template_kwargs。带工具的 gpt-5 / gpt-6 必须 reasoning_effort=none。
            // JUDGE_ONLY 不传 tools，因此也不会带 reasoning_effort。
            const tools = judging ? [] : getOpenAITools();
            const extra = supportsChatTemplateKwargs(cfg.url)
                ? { chat_template_kwargs: { enable_thinking: chat.thinking === "on" } }
                : isOfficialOpenAI(cfg.url) && tools.length > 0 && modelNeedsReasoningNone(cfg.model)
                  ? { reasoning_effort: "none" as const }
                  : {};
            const body = {
                model: cfg.model,
                messages: apiHistory,
                stream: true as const,
                ...(judging ? {} : { tools }),
                ...extra,
            };
            const requestOptions = { signal: abortCtrl.signal, maxRetries: 0 };
            let stream;
            try {
                stream = await withRateLimitRetry(abortCtrl.signal, () =>
                    llm.chat.completions.create(body, requestOptions),
                );
            } catch (err) {
                if ("chat_template_kwargs" in body && rejectedChatTemplateKwargs(err)) {
                    skipChatTemplateKwargs = true;
                    stream = await withRateLimitRetry(abortCtrl.signal, () =>
                        llm.chat.completions.create(
                            {
                                model: body.model,
                                messages: body.messages,
                                stream: body.stream,
                                ...(judging ? {} : { tools }),
                            },
                            requestOptions,
                        ),
                    );
                } else if (rejectedToolsWithReasoning(err) && body.reasoning_effort !== "none") {
                    reasoningNoneModels.add(cfg.model);
                    stream = await withRateLimitRetry(abortCtrl.signal, () =>
                        llm.chat.completions.create(
                            {
                                model: body.model,
                                messages: body.messages,
                                stream: body.stream,
                                ...(judging ? {} : { tools }),
                                reasoning_effort: "none",
                            },
                            requestOptions,
                        ),
                    );
                } else {
                    throw err;
                }
            }

            const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
            for await (const chunk of stream) {
                const delta = chunk.choices[0]?.delta;
                if (!delta) continue;
                const reasoning = (delta as { reasoning_content?: string }).reasoning_content;
                if (reasoning) reply.think = (reply.think ?? "") + reasoning;
                if (delta.content) reply.content += delta.content;
                for (const tc of delta.tool_calls ?? []) {
                    const idx = tc.index ?? 0;
                    if (!toolCalls.has(idx)) {
                        toolCalls.set(idx, { id: "", name: "", arguments: "" });
                    }
                    const acc = toolCalls.get(idx)!;
                    if (tc.id) acc.id += tc.id;
                    if (tc.function?.name) acc.name += tc.function.name;
                    if (tc.function?.arguments) acc.arguments += tc.function.arguments;
                }
            }

            const verdict = parseHarnessJson(reply.content);
            if (verdict?.pass === true) {
                console.log("[HARNESS] judge result", {
                    pass: true,
                    priority_fixes: verdict.priority_fixes ?? [],
                    overall_score: verdict.overall_score,
                });
                console.log("[HARNESS] harness state", {
                    state: "STOP",
                    reason: "pass",
                    ignoredToolCalls: [...toolCalls.values()].map((t) => realName(t.name)),
                });
                apiHistory.push({ role: "assistant", content: reply.content });
                return;
            }
            if (verdict?.pass === false) {
                const fixes = Array.isArray(verdict.priority_fixes) ? verdict.priority_fixes : [];
                console.log("[HARNESS] judge result", {
                    pass: false,
                    priority_fixes: fixes,
                    overall_score: verdict.overall_score,
                });
                apiHistory.push({ role: "assistant", content: reply.content });
                if (harnessRound >= MAX_HARNESS_ITERATIONS) {
                    console.log("[HARNESS] harness state", {
                        state: "STOP",
                        reason: "max harness iterations",
                        harnessRound,
                    });
                    return;
                }
                harnessRound += 1;
                awaitingHarness = false;
                harnessNags = 0;
                console.log("[HARNESS] harness state", {
                    state: "FIX",
                    harnessRound,
                    priority_fixes: fixes,
                    ignoredToolCalls: [...toolCalls.values()].map((t) => realName(t.name)),
                });
                apiHistory.push({ role: "user", content: failFixInstruction(fixes) });
                continue;
            }

            if (awaitingHarness) {
                console.log("[HARNESS] judge result", { pass: null, raw: reply.content });
                apiHistory.push({
                    role: "assistant",
                    content: reply.content || "（本轮未输出验收 JSON）",
                });
                if (!reply.content) reply.content = "（视觉验收轮次已忽略工具调用，请输出 JSON）";
                harnessNags += 1;
                if (harnessNags > 2) {
                    console.log("[HARNESS] harness state", {
                        state: "STOP",
                        reason: "judge json missing",
                        ignoredToolCalls: [...toolCalls.values()].map((t) => realName(t.name)),
                    });
                    return;
                }
                console.log("[HARNESS] harness state", {
                    state: "JUDGE_ONLY",
                    reason: "retry json",
                    harnessNags,
                    ignoredToolCalls: [...toolCalls.values()].map((t) => realName(t.name)),
                });
                apiHistory.push({
                    role: "user",
                    content: "请只返回视觉验收 JSON，不要调用任何工具，不要输出 Markdown 或其它文字。",
                });
                continue;
            }

            if (toolCalls.size === 0) {
                apiHistory.push({ role: "assistant", content: reply.content });
                return;
            }

            const calls = [...toolCalls.values()];
            const toRun: typeof calls = [];
            for (const call of calls) {
                toRun.push(call);
                if (realName(call.name) === "blender.render_scene_views") break;
            }
            console.log("[HARNESS] tool calls", toRun);
            if (toRun.length < calls.length) {
                console.log("[HARNESS] harness state", {
                    state: "BUILD",
                    droppedAfterRender: calls.slice(toRun.length).map((t) => realName(t.name)),
                });
            }
            apiHistory.push({
                role: "assistant",
                content: reply.content || null,
                tool_calls: toRun.map((t) => ({
                    id: t.id,
                    type: "function" as const,
                    function: { name: t.name, arguments: t.arguments },
                })),
            });
            for (const call of toRun) {
                chat.messages.push({ role: "tool", content: `调用工具 ${realName(call.name)}` });
                const result = await execute(call.name, call.arguments);
                console.log("[HARNESS] tool result", {
                    tool: call.name,
                    arguments: call.arguments,
                    result,
                });
                apiHistory.push({ role: "tool", tool_call_id: call.id, content: result });
                if (await appendRenderedViews(call.name, result, originalUserRequest)) {
                    awaitingHarness = true;
                    harnessNags = 0;
                }
            }
            if (round + 1 >= MAX_TOOL_ROUNDS) throw new Error("工具调用轮次超限");
        }
    } catch (err) {
        if (abortCtrl.signal.aborted) {
            // 手动停止：保留已生成的部分内容
            if (!reply.content && !reply.think) reply.content = "已停止生成";
        } else {
            console.error("请求出错", err);
            reply.content += `请求失败：${err instanceof Error ? err.message : String(err)}`;
        }
    } finally {
        chat.sending = false;
        abortCtrl = null;
    }
}
