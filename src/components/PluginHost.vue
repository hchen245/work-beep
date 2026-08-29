<script setup lang="ts">
// 右栏插件容器：插件切换下拉 + 活跃插件 View 挂载点。
// 通过 provide(CTX_KEY) 把当前活跃插件的 PluginContext 传导给插件 View（SDK 注入键）。
import { computed, onMounted, provide } from "vue";
import { CTX_KEY } from "@beep/sdk";
import BaseSelect from "./base/BaseSelect.vue";
import { usePluginsStore } from "../stores/plugins";

const store = usePluginsStore();
provide(CTX_KEY, store.activeCtx);
onMounted(async () => {
    await store.discover();
    // 扫到插件后自动激活第一个，避免停在默认的「无插件 / 未激活」空态
    if (!store.activeId && store.plugins.length) {
        await store.activate(store.plugins[0].manifest.id);
    }
});

const options = computed(() => [
    { label: "无插件", value: "" },
    ...store.plugins.map((p) => ({ label: p.manifest.name, value: p.manifest.id })),
]);
</script>

<template>
    <div class="plugin-host">
        <div class="bar">
            <BaseSelect
                :model-value="store.activeId"
                :options="options"
                @update:model-value="store.activate"
            />
            <span v-if="store.lastError" class="error">{{ store.lastError }}</span>
        </div>
        <div class="view-slot">
            <component
                v-if="store.activePlugin"
                :is="store.activePlugin.def.view"
                :key="store.activePlugin.manifest.id"
            />
            <div v-else class="empty">
                未激活插件{{ store.plugins.length ? "" : "（plugins/ 目录为空）" }}
            </div>
        </div>
    </div>
</template>

<style scoped>
.plugin-host {
    display: grid;
    grid-template-rows: auto 1fr;
    height: 100%;
    min-height: 0;
}

.bar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--color-border);
}

.error {
    font-size: 0.75rem;
    color: var(--color-secondary-2);
}

.view-slot {
    position: relative;
    min-height: 0;
}

.empty {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: var(--color-text);
    opacity: 0.5;
    font-size: 0.875rem;
}
</style>
