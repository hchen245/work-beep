<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import MarkdownRender, { enableKatex } from "markstream-vue";
import "markstream-vue/index.css";
import "katex/dist/katex.min.css";

// KaTeX 是 markstream 的可选 peer，装上后需显式启用
enableKatex();
import SpaceButton from "../components/base/SpaceButton.vue";
import CollapseBox from "../components/base/CollapseBox.vue";
import BaseSelect from "../components/base/BaseSelect.vue";
import { send, stop } from "../agent/loop";
import { useChatStore } from "../stores/chat";
import type { ChatMessage } from "../stores/chat";
import { useWorkspaceStore } from "../stores/workspace";

const chat = useChatStore();
const { messages, input, sending, thinking } = storeToRefs(chat);
const ws = useWorkspaceStore();

// 思考开关：llama.cpp / vLLM 经 chat_template_kwargs.enable_thinking 透传。
// OpenAI 官方不认该字段。gpt-5 / gpt-6 在 chat completions 里带函数工具时
// 必须 reasoning_effort=none，否则 400，此时开关不改变请求。
const THINKING_OPTIONS = [
    { label: "思考·开", value: "on" },
    { label: "思考·关", value: "off" },
];

const listRef = ref<HTMLElement | null>(null);

function scrollToBottom() {
    nextTick(() => listRef.value?.scrollTo({ top: listRef.value?.scrollHeight }));
}

// 流式追加在 store 里发生（agent 循环），这里监听消息变化跟随滚动
watch(
    () => [
        messages.value.length,
        messages.value[messages.value.length - 1]?.content,
        messages.value[messages.value.length - 1]?.think,
    ],
    scrollToBottom,
);

// 渲染/原文切换：进入原文模式前记录当前渲染高度，切换后高度不动、内容超出可滚动
function toggleRaw(msg: ChatMessage, e: MouseEvent) {
    if (!msg.showRaw) {
        const content = (e.currentTarget as HTMLElement)
            .closest(".message")
            ?.querySelector(".content");
        if (content) msg.rawHeight = content.clientHeight;
    }
    msg.showRaw = !msg.showRaw;
}

// 小模型常把回答包进 ```markdown 围栏（想"展示"markdown），
// 渲染器会忠实地把它当成代码块。两种形态都剥：
// 1) 整篇就是一个围栏；2) 前言/结尾 + 全篇唯一的 markdown 围栏（剥围栏、保留外部文字）
function unwrapMarkdownFence(text: string): string {
    const whole = text.match(/^\s*```(?:markdown|md)\s*\n([\s\S]*?)\n?\s*```\s*$/);
    if (whole) return whole[1];
    const fenced = text.match(/^([\s\S]*?)```(?:markdown|md)\s*\n([\s\S]*?)\n?```([\s\S]*)$/);
    // 围栏外还有其他代码围栏时不剥，避免误伤"用代码块展示模板"的正常用法
    if (fenced && !/```/.test(fenced[1] + fenced[3])) {
        return fenced[1] + fenced[2] + fenced[3];
    }
    return text;
}

// 兼容小模型的"残缺 markdown"：CommonMark 要求 # 后必须有空格，
// 中文小模型常输出 "#标题"（无空格），会被当成普通段落。
// 在代码块外给行首 # 补空格（代码块内不动，避免改坏代码）。
// 注意负向断言必须排除 # 本身：否则 "## 标题" 会回溯成 "# # 标题"（标题降级且残留 #）
function normalizeHeadings(text: string): string {
    let inFence = false;
    return text
        .split("\n")
        .map((line) => {
            if (/^\s*```/.test(line)) inFence = !inFence;
            return inFence ? line : line.replace(/^(#{1,6})(?![\s#])/, "$1 ");
        })
        .join("\n");
}

// 渲染片段：正文或思考（思考/工具调用这类辅助内容都走 CollapseBox 收起展示）
interface Segment {
    type: "text" | "think";
    text: string;
}

// 把助手消息拆成 思考/正文 片段：msg.think 之外，正文里内联的
// <think>...</think> 标签也解析出来（流式未闭合时同样按思考处理）
function segments(msg: ChatMessage): Segment[] {
    const segs: Segment[] = [];
    if (msg.think?.trim()) segs.push({ type: "think", text: msg.think });

    const re = /<think>([\s\S]*?)(?:<\/think>|$)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(msg.content)) !== null) {
        if (m.index > last) segs.push({ type: "text", text: msg.content.slice(last, m.index) });
        segs.push({ type: "think", text: m[1] });
        last = m.index + m[0].length;
    }
    if (last < msg.content.length) segs.push({ type: "text", text: msg.content.slice(last) });

    return segs.filter((s) => s.text.trim().length > 0);
}

// 工作区按钮文案：显示所选目录名，未选则提示
const wsLabel = computed(() => {
    if (!ws.path) return "选择工作区";
    return ws.path.split(/[\\/]/).filter(Boolean).pop() ?? ws.path;
});
</script>

<template>
    <div class="chat">
        <div class="message-list" ref="listRef">
            <div
                v-for="(msg, i) in messages"
                :key="i"
                class="message"
                :class="msg.role"
            >
                <!-- 助手消息：正文 markdown 流式渲染，思考内容收进可折叠盒子（流式期间展开，结束自动收起） -->
                <template v-if="msg.role === 'assistant'">
                    <div
                        v-if="msg.showRaw"
                        class="raw"
                        :style="msg.rawHeight ? { height: msg.rawHeight + 'px' } : {}"
                    >{{ msg.content }}</div>
                    <div v-else class="content">
                        <template v-for="(seg, j) in segments(msg)" :key="j">
                            <CollapseBox
                                v-if="seg.type === 'think'"
                                title="思考过程"
                                :open="sending && i === messages.length - 1"
                            >
                                {{ seg.text }}
                            </CollapseBox>
                            <!-- chat 模式：稳定节奏不闪；仅正在流式的那条是非 final。
                                 shiki 渲染器：代码块带语言标题栏（pre 渲染器没有） -->
                            <MarkdownRender
                                v-else
                                mode="chat"
                                code-renderer="shiki"
                                :content="normalizeHeadings(unwrapMarkdownFence(seg.text))"
                                :final="!(sending && i === messages.length - 1)"
                                :fade="false"
                            />
                        </template>
                    </div>
                    <!-- 渲染/原文切换：固定在消息末尾 -->
                    <div class="msg-footer">
                        <button
                            class="raw-toggle"
                            :title="msg.showRaw ? '查看渲染' : '查看原文'"
                            @click="toggleRaw(msg, $event)"
                        >
                            &lt;/&gt;
                        </button>
                    </div>
                </template>
                <!-- 工具调用记录：可折叠盒子 -->
                <CollapseBox v-else-if="msg.role === 'tool'" title="工具调用">
                    {{ msg.content }}
                </CollapseBox>
                <template v-else>{{ msg.content }}</template>
            </div>
        </div>
        <div class="input-bar">
            <div class="input-box">
                <textarea
                    v-model="input"
                    class="input"
                    placeholder="输入消息..."
                    rows="3"
                    @keydown.enter.exact.prevent="send"
                />
                <div class="actions">
                    <!-- 左侧：思考开关 + 工作区选择；右侧：▲ 发送 / ■ 停止 -->
                    <div class="actions-left">
                        <BaseSelect v-model="thinking" :options="THINKING_OPTIONS" />
                        <button
                            class="ws-btn"
                            :class="{ unset: !ws.path }"
                            :title="ws.path ?? '选择工作区目录（内置文件工具锚定于此）'"
                            @click="ws.choose()"
                        >{{ wsLabel }}</button>
                    </div>
                    <SpaceButton
                        size="small"
                        :title="sending ? '停止' : '发送'"
                        @click="sending ? stop() : send()"
                    >
                        {{ sending ? "■" : "▲" }}
                    </SpaceButton>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.chat {
    display: grid;
    grid-template-rows: 1fr auto;
    height: 100%;
    min-height: 0;
}

.message-list {
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.message {
    max-width: 80%;
    padding: 8px 12px;
    border-radius: 4px;
    color: var(--color-inverse);
    white-space: pre-wrap;
    word-break: break-word;
}

.message.user {
    align-self: flex-end;
    background: var(--color-secondary-1);
    /* 左下角硬阴影，与按钮的层叠风格一致 */
    box-shadow: -3px 3px 0 var(--color-secondary-2);
}

/* 助手消息：无边框无底色，气泡整体占满整行，文字左对齐 */
.message.assistant {
    align-self: stretch;
    max-width: none;
    text-align: left;
    /* markdown 渲染的块级布局不需要 pre-wrap（还会影响代码块） */
    white-space: normal;
}

/* 工具调用记录同样占满整行 */
.message.tool {
    align-self: stretch;
    max-width: none;
    padding: 0;
    white-space: normal;
}

/* 消息末尾的操作栏：渲染/原文切换按钮 */
.msg-footer {
    display: flex;
    justify-content: flex-end;
}

.raw-toggle {
    border: none;
    background: transparent;
    color: var(--color-secondary-2);
    font-size: 1rem;
    padding: 2px 8px;
    cursor: pointer;
}

/* 原文视图：等宽字体 + 保留换行；高度沿用渲染时的高度（超出滚动），带边框 */
.raw {
    white-space: pre-wrap;
    word-break: break-word;
    font-family: monospace;
    font-size: 0.875rem;
    overflow-y: auto;
    border: 1px solid var(--color-secondary-2);
    border-radius: 4px;
    padding: 8px;
}

/* markdown 渲染字号调小（markstream 默认偏大），穿透 scoped 作用到渲染器容器 */
.message.assistant :deep(.markstream-vue) {
    font-size: 0.875rem;
}

/* 行内代码：微暗底色小圆角；块级代码的边框/底色由 shiki 富代码块外壳负责，不重复叠加 */
.message.assistant :deep(code) {
    background: color-mix(in srgb, var(--color-primary), var(--color-inverse) 6%);
    border-radius: 3px;
    padding: 0 4px;
}

.message.assistant :deep(pre code) {
    background: none;
    padding: 0;
}

.input-bar {
    padding: 12px;
}

/* 输入框整体是一个视觉盒子：textarea 无边框，发送按钮收在盒子右下角 */
.input-box {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px 12px;
    border: 1px solid var(--color-neutral);
    border-radius: 4px;
    background: var(--color-primary);
}

.input {
    resize: none;
    border: none;
    outline: none;
    padding: 0;
    background: transparent;
    color: var(--color-inverse);
    font: inherit;
}

.actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
}

.actions-left {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
}

/* 工作区选择按钮：低调文字按钮，未选择时弱化提示 */
.ws-btn {
    border: none;
    background: transparent;
    color: var(--color-text);
    font-size: 0.75rem;
    padding: 2px 6px;
    cursor: pointer;
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ws-btn.unset {
    opacity: 0.5;
}

.ws-btn:hover {
    color: var(--color-inverse);
}
</style>
