// 插件状态：发现的插件列表、激活/停用生命周期、PluginContext 的构造与传导。
// 单活跃模型：同时只允许一个活跃插件 View（设计理念：收窄模型的世界——
// 只有活跃插件的工具注入模型视野）。激活 = 注册工具 + start()；停用 = stop() + 移除工具。
import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { PluginContext, Rect } from "@beep/sdk";
import { discoverPlugins } from "../plugins/loader";
import type { LoadedPlugin } from "../plugins/loader";
import { registerPluginTools, unregisterPlugin } from "../tools/registry";

// 元素的物理像素矩形（无边框窗口，webview 原点即窗口客户区原点）
function rectOf(el: HTMLElement): Rect | null {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const scale = window.devicePixelRatio;
    return {
        x: Math.round(rect.left * scale),
        y: Math.round(rect.top * scale),
        w: Math.round(rect.width * scale),
        h: Math.round(rect.height * scale),
    };
}

// 为某个插件构造 ctx：SDK 契约的 Host 侧实现，全部落到通用 Tauri command
function makeCtx(p: LoadedPlugin): PluginContext {
    return {
        launch: (executable, args) => invoke("proc_start", { executable, args }),
        kill: (pid) => invoke("proc_kill", { pid }),
        embed: (pid, rect) => invoke("proc_embed", { pid, ...rect }),
        syncRect: (pid, rect) => invoke("proc_move", { pid, ...rect }),
        call: (port, cmd, params) => invoke("bridge_call", { port, cmd, params }),
        resolveAsset: (rel) => `${p.dir}\\assets\\${rel.replace(/\//g, "\\")}`,
        exists: (path) => invoke<boolean>("file_exists", { path }),
        async download(url, dest, onProgress) {
            const unlisten = await listen<{ dest: string; done: number; total: number }>(
                "http-download-progress",
                (ev) => {
                    if (ev.payload.dest === dest) {
                        onProgress?.(ev.payload.done, ev.payload.total);
                    }
                },
            );
            try {
                await invoke("http_download", { url, dest });
            } finally {
                unlisten();
            }
        },
        extractZip: (zipPath, destDir) => invoke("zip_extract", { zipPath, destDir }),
        removePath: (path) => invoke("remove_path", { path }),
        rectOf,
        watchRect(el, cb) {
            const emit = () => {
                const r = rectOf(el);
                if (r) cb(r);
            };
            const observer = new ResizeObserver(emit);
            observer.observe(el);
            // 拖动本应用窗口时面板在屏幕上的位置变化（视口坐标不变），嵌入窗口也要跟随
            let unlisten: (() => void) | null = null;
            listen("tauri://move", emit).then((u) => (unlisten = u));
            return () => {
                observer.disconnect();
                unlisten?.();
            };
        },
    };
}

export const usePluginsStore = defineStore("plugins", () => {
    const plugins = ref<LoadedPlugin[]>([]);
    // 空字符串 = 未激活任何插件
    const activeId = ref("");
    // 激活/停用期的错误（加载期错误在 loader 里 console + 跳过）
    const lastError = ref("");

    const ctxMap = new Map<string, PluginContext>();
    function ctxOf(p: LoadedPlugin): PluginContext {
        let ctx = ctxMap.get(p.manifest.id);
        if (!ctx) {
            ctx = makeCtx(p);
            ctxMap.set(p.manifest.id, ctx);
        }
        return ctx;
    }

    async function discover() {
        plugins.value = await discoverPlugins();
    }

    const activePlugin = computed(
        () => plugins.value.find((p) => p.manifest.id === activeId.value) ?? null,
    );

    async function activate(id: string) {
        if (id === activeId.value) return;
        lastError.value = "";
        const cur = activePlugin.value;
        if (cur) {
            try {
                await cur.def.stop?.(ctxOf(cur));
            } catch (e) {
                console.error(`插件 ${cur.manifest.id} stop 失败:`, e);
            }
            unregisterPlugin(cur.manifest.id);
        }
        activeId.value = id;
        const next = activePlugin.value;
        if (next) {
            const ctx = ctxOf(next);
            // 工具注入：run(args, ctx) 绑定本插件的 ctx 后入注册表（命名空间前缀在注册表强制校验）
            registerPluginTools(
                next.manifest.id,
                (next.def.tools ?? []).map((t) => ({
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters,
                    run: (args) => t.run(args, ctx),
                })),
            );
            try {
                await next.def.start?.(ctx);
            } catch (e) {
                lastError.value = `插件启动失败：${e instanceof Error ? e.message : String(e)}`;
            }
        }
    }

    function mustActiveCtx(): PluginContext {
        const p = activePlugin.value;
        if (!p) throw new Error("当前没有激活的插件");
        return ctxOf(p);
    }

    // provide 给插件 View 的稳定代理：方法派发到"当前活跃插件"的 ctx。
    // 单活跃模型下 View 只在自己活跃时挂载，代理永远指向它的宿主插件。
    const activeCtx: PluginContext = {
        launch: (...a) => mustActiveCtx().launch(...a),
        kill: (...a) => mustActiveCtx().kill(...a),
        embed: (...a) => mustActiveCtx().embed(...a),
        syncRect: (...a) => mustActiveCtx().syncRect(...a),
        call: (...a) => mustActiveCtx().call(...a),
        resolveAsset: (...a) => mustActiveCtx().resolveAsset(...a),
        exists: (...a) => mustActiveCtx().exists(...a),
        download: (...a) => mustActiveCtx().download(...a),
        extractZip: (...a) => mustActiveCtx().extractZip(...a),
        removePath: (...a) => mustActiveCtx().removePath(...a),
        rectOf: (...a) => mustActiveCtx().rectOf(...a),
        watchRect: (...a) => mustActiveCtx().watchRect(...a),
    };

    return { plugins, activeId, activePlugin, lastError, activeCtx, discover, activate };
});
