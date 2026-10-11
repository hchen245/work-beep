// Harness 语义/结构信号汇总的单元测试：LLM 回复全部是手写 mock，不发真实请求。
// 运行：pnpm test（node --test，Node 24 原生剥离 TS 类型）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    buildJudgePrompt,
    combineVerdict,
    parseHarnessJson,
    parseSemanticInspect,
    unavailableSnapshot,
    type HarnessVerdict,
    type SemanticObject,
    type SemanticSnapshot,
} from "../src/agent/semantic.ts";

const RED = [0.9, 0.15, 0.15, 1];
const BLUE = [0.15, 0.3, 0.9, 1];
const GREEN = [0.15, 0.8, 0.25, 1];

function mesh(name: string, group: string | null, color: number[] | null, extra: Partial<SemanticObject> = {}): SemanticObject {
    return {
        name,
        type: "MESH",
        semantic_group: group,
        material: group ? `Semantic_${group}` : null,
        color,
        parent: null,
        visible: true,
        ...extra,
    };
}

/** 模拟 scene.semantic_inspect 的桥返回（与插件字段一致） */
function inspectJson(objects: SemanticObject[], issues: unknown[] = []): string {
    const groups = new Map<string, { group: string; objects: string[]; materials: string[]; colors: number[][] }>();
    for (const o of objects) {
        if (!o.semantic_group) continue;
        const g = groups.get(o.semantic_group) ?? { group: o.semantic_group, objects: [], materials: [], colors: [] };
        g.objects.push(o.name);
        groups.set(o.semantic_group, g);
    }
    return JSON.stringify({
        annotated: groups.size > 0,
        object_count: objects.length,
        objects,
        groups: [...groups.values()],
        issues,
        validated: true,
    });
}

function chair(legs = ["Leg_FL", "Leg_FR", "Leg_BL", "Leg_BR"]): SemanticSnapshot {
    return parseSemanticInspect(
        inspectJson([
            mesh("Seat", "Seat", RED),
            mesh("Back", "Backrest", BLUE),
            ...legs.map((n) => mesh(n, "Legs", GREEN)),
        ]),
    );
}

const PASSING: HarnessVerdict = {
    pass: true,
    overall_score: 0.9,
    views: { front: { score: 0.9, issues: [] }, right: { score: 0.9, issues: [] }, top: { score: 0.9, issues: [] } },
    structural: { pass: true, score: 0.9, issues: [] },
    semantic: {
        pass: true,
        score: 0.9,
        issues: [],
        unverified: [],
        required_parts: [
            { part: "座面", semantic_group: "Seat", expected_count: 1, objects: ["Seat"] },
            { part: "靠背", semantic_group: "Backrest", expected_count: 1, objects: ["Back"] },
            { part: "椅腿", semantic_group: "Legs", expected_count: 4, objects: ["Leg_FL", "Leg_FR", "Leg_BL", "Leg_BR"] },
        ],
    },
    critical_issues: [],
    priority_fixes: [],
};

function verdict(patch: Partial<HarnessVerdict>): HarnessVerdict {
    return structuredClone({ ...PASSING, ...patch });
}

test("A/B/C 正常语义椅子：确定性复核通过，保持 LLM 的 pass", () => {
    const out = combineVerdict(verdict({}), chair());
    assert.equal(out.pass, true);
    assert.equal(out.semantic.status, "evaluated");
    assert.equal(out.semantic.pass, true);
    assert.equal(out.structural.pass, true);
    assert.deepEqual(out.harness.deterministic_issues, []);
    assert.equal(out.harness.overridden, false);
});

test("D 插件预检出同组颜色不一致：LLM 说 pass 也被推翻", () => {
    const snap = parseSemanticInspect(
        inspectJson(
            [mesh("Seat", "Seat", RED), mesh("Back", "Backrest", BLUE), mesh("Leg_FL", "Legs", GREEN), mesh("Leg_BR", "Legs", [0.95, 0.9, 0.1, 1])],
            [{ code: "group_color_inconsistent", severity: "critical", objects: ["Leg_FL", "Leg_BR"], message: "语义组 Legs 内颜色不一致" }],
        ),
    );
    const out = combineVerdict(verdict({ semantic: { pass: true } }), snap);
    assert.equal(out.pass, false);
    assert.equal(out.semantic.pass, false);
    assert.equal(out.harness.overridden, true);
    assert.ok(out.critical_issues.includes("语义组 Legs 内颜色不一致"));
    assert.ok(out.priority_fixes.some((f) => String(f).includes("material_assign_semantic")));
});

test("D 错误归组：椅腿被标成 Seat，复核发现标签与部件不符", () => {
    const snap = parseSemanticInspect(
        inspectJson([
            mesh("Seat", "Seat", RED),
            mesh("Back", "Backrest", BLUE),
            mesh("Leg_FL", "Legs", GREEN),
            mesh("Leg_FR", "Legs", GREEN),
            mesh("Leg_BL", "Legs", GREEN),
            mesh("Leg_BR", "Seat", RED),
        ]),
    );
    const out = combineVerdict(verdict({}), snap);
    assert.equal(out.pass, false);
    assert.ok(out.harness.deterministic_issues.some((m) => m.includes("Leg_BR=Seat")));
    assert.ok(out.priority_fixes.some((f) => String(f).includes("Leg_BR") && String(f).includes("Legs")));
});

test("E 缺一条腿：三条绿腿 + LLM pass=true 仍判失败", () => {
    const snap = chair(["Leg_FL", "Leg_FR", "Leg_BL"]);
    const v = verdict({});
    v.semantic!.required_parts![2].objects = ["Leg_FL", "Leg_FR", "Leg_BL"];
    const out = combineVerdict(v, snap);
    assert.equal(out.pass, false);
    assert.equal(out.semantic.pass, false);
    assert.ok(out.critical_issues.some((m) => String(m).includes("要求 4 个") && String(m).includes("只有 3 个")));
    assert.ok(out.priority_fixes.some((f) => String(f).includes("补建 1 个")));
});

test("E LLM 引用了场景中不存在的物体：不能靠自述凑数", () => {
    const snap = chair(["Leg_FL", "Leg_FR", "Leg_BL"]);
    const out = combineVerdict(verdict({}), snap);
    assert.equal(out.pass, false);
    assert.ok(out.harness.deterministic_issues.some((m) => m.includes("不存在") && m.includes("Leg_BR")));
});

test("E 部件被隐藏：不在三视图里，不算存在", () => {
    const snap = parseSemanticInspect(
        inspectJson([
            mesh("Seat", "Seat", RED),
            mesh("Back", "Backrest", BLUE, { visible: false }),
            ...["Leg_FL", "Leg_FR", "Leg_BL", "Leg_BR"].map((n) => mesh(n, "Legs", GREEN)),
        ]),
    );
    const out = combineVerdict(verdict({}), snap);
    assert.equal(out.pass, false);
    assert.ok(out.priority_fixes.some((f) => String(f).includes("scene_restore_visibility")));
});

test("F 语义全对但结构失败：总判定失败", () => {
    const out = combineVerdict(
        verdict({
            structural: { pass: false, score: 0.5, issues: ["靠背与座面没有连接"] },
            priority_fixes: ["把 Back 向下移动，使其底部与 Seat 顶面接触"],
        }),
        chair(),
    );
    assert.equal(out.semantic.pass, true);
    assert.equal(out.structural.pass, false);
    assert.equal(out.pass, false);
    assert.deepEqual(out.priority_fixes, ["把 Back 向下移动，使其底部与 Seat 顶面接触"]);
});

test("F LLM 顶层 pass=false 时，语义 pass=true 不能翻盘", () => {
    const out = combineVerdict(verdict({ pass: false, structural: { pass: false, issues: ["比例错误"] } }), chair());
    assert.equal(out.pass, false);
    assert.equal(out.harness.overridden, false);
});

test("critical_issues 非空时 LLM 的 pass=true 无效", () => {
    const out = combineVerdict(verdict({ critical_issues: ["缺少扶手"] }), chair());
    assert.equal(out.pass, false);
    assert.ok(out.priority_fixes.length > 0, "失败时 priority_fixes 不能为空");
});

test("H 旧格式验收 JSON（只有 views）+ 插件无语义命令：保持原有行为", () => {
    const legacy: HarnessVerdict = { pass: true, overall_score: 0.85, critical_issues: [], priority_fixes: [] };
    const snap = parseSemanticInspect("未知工具: blender.scene_semantic_inspect");
    const out = combineVerdict(legacy, snap);
    assert.equal(snap.available, false);
    assert.equal(out.pass, true);
    assert.equal(out.structural.pass, true);
    assert.equal(out.semantic.status, "unavailable");
    assert.equal(out.semantic.pass, null, "不可用的信号不能标成通过");

    const fail = combineVerdict({ pass: false, priority_fixes: ["加高靠背"] }, snap);
    assert.equal(fail.pass, false);
    assert.deepEqual(fail.priority_fixes, ["加高靠背"]);
});

test("H 场景没有语义标签：语义记为未评估（null），不阻断原有流程", () => {
    const snap = parseSemanticInspect(inspectJson([mesh("Cube", null, null)]));
    const out = combineVerdict({ pass: true, structural: { pass: true }, critical_issues: [], priority_fixes: [] }, snap);
    assert.equal(out.semantic.status, "unannotated");
    assert.equal(out.semantic.pass, null);
    assert.equal(out.pass, true);
    assert.ok(out.semantic.issues!.some((i) => String(i).includes("未评估")));
});

test("有标签但验收没给 semantic.pass：标为 unverified，不当作通过", () => {
    const out = combineVerdict({ pass: true, structural: { pass: true }, critical_issues: [], priority_fixes: [] }, chair());
    assert.equal(out.semantic.status, "unverified");
    assert.equal(out.semantic.pass, null);
});

test("parseSemanticInspect 处理工具失败文案", () => {
    assert.equal(parseSemanticInspect("工具执行失败: Blender 未启动或桥未就绪").available, false);
    assert.equal(parseSemanticInspect(JSON.stringify({ ok: true })).available, false);
    assert.equal(chair().available, true);
    assert.equal(chair().annotated, true);
});

test("parseHarnessJson 兼容代码块包裹", () => {
    const parsed = parseHarnessJson('```json\n{"pass": false, "priority_fixes": ["x"]}\n```');
    assert.equal(parsed?.pass, false);
    assert.equal(parseHarnessJson("not json"), null);
});

test("buildJudgePrompt 带上原始需求、场景语义数据和两路信号的 schema", () => {
    const prompt = buildJudgePrompt("做一把椅子", chair());
    assert.ok(prompt.includes("做一把椅子"));
    assert.ok(prompt.includes("Leg_FL | MESH | group=Legs"));
    assert.ok(prompt.includes("不是事实"));
    assert.ok(prompt.includes('"structural"') && prompt.includes('"semantic"') && prompt.includes('"required_parts"'));
    assert.ok(prompt.includes('"views"'), "保留旧 schema 的 views 字段");

    const unavailable = buildJudgePrompt("做一把椅子", unavailableSnapshot("未知工具"));
    assert.ok(unavailable.includes("语义数据不可用"));
});
