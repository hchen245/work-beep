// agent 循环：OpenAI 兼容接口流式 + 工具调用循环。
// 从 ChatView 抽出（原 send()）：UI 状态走 chat store，API 历史自持，
// 工具列表每轮现取注册表（内置工具 ∪ 活跃插件注入工具），派发前做 schema 校验。
import { reactive } from "vue";
import { invoke } from "@tauri-apps/api/core";
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
// timeout 30s（SDK 默认 10 分钟太久）、maxRetries 1（默认 2，失败时静默重试拖很久）
// 客户端随首份配置懒创建（配置是运行时异步读到的，不能模块顶层建）
let client: OpenAI | null = null;

function clientOf(cfg: LlmConfig): OpenAI {
    if (!client) {
        client = new OpenAI({
            baseURL: cfg.url ?? "",
            apiKey: cfg.key || "local",
            dangerouslyAllowBrowser: true,
            timeout: 30_000,
            maxRetries: 1,
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

const MAX_TOOL_ROUNDS = 50;

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
    apiHistory[0] = { role: "system", content: SYSTEM_PROMPT };
    resetToolChain();

    chat.messages.push({ role: "user", content: text });
    apiHistory.push({ role: "user", content: text });
    chat.input = "";
    chat.sending = true;
    abortCtrl = new AbortController();

    // 先放一条空的助手消息，流式逐段往里追加（跨工具轮次共用同一条）
    // 注意必须是 reactive：普通对象 push 进数组后，改原始引用不会触发 Vue 更新，
    // 就会出现"流式期间界面不动、结束时一次性闪出来"
    const reply = reactive<ChatMessage>({ role: "assistant", content: "", think: "" });
    chat.messages.push(reply);

    try {
        // 工具调用循环：模型返回 tool_calls 就执行工具、把结果回灌进历史，再开下一轮
        for (let round = 0; ; round++) {
            // chat_template_kwargs 不在 SDK 类型里，先用变量装（避开字面量超额属性检查）再传入。
            // 官方 OpenAI 不带该字段。gpt-5 / gpt-6 带函数工具时必须 reasoning_effort=none。
            const tools = getOpenAITools();
            const extra = supportsChatTemplateKwargs(cfg.url)
                ? { chat_template_kwargs: { enable_thinking: chat.thinking === "on" } }
                : isOfficialOpenAI(cfg.url) && tools.length > 0 && modelNeedsReasoningNone(cfg.model)
                  ? { reasoning_effort: "none" as const }
                  : {};
            const body = {
                model: cfg.model,
                messages: apiHistory,
                stream: true as const,
                tools,
                ...extra,
            };
            let stream;
            try {
                stream = await llm.chat.completions.create(
                    body,
                    { signal: abortCtrl.signal },
                );
            } catch (err) {
                if ("chat_template_kwargs" in body && rejectedChatTemplateKwargs(err)) {
                    skipChatTemplateKwargs = true;
                    stream = await llm.chat.completions.create(
                        {
                            model: body.model,
                            messages: body.messages,
                            stream: body.stream,
                            tools: body.tools,
                        },
                        { signal: abortCtrl.signal },
                    );
                } else if (rejectedToolsWithReasoning(err) && body.reasoning_effort !== "none") {
                    reasoningNoneModels.add(cfg.model);
                    stream = await llm.chat.completions.create(
                        {
                            model: body.model,
                            messages: body.messages,
                            stream: body.stream,
                            tools: body.tools,
                            reasoning_effort: "none",
                        },
                        { signal: abortCtrl.signal },
                    );
                } else {
                    throw err;
                }
            }

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

            // 无工具调用：本轮即最终回复，收尾
            if (toolCalls.size === 0) {
                apiHistory.push({ role: "assistant", content: reply.content });
                return;
            }

            // 有工具调用：记入 API 历史，逐个执行并回灌结果
            const calls = [...toolCalls.values()];
            console.log("[HARNESS] tool calls", calls);
            apiHistory.push({
                role: "assistant",
                content: reply.content || null,
                tool_calls: calls.map((t) => ({
                    id: t.id,
                    type: "function" as const,
                    function: { name: t.name, arguments: t.arguments },
                })),
            });
            for (const call of calls) {
                chat.messages.push({ role: "tool", content: `调用工具 ${realName(call.name)}` });
                const result = await execute(call.name, call.arguments);
                console.log("[HARNESS] tool result", {
                    tool: call.name,
                    arguments: call.arguments,
                    result,
                });
                apiHistory.push({ role: "tool", tool_call_id: call.id, content: result });
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
