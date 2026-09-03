// agent 循环：OpenAI 兼容接口流式 + 工具调用循环。
// 从 ChatView 抽出（原 send()）：UI 状态走 chat store，API 历史自持，
// 工具列表每轮现取注册表（内置工具 ∪ 活跃插件注入工具），派发前做 schema 校验。
import { reactive } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import OpenAI from "openai";
import { useChatStore } from "../stores/chat";
import type { ChatMessage } from "../stores/chat";
import { execute, getOpenAITools, realName } from "../tools/registry";

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
// timeout 120s：带上三张 PNG 的 Vision 请求可能超过 30s
// maxRetries 1（默认 2，失败时静默重试拖很久）
// 客户端随首份配置懒创建（配置是运行时异步读到的，不能模块顶层建）
let client: OpenAI | null = null;

function clientOf(cfg: LlmConfig): OpenAI {
    if (!client) {
        client = new OpenAI({
            baseURL: cfg.url ?? "",
            apiKey: cfg.key || "local",
            dangerouslyAllowBrowser: true,
            timeout: 120_000,
            maxRetries: 1,
        });
    }
    return client;
}

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

/** 成功把三视图塞进 apiHistory 后返回 true，供 send() 切入 JUDGE_ONLY。 */
async function appendRenderedViews(
    toolName: string,
    result: string,
    originalUserRequest: string,
): Promise<boolean> {
    const name = realName(toolName);
    console.log("[appendRenderedViews]", { toolName, name, result: result.slice(0, 2000) });
    if (name !== "blender.render_scene_views") {
        return false;
    }

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
        return false;
    }
    if (data?.data && typeof data.data === "object") {
        data = { ...data, ...data.data };
    }
    if (!data?.ok) {
        console.log("[appendRenderedViews] skip: ok 不为 true", data?.ok);
        return false;
    }

    const renderedViews = Array.isArray(data.views)
        ? data.views
        : Array.isArray(data.results)
          ? data.results
          : [];
    if (renderedViews.length === 0) {
        console.log("[appendRenderedViews] skip: 没有 views/results 数组");
        return false;
    }

    if (typeof data.output_dir === "string" && data.output_dir) {
        await invoke("set_workspace", { path: data.output_dir });
    }

    const imageParts: any[] = [];
    for (const view of renderedViews) {
        if (!view?.ok || typeof view.path !== "string") {
            console.log("[appendRenderedViews] skip view", view);
            continue;
        }
        try {
            const url = await pngToDataUrl(view.path);
            imageParts.push({
                type: "image_url",
                image_url: { url },
            });
        } catch (err) {
            console.error("[appendRenderedViews] 读 PNG 失败", view.path, err);
        }
    }
    if (imageParts.length === 0) {
        console.log("[appendRenderedViews] skip: 没有成功读到任何 PNG");
        return false;
    }
    console.log("[appendRenderedViews] 已追加", imageParts.length, "张图到 apiHistory");

    apiHistory.push({
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
    });
    return true;
}

function failFixInstruction(fixes: unknown[]): string {
    return (
        "视觉验收未通过（pass=false）。请只根据下列 priority_fixes 修改当前场景中的现有物体。" +
        "不要清场、不要 Boolean 合并、不要从零重建。" +
        "改完后必须调用 blender.render_scene_views 生成 front/right/top。\n" +
        JSON.stringify(fixes, null, 2)
    );
}

// 系统提示：助手人设 + 工具纪律 + 排版要求，不进 UI 消息列表
const SYSTEM_PROMPT = [
    "你是 blenderBeeper 的助手。用户用自然语言描述需求，你通过调用提供的工具来完成：",
    "Blender 建模时应尽量减少不必要的工具调用。",
    "多部件模型应保持为独立 object，不要为了渲染执行 Boolean 合并。",
    "当场景包含多个模型部件时，必须优先使用 blender.render_scene_views 生成整体 front/right/top 三视图。",
    "不要对多部件场景分别调用 blender.render_view 或 blender.render_views。",
    "如果已经成功生成三视图，不要重复渲染相同视图，除非视觉验收明确要求修改后重新渲染。",
    "不要为了三视图渲染额外创建 Camera 或 Light，render_scene_views 自己负责验收视图所需的相机。",
    "文件工具（read/write/edit/ls/grep）操作当前工作区，带命名空间前缀的工具操作已激活的外部应用。",
    "操作完成后用简短中文说明结果。",
    "回答一律使用 Markdown 排版，数学公式用 LaTeX（行内 $...$，独立公式 $$...$$），",
    "直接输出 Markdown 正文，不要用代码块包裹整篇回答。",
    "视觉验收 JSON 除外：若用户或系统要求返回验收 JSON，则只输出 JSON。",
].join("");

// API 侧会话历史（含 system / assistant 的 tool_calls / 工具结果），与 UI 消息分开维护
const apiHistory: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
];

const MAX_TOOL_ROUNDS = 10;
const MAX_HARNESS_ITERATIONS = 5;

function parseHarnessJson(text: string): { pass?: boolean; priority_fixes?: unknown } | null {
    const trimmed = text.trim();
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = fence ? fence[1].trim() : trimmed;
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
        const obj = JSON.parse(raw.slice(start, end + 1));
        if (typeof obj?.pass === "boolean") return obj;
    } catch {
        return null;
    }
    return null;
}

// 当前请求的取消控制器，停止按钮（■）触发
let abortCtrl: AbortController | null = null;

export function stop() {
    abortCtrl?.abort();
}

export async function send() {
    const chat = useChatStore();
    const text = chat.input.trim();
    if (!text || chat.sending) return;
    const originalUserRequest = text;

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
    apiHistory[0] = { role: "system", content: SYSTEM_PROMPT };

    chat.messages.push({ role: "user", content: text });
    apiHistory.push({ role: "user", content: text });
    chat.input = "";
    chat.sending = true;
    abortCtrl = new AbortController();

    // 先放一条空的助手消息，流式逐段往里追加。
    // 每一轮 LLM 请求都换一条独立 reply，避免 BUILD 文字和 JUDGE JSON 拼进同一 content，
    // 导致 parseHarnessJson 从第一个 { 截到最后一个 } 解析失败。
    // 注意必须是 reactive：普通对象 push 进数组后，改原始引用不会触发 Vue 更新，
    // 就会出现"流式期间界面不动、结束时一次性闪出来"
    let reply = reactive<ChatMessage>({ role: "assistant", content: "", think: "" });
    chat.messages.push(reply);
    let harnessRound = 0;
    // BUILD：可执行建模工具。JUDGE_ONLY（awaitingHarness）：只许看图出 JSON，物理丢弃 tool_calls。
    let awaitingHarness = false;
    let harnessNags = 0;

    try {
        // 工具调用循环。Harness JSON 优先于任何 tool_calls：pass=true 直接结束，pass=false 由 Host 发修正指令。
        for (let round = 0; ; round++) {
            if (round > 0) {
                reply = reactive<ChatMessage>({
                    role: "assistant",
                    content: "",
                    think: "",
                });
                chat.messages.push(reply);
            }
            // chat_template_kwargs 不在 SDK 类型里，先用变量装（避开字面量超额属性检查）再传入
            const body: any = {
                model: cfg.model,
                messages: apiHistory,
                stream: true,
                provider: {
                    order: ["Alibaba"],
                    allow_fallbacks: false,
                    require_parameters: true,
                },
                chat_template_kwargs: { enable_thinking: chat.thinking === "on" },
            };
            // JUDGE_ONLY 不把工具 schema 发给模型，从请求侧禁止建模
            if (!awaitingHarness) {
                body.tools = getOpenAITools();
            }
            const stream = await llm.chat.completions.create(
                body,
                { signal: abortCtrl.signal },
            );

            // 流式 tool_calls 按 index 分片累积
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

            // 第一刀：无论是否夹带 tool_calls，pass=true 都在执行工具之前结束
            if (verdict?.pass === true) {
                if (toolCalls.size > 0) {
                    console.log("[harness] PASS，忽略本轮 tool_calls", [...toolCalls.values()].map((t) => t.name));
                }
                apiHistory.push({ role: "assistant", content: reply.content });
                console.log("[harness] PASS → STOP");
                return;
            }

            // pass=false：同样不执行这一轮顺手生成的工具，由 Host 发 correction
            if (verdict?.pass === false) {
                if (toolCalls.size > 0) {
                    console.log("[harness] FAIL，忽略本轮 tool_calls", [...toolCalls.values()].map((t) => t.name));
                }
                apiHistory.push({ role: "assistant", content: reply.content });
                if (harnessRound >= MAX_HARNESS_ITERATIONS) {
                    console.log("[harness] FAIL 已达最大纠错轮数 → STOP");
                    return;
                }
                harnessRound += 1;
                awaitingHarness = false;
                harnessNags = 0;
                const fixes = Array.isArray(verdict.priority_fixes)
                    ? verdict.priority_fixes
                    : [];
                console.log("[harness] FAIL → FIX", harnessRound, fixes);
                apiHistory.push({ role: "user", content: failFixInstruction(fixes) });
                continue;
            }

            // JUDGE_ONLY 且没有合法验收 JSON：禁止执行工具，要求重出 JSON
            if (awaitingHarness) {
                if (toolCalls.size > 0) {
                    console.log("[harness] JUDGE_ONLY，忽略 tool_calls", [...toolCalls.values()].map((t) => t.name));
                }
                apiHistory.push({
                    role: "assistant",
                    content: reply.content || "（本轮未输出验收 JSON）",
                });
                if (!reply.content) {
                    reply.content = "（视觉验收轮次已忽略工具调用，请输出 JSON）";
                }
                harnessNags += 1;
                if (harnessNags > 2) {
                    console.log("[harness] JUDGE_ONLY 连续未得到 JSON → STOP");
                    return;
                }
                apiHistory.push({
                    role: "user",
                    content: "请只返回视觉验收 JSON，不要调用任何工具，不要输出 Markdown 或其它文字。",
                });
                continue;
            }

            // 普通 BUILD：没有工具即最终回复
            if (toolCalls.size === 0) {
                apiHistory.push({ role: "assistant", content: reply.content });
                return;
            }

            // 同一批里 scene_views 之后的工具丢掉，避免渲完立刻再改模型
            const allCalls = [...toolCalls.values()];
            const toRun: typeof allCalls = [];
            for (const call of allCalls) {
                toRun.push(call);
                if (realName(call.name) === "blender.render_scene_views") {
                    break;
                }
            }
            if (toRun.length < allCalls.length) {
                console.log(
                    "[harness] 丢弃 render_scene_views 之后的 tool_calls",
                    allCalls.slice(toRun.length).map((t) => t.name),
                );
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
                apiHistory.push({ role: "tool", tool_call_id: call.id, content: result });
                if (await appendRenderedViews(call.name, result, originalUserRequest)) {
                    awaitingHarness = true;
                    harnessNags = 0;
                    console.log("[harness] RENDER → JUDGE_ONLY");
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
