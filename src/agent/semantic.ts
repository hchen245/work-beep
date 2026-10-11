// Harness 的语义（Color → Logic）与结构（Views → Structure）信号汇总。
// 纯函数、无 Tauri / Vue 依赖：loop.ts 调用，tests/semantic.test.ts 直接用 node --test 测。
// 原则：语义标签是 Agent 自己打的，不是事实；LLM 的 pass 不能盖过场景数据上的确定性失败；
// 拿不到的信号标 null（未验证），不当作通过。

export interface SemanticObject {
    name: string;
    type: string;
    semantic_group: string | null;
    material: string | null;
    color: number[] | null;
    parent: string | null;
    visible: boolean;
    location?: number[];
    dimensions?: number[];
}

export interface SemanticIssue {
    code: string;
    severity: "critical" | "warning";
    message: string;
    objects?: string[];
}

export interface SemanticGroup {
    group: string;
    objects: string[];
    materials: string[];
    colors: number[][];
}

/** scene.semantic_inspect 的结果；available=false 表示语义信号不可用（插件旧版、Blender 未启动等） */
export interface SemanticSnapshot {
    available: boolean;
    annotated: boolean;
    objects: SemanticObject[];
    groups: SemanticGroup[];
    issues: SemanticIssue[];
    error?: string;
}

export interface RequiredPart {
    part?: string;
    semantic_group?: string;
    expected_count?: number;
    objects?: string[];
}

export interface SignalResult {
    pass?: boolean | null;
    score?: number;
    issues?: unknown[];
    unverified?: unknown[];
    required_parts?: RequiredPart[];
}

export interface HarnessVerdict {
    pass?: boolean;
    overall_score?: unknown;
    views?: unknown;
    structural?: SignalResult;
    semantic?: SignalResult;
    critical_issues?: unknown[];
    priority_fixes?: unknown;
}

export type SemanticStatus = "evaluated" | "unverified" | "unannotated" | "unavailable";

export interface CombinedVerdict extends HarnessVerdict {
    pass: boolean;
    structural: SignalResult & { pass: boolean | null };
    semantic: SignalResult & { pass: boolean | null; status: SemanticStatus };
    critical_issues: unknown[];
    priority_fixes: unknown[];
    harness: {
        llm_pass: boolean | undefined;
        overridden: boolean;
        deterministic_issues: string[];
    };
}

export const SEMANTIC_INSPECT_TOOL = "blender.scene_semantic_inspect";
const MAX_PROMPT_OBJECTS = 60;

export function parseHarnessJson(text: string): HarnessVerdict | null {
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

export function unavailableSnapshot(error: string): SemanticSnapshot {
    return { available: false, annotated: false, objects: [], groups: [], issues: [], error };
}

/** 解析 registry.execute 的返回：成功是桥 JSON，失败是“工具执行失败: …”“未知工具: …”等文案 */
export function parseSemanticInspect(result: string): SemanticSnapshot {
    let data: Partial<SemanticSnapshot> & { ok?: boolean };
    try {
        data = JSON.parse(result);
    } catch {
        return unavailableSnapshot(result.slice(0, 200));
    }
    if (!data || !Array.isArray(data.objects)) {
        return unavailableSnapshot("semantic_inspect 返回缺少 objects");
    }
    return {
        available: true,
        annotated: data.annotated === true,
        objects: data.objects,
        groups: Array.isArray(data.groups) ? data.groups : [],
        issues: Array.isArray(data.issues) ? data.issues : [],
    };
}

function fmtVec(v: number[] | null | undefined): string {
    return v ? `[${v.map((x) => Number(x.toFixed(2))).join(", ")}]` : "-";
}

function semanticDataBlock(snap: SemanticSnapshot | null): string {
    if (!snap || !snap.available) {
        return `（语义数据不可用：${snap?.error ?? "未采集"}。semantic.pass 填 null，并在 semantic.issues 说明）`;
    }
    const shown = snap.objects.slice(0, MAX_PROMPT_OBJECTS);
    const lines = shown.map(
        (o) =>
            `- ${o.name} | ${o.type} | group=${o.semantic_group ?? "-"} | material=${o.material ?? "-"} | ` +
            `color=${fmtVec(o.color)} | parent=${o.parent ?? "-"} | visible=${o.visible} | ` +
            `location=${fmtVec(o.location)} | dimensions=${fmtVec(o.dimensions)}`,
    );
    if (snap.objects.length > shown.length) lines.push(`…（另有 ${snap.objects.length - shown.length} 个物体未列出）`);
    const head = snap.annotated
        ? "场景物体（来自 Blender 当前场景，group 与颜色是 Agent 自己标的）："
        : "场景物体（来自 Blender 当前场景；没有任何语义标签）：";
    const issues = snap.issues.length
        ? snap.issues.map((i) => `- [${i.severity}] ${i.message}`).join("\n")
        : "- 无";
    return `${head}\n${lines.join("\n")}\n\n确定性预检问题：\n${issues}`;
}

/** JUDGE_ONLY 验收提示：一次请求同时给出结构与语义两路信号 */
export function buildJudgePrompt(originalUserRequest: string, snap: SemanticSnapshot | null): string {
    const semanticNote =
        snap?.available && !snap.annotated
            ? "当前场景没有语义标签：semantic.pass 填 null，required_parts 仍按场景物体填写。"
            : "";
    return `你现在是 Blender 建模结果的验收器，需要给出两路相互独立的信号。

用户最初的建模要求是：
"${originalUserRequest}"

A. structural（三视图 → 结构）
只根据刚刚生成的 front、right、top 三张正交渲染图中真实可见的内容，判断形状、位置、连接、比例、空间关系是否满足要求。
不要根据文件名、对象名或工具参数猜测结构。

B. semantic（颜色 → 逻辑）
结合下方场景数据和图中颜色，判断部件身份（需要的部件是否都在、能否辨认）、语义分组（同功能部件是否同组同色、无关部件是否被错误归为一组）、逻辑关系（分组是否符合这个物体的功能构成、标签与场景是否矛盾）。

必须遵守：
- 语义标签和颜色是 Agent 自己打的，不是事实。同色只说明 Agent 认为它们同组，不能证明数量、位置或连接正确。
- 语义正确不能弥补结构错误；结构问题写进 structural.issues，并让 structural.pass=false。
- 无法从图片或场景数据可靠确认的要求写进 semantic.unverified，不要当作通过。
- required_parts 列出用户要求所需的每类部件：part、对应 semantic_group（没有标签就省略）、expected_count（要求里能确定数量才写）、objects（只能用下方列表中的物体名）。Harness 会用场景数据复核数量和标签。
- priority_fixes 每条写明受影响的物体名和具体改法。
${semanticNote}
${semanticDataBlock(snap)}

请严格返回以下 JSON，不要输出 Markdown，不要补充其它文字：

{
  "pass": true,
  "overall_score": 0.0,
  "views": {
    "front": {"score": 0.0, "issues": []},
    "right": {"score": 0.0, "issues": []},
    "top": {"score": 0.0, "issues": []}
  },
  "structural": {"pass": true, "score": 0.0, "issues": []},
  "semantic": {
    "pass": true,
    "score": 0.0,
    "issues": [],
    "unverified": [],
    "required_parts": [{"part": "", "semantic_group": "", "expected_count": 1, "objects": []}]
  },
  "critical_issues": [],
  "priority_fixes": []
}

评分范围是 0 到 1。

pass=true 的条件：
- overall_score >= 0.80
- 每个视图 score >= 0.70
- structural.pass 为 true
- semantic.pass 不为 false
- critical_issues 为空

如果模型明显缺少用户要求的主要结构，pass 必须为 false。
`;
}

function asList(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function pushUnique(list: unknown[], item: unknown) {
    const key = JSON.stringify(item);
    if (!list.some((x) => JSON.stringify(x) === key)) list.push(item);
}

/** 用场景数据复核 LLM 的 required_parts，并收集插件预检里的 critical 问题 */
function deterministicChecks(raw: HarnessVerdict, snap: SemanticSnapshot) {
    const issues: string[] = [];
    const fixes: string[] = [];
    const byName = new Map(snap.objects.map((o) => [o.name, o]));

    for (const issue of snap.issues) {
        if (issue.severity !== "critical") continue;
        issues.push(issue.message);
        const objs = issue.objects?.join(", ") ?? "";
        if (issue.code === "group_color_inconsistent" || issue.code === "groups_share_color" || issue.code === "label_missing_material") {
            fixes.push(`语义颜色问题（${objs}）：${issue.message}。用 blender.material_assign_semantic 重新为相关组上色，同组同色、不同组颜色明显不同`);
        } else {
            fixes.push(`${issue.message}（${objs}）`);
        }
    }

    for (const part of raw.semantic?.required_parts ?? []) {
        const label = part.part || part.semantic_group || "未命名部件";
        const named = Array.isArray(part.objects) ? [...new Set(part.objects.map(String))] : [];
        const ghosts = named.filter((n) => !byName.has(n));
        const hidden = named.filter((n) => byName.get(n)?.visible === false);
        const present = named.filter((n) => byName.get(n)?.visible === true);

        if (ghosts.length) {
            issues.push(`验收引用了场景中不存在的物体（${label}）：${ghosts.join(", ")}`);
            fixes.push(`${label}：场景里没有 ${ghosts.join(", ")}，需要实际创建这些部件或修正名称`);
        }
        if (hidden.length) {
            issues.push(`${label} 的物体处于隐藏状态，三视图中不可见：${hidden.join(", ")}`);
            fixes.push(`${label}：调用 blender.scene_restore_visibility 恢复 ${hidden.join(", ")} 的可见性后重新渲染`);
        }
        const expected = part.expected_count;
        if (typeof expected === "number" && Number.isInteger(expected) && expected > 0 && present.length < expected) {
            issues.push(`缺少部件 ${label}：要求 ${expected} 个，场景中可见的只有 ${present.length} 个（${present.join(", ") || "无"}）`);
            fixes.push(`${label}：补建 ${expected - present.length} 个并放到正确位置，再归入语义组 ${part.semantic_group ?? label}`);
        }
        if (snap.annotated && part.semantic_group) {
            const mislabeled = present.filter((n) => byName.get(n)?.semantic_group !== part.semantic_group);
            if (mislabeled.length) {
                const detail = mislabeled.map((n) => `${n}=${byName.get(n)?.semantic_group ?? "无标签"}`).join(", ");
                issues.push(`${label} 的语义标签与部件不符：应为 ${part.semantic_group}，实际 ${detail}`);
                fixes.push(`用 blender.material_assign_semantic 把 ${mislabeled.join(", ")} 归入语义组 ${part.semantic_group}`);
            }
        }
    }
    return { issues, fixes };
}

/**
 * 汇总 LLM 判定与确定性检查，产出唯一的总判定。
 * 任一必需维度失败、critical_issues 非空、或确定性检查失败，都不能 pass。
 */
export function combineVerdict(raw: HarnessVerdict, snap: SemanticSnapshot | null): CombinedVerdict {
    const llmPass = raw.pass;
    const rawStructural = raw.structural ?? {};
    // 旧格式没有 structural：沿用顶层 pass（兼容只有 views 的旧验收 JSON）
    const structuralPass =
        typeof rawStructural.pass === "boolean" ? rawStructural.pass : typeof llmPass === "boolean" ? llmPass : null;
    const structural = { ...rawStructural, pass: structuralPass };

    const det = snap?.available ? deterministicChecks(raw, snap) : { issues: [], fixes: [] };

    const rawSemantic = raw.semantic ?? {};
    let status: SemanticStatus;
    let semanticPass: boolean | null;
    if (!snap || !snap.available) {
        status = "unavailable";
        semanticPass = null;
    } else if (!snap.annotated) {
        status = "unannotated";
        semanticPass = det.issues.length ? false : null;
    } else if (typeof rawSemantic.pass === "boolean") {
        status = "evaluated";
        semanticPass = det.issues.length ? false : rawSemantic.pass;
    } else {
        status = "unverified";
        semanticPass = det.issues.length ? false : null;
    }
    const semanticIssues = [...asList(rawSemantic.issues)];
    if (status === "unavailable") pushUnique(semanticIssues, `语义信号不可用：${snap?.error ?? "未采集"}`);
    if (status === "unannotated") pushUnique(semanticIssues, "场景没有语义标签，颜色 → 逻辑 未评估");
    if (status === "unverified") pushUnique(semanticIssues, "验收结果未给出 semantic.pass，语义信号未验证");
    for (const msg of det.issues) pushUnique(semanticIssues, msg);
    const semantic = { ...rawSemantic, pass: semanticPass, status, issues: semanticIssues };

    const critical = [...asList(raw.critical_issues)];
    for (const msg of det.issues) pushUnique(critical, msg);

    const fixes: unknown[] = [];
    for (const f of det.fixes) pushUnique(fixes, f);
    for (const f of asList(raw.priority_fixes)) pushUnique(fixes, f);

    const pass =
        llmPass === true &&
        structuralPass !== false &&
        semanticPass !== false &&
        critical.length === 0;

    // 判定失败却没有任何修复建议时，用问题清单兜底，FIX 轮不至于拿到空列表
    if (!pass && fixes.length === 0) {
        for (const item of [...critical, ...asList(structural.issues), ...semanticIssues]) pushUnique(fixes, item);
    }

    return {
        ...raw,
        pass,
        structural,
        semantic,
        critical_issues: critical,
        priority_fixes: fixes,
        harness: {
            llm_pass: llmPass,
            overridden: llmPass === true && !pass,
            deterministic_issues: det.issues,
        },
    };
}
