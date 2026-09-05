// 内置 5 工具（read/write/edit/ls/grep，DoAgent 式极简文件面，无 shell）。
// 全部锚定"当前工作区"（workspace store）；未选工作区时返回提示文案而非报错。
// 边界：词法归一防逃逸（symlink 级加固是主项目后续设计）；
// 物理边界由 fs 插件 scope 兜底（set_workspace 只放行选过的目录）。
// 源头截断原则：read 限行、ls 限条、grep 限文件数与匹配数。
import { exists, readDir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { useWorkspaceStore } from "../stores/workspace";
import type { ToolDef } from "./registry";
import { TOOL_CHAINS, listChainCatalog, setToolChain, type ToolChain } from "./registry";

const READ_MAX_LINES = 400;
const LS_MAX_ENTRIES = 200;
const GREP_MAX_FILES = 500;
const GREP_MAX_MATCHES = 50;
const GREP_MAX_FILE_BYTES = 1024 * 1024;
const GREP_SKIP_DIRS = new Set([".git", "node_modules", "target", "dist", "__pycache__"]);

function workspaceRoot(): string | null {
    return useWorkspaceStore().path;
}

// 词法归一：root 与 rel 拼接后解析 . / ..，禁止逃逸 root。rel 必须是相对路径。
function resolveIn(root: string, rel: string): string {
    if (/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(rel)) {
        throw new Error("请使用工作区内的相对路径");
    }
    const rootDepth = root.split(/[\\/]+/).filter(Boolean).length;
    const segs = root.split(/[\\/]+/).filter(Boolean);
    for (const part of rel.split(/[\\/]+/)) {
        if (!part || part === ".") continue;
        if (part === "..") {
            if (segs.length <= rootDepth) throw new Error("路径越出工作区");
            segs.pop();
        } else {
            segs.push(part);
        }
    }
    const prefix = root.startsWith("/") ? "/" : "";
    // Windows 环境：统一用反斜杠拼回（盘符段如 "D:" 不含分隔符，天然保留）
    return prefix + segs.join("\\");
}

// 解析并校验 rel 落进工作区；未选工作区时返回 null（由调用方转成提示文案）
function mustResolve(rel: string | undefined): string | null {
    const root = workspaceRoot();
    if (!root) return null;
    return resolveIn(root, rel ?? ".");
}

const NO_WORKSPACE = "尚未选择工作区：请让用户先在对话面板底部选择工作区目录";

export const builtinTools: ToolDef[] = [
    {
        name: "get_toolchain",
        description:
            "获取一条工具链。新任务必须先调它。可选 scene/object/mesh/modifier/material/light/camera/view/render/files。改物体前先 scene。出三视图用 render。",
        parameters: {
            type: "object",
            properties: {
                chain: {
                    type: "string",
                    description: "要激活的工具链",
                    enum: [...TOOL_CHAINS],
                },
            },
            required: ["chain"],
            additionalProperties: false,
        },
        async run(args) {
            const chain = String(args.chain ?? "");
            if (!setToolChain(chain)) {
                return JSON.stringify({
                    ok: false,
                    error: `未知工具链: ${chain}`,
                    available: [...TOOL_CHAINS],
                });
            }
            return JSON.stringify({
                ok: true,
                chain,
                pinned: ["get_toolchain", "blender.scene_list_objects"],
                tools: listChainCatalog(chain as ToolChain),
            });
        },
    },
    {
        name: "read",
        description: "读工作区内文件（限前 400 行）",
        parameters: {
            type: "object",
            properties: { path: { type: "string", description: "工作区内相对路径" } },
            required: ["path"],
            additionalProperties: false,
        },
        async run(args) {
            const path = mustResolve(args.path as string);
            if (!path) return NO_WORKSPACE;
            if (!(await exists(path))) return `文件不存在: ${args.path}`;
            const text = await readTextFile(path);
            const lines = text.split("\n");
            if (lines.length <= READ_MAX_LINES) return text;
            return lines.slice(0, READ_MAX_LINES).join("\n") + `\n…（截断：共 ${lines.length} 行，只显示前 ${READ_MAX_LINES} 行）`;
        },
    },
    {
        name: "write",
        description: "整文件写入工作区内路径（覆盖或新建）",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "工作区内相对路径" },
                content: { type: "string", description: "完整文件内容" },
            },
            required: ["path", "content"],
            additionalProperties: false,
        },
        async run(args) {
            const path = mustResolve(args.path as string);
            if (!path) return NO_WORKSPACE;
            await writeTextFile(path, args.content as string);
            return "已写入";
        },
    },
    {
        name: "edit",
        description: "精确替换：把文件中唯一匹配的 old_string 替换为 new_string",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "工作区内相对路径" },
                old_string: { type: "string", description: "被替换的原文，必须在文件中唯一出现" },
                new_string: { type: "string", description: "替换后的内容" },
            },
            required: ["path", "old_string", "new_string"],
            additionalProperties: false,
        },
        async run(args) {
            const path = mustResolve(args.path as string);
            if (!path) return NO_WORKSPACE;
            if (!(await exists(path))) return `文件不存在: ${args.path}`;
            const text = await readTextFile(path);
            const oldStr = args.old_string as string;
            const first = text.indexOf(oldStr);
            if (first === -1) return "未找到匹配：old_string 在文件中不存在";
            if (text.indexOf(oldStr, first + 1) !== -1) return "匹配不唯一：old_string 出现多处，请提供更长的唯一片段";
            await writeTextFile(path, text.slice(0, first) + (args.new_string as string) + text.slice(first + oldStr.length));
            return "已替换";
        },
    },
    {
        name: "ls",
        description: "列工作区内目录（目录名带 / 后缀，限 200 条）",
        parameters: {
            type: "object",
            properties: { path: { type: "string", description: "工作区内相对路径，省略为根" } },
            additionalProperties: false,
        },
        async run(args) {
            const path = mustResolve(args.path as string | undefined);
            if (!path) return NO_WORKSPACE;
            if (!(await exists(path))) return `目录不存在: ${args.path ?? "."}`;
            const entries = await readDir(path);
            const lines = entries.map((e) => (e.isDirectory ? e.name + "/" : e.name));
            if (lines.length <= LS_MAX_ENTRIES) return lines.join("\n") || "（空目录）";
            return lines.slice(0, LS_MAX_ENTRIES).join("\n") + `\n…（截断：共 ${lines.length} 条）`;
        },
    },
    {
        name: "grep",
        description: "在工作区内按正则搜索文件内容（跳过 .git/node_modules 等，限 50 条匹配）",
        parameters: {
            type: "object",
            properties: {
                pattern: { type: "string", description: "正则表达式" },
                path: { type: "string", description: "起始目录（工作区内相对路径），省略为根" },
            },
            required: ["pattern"],
            additionalProperties: false,
        },
        async run(args) {
            const start = mustResolve(args.path as string | undefined);
            if (!start) return NO_WORKSPACE;
            let re: RegExp;
            try {
                re = new RegExp(args.pattern as string);
            } catch {
                return `无效正则: ${args.pattern}`;
            }
            const root = workspaceRoot()!;
            const matches: string[] = [];
            let scanned = 0;
            // 递归遍历：先文件后子目录；超限即停（结果里注明截断）
            async function walk(dir: string): Promise<boolean> {
                if (matches.length >= GREP_MAX_MATCHES || scanned >= GREP_MAX_FILES) return false;
                for (const entry of await readDir(dir)) {
                    const full = dir + "\\" + entry.name;
                    if (entry.isDirectory) {
                        if (GREP_SKIP_DIRS.has(entry.name)) continue;
                        if (!(await walk(full))) return false;
                    } else {
                        if (++scanned > GREP_MAX_FILES) return false;
                        let text: string;
                        try {
                            text = await readTextFile(full);
                        } catch {
                            continue; // 二进制/编码读不了的文件直接跳过
                        }
                        if (text.length > GREP_MAX_FILE_BYTES) continue;
                        const rel = full.slice(root.length + 1);
                        text.split("\n").forEach((line, i) => {
                            if (matches.length < GREP_MAX_MATCHES && re.test(line)) {
                                matches.push(`${rel}:${i + 1}: ${line.trim()}`);
                            }
                        });
                    }
                }
                return true;
            }
            const completed = await walk(start);
            const note = completed ? "" : "\n…（达到遍历或匹配上限，结果可能不全）";
            return (matches.join("\n") || "无匹配") + note;
        },
    },
];
