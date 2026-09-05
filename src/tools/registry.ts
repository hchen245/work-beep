// 工具注册表：内置工具（无命名空间）+ 插件注入工具（强制 "插件id." 前缀）。
// 供 agent 循环拼 tools schema、校验参数、派发执行。
// 设计原则：schema 要短（token 大头），校验失败作为 tool 错误喂回模型。
import type OpenAI from "openai";
import type { PluginTool } from "@beep/sdk";

// Host 内部工具形状：与 SDK 的 PluginTool 同构，但 run 已绑定好 ctx（内置工具不需要 ctx）
export interface ToolDef extends Omit<PluginTool, "run"> {
    run: (args: Record<string, unknown>) => Promise<string>;
}

interface Entry {
    def: ToolDef;
    // null = 内置；否则为插件 id（用于随插件卸载移除）
    plugin: string | null;
}

const table = new Map<string, Entry>();

export function registerBuiltinTools(defs: ToolDef[]) {
    for (const def of defs) {
        if (def.name.includes(".")) throw new Error(`内置工具名不允许带命名空间: ${def.name}`);
        table.set(def.name, { def, plugin: null });
    }
}

export function registerPluginTools(pluginId: string, defs: ToolDef[]) {
    for (const def of defs) {
        if (!def.name.startsWith(pluginId + ".")) {
            throw new Error(`插件工具必须以 "${pluginId}." 为前缀: ${def.name}`);
        }
        if (table.has(def.name)) throw new Error(`工具名冲突: ${def.name}`);
        table.set(def.name, { def, plugin: pluginId });
    }
}

export function unregisterPlugin(pluginId: string) {
    for (const [name, entry] of table) {
        if (entry.plugin === pluginId) table.delete(name);
    }
}

/** 模型拆分后的工具链。get_toolchain 本身不属于任何链。 */
export const TOOL_CHAINS = [
    "scene",
    "object",
    "mesh",
    "modifier",
    "material",
    "light",
    "camera",
    "view",
    "render",
    "files",
] as const;

export type ToolChain = (typeof TOOL_CHAINS)[number];

const CHAIN_SET = new Set<string>(TOOL_CHAINS);
const META_TOOL = "get_toolchain";
const PINNED = new Set([META_TOOL, "blender.scene_list_objects"]);

let activeChain: ToolChain | null = null;

export function resetToolChain() {
    activeChain = null;
}

export function getActiveChain(): ToolChain | null {
    return activeChain;
}

export function setToolChain(chain: string): chain is ToolChain {
    if (!CHAIN_SET.has(chain)) return false;
    activeChain = chain as ToolChain;
    console.log("[toolchain] 激活", activeChain);
    return true;
}

export function chainOf(name: string): ToolChain | null {
    if (name === META_TOOL) return null;
    if (!name.includes(".")) return "files";
    const rest = name.includes(".") ? name.slice(name.indexOf(".") + 1) : name;
    const head = rest.split("_")[0];
    if (CHAIN_SET.has(head)) return head as ToolChain;
    return null;
}

export function listChainCatalog(chain: ToolChain): { name: string; description: string }[] {
    return [...table.values()]
        .filter(({ def }) => chainOf(def.name) === chain)
        .map(({ def }) => ({ name: def.name, description: def.description }));
}

function isVisible(name: string): boolean {
    if (PINNED.has(name)) return true;
    if (!activeChain) return false;
    return chainOf(name) === activeChain;
}

// OpenAI function name 只允许 a-zA-Z0-9_-（服务端 400 硬校验），而插件工具名带 "." 前缀。
// 这里是 API 边界上的纯编码层：发 schema 时把 "." 改写为 "_"（blender.view_front →
// blender_view_front，保持函数名观感自然），执行 tool_call 时按映射表找回真名。
// 注册表内部与插件契约始终用真名，契约不变。
let apiNames = new Map<string, string>();

function toApiName(name: string): string {
    return name.replace(/\./g, "_");
}

/** 模型侧工具名 → 注册表真名（未映射的名字原样返回，如内置工具） */
export function realName(name: string): string {
    return apiNames.get(name) ?? name;
}

export function getOpenAITools(): OpenAI.ChatCompletionTool[] {
    apiNames = new Map();
    return [...table.values()].filter(({ def }) => isVisible(def.name)).map(({ def }) => {
        const name = toApiName(def.name);
        // 编码后撞名属于配置错误（如插件 id 含 "." 的场景），显式报出而不是静默错路由
        const prev = apiNames.get(name);
        if (prev && prev !== def.name) {
            throw new Error(`工具名编码冲突: ${prev} 与 ${def.name} 都映射为 ${name}`);
        }
        apiNames.set(name, def.name);
        return {
            type: "function",
            function: {
                name,
                description: def.description,
                parameters: def.parameters,
            },
        };
    });
}

// 手写 JSON-Schema 子集校验：required 缺漏 + properties 基本类型。
// 校验失败返回错误文案（喂回模型自愈），通过返回 null。
function validate(def: ToolDef, args: Record<string, unknown>): string | null {
    const { properties = {}, required = [] } = def.parameters;
    for (const key of required) {
        if (!(key in args)) return `缺少必需参数: ${key}`;
    }
    for (const [key, value] of Object.entries(args)) {
        const spec = properties[key];
        if (!spec?.type) continue;
        const ok =
            (spec.type === "string" && typeof value === "string") ||
            (spec.type === "number" && typeof value === "number") ||
            (spec.type === "boolean" && typeof value === "boolean") ||
            (spec.type === "array" && Array.isArray(value)) ||
            (spec.type === "object" && typeof value === "object" && value !== null && !Array.isArray(value));
        if (!ok) return `参数 ${key} 类型应为 ${spec.type}，实际为 ${JSON.stringify(value)}`;
    }
    return null;
}

// 派发执行：JSON 解析失败、schema 校验失败、run 抛错都返回错误文案（进 tool 消息回灌模型）
// name 是模型侧名字（插件工具的 "." 已被编码为 "__"），先映射回真名再查表
export async function execute(name: string, argsJson: string): Promise<string> {
    const entry = table.get(realName(name));
    if (!entry) return `未知工具: ${name}`;

    let args: Record<string, unknown>;
    try {
        args = argsJson.trim() ? JSON.parse(argsJson) : {};
    } catch {
        return `参数不是合法 JSON: ${argsJson}`;
    }
    const invalid = validate(entry.def, args);
    if (invalid) return `参数校验失败: ${invalid}`;

    try {
        return await entry.def.run(args);
    } catch (e) {
        return `工具执行失败: ${e instanceof Error ? e.message : String(e)}`;
    }
}
