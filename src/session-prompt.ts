import type { DevLoopState, ErrorRecord, ReviewFinding } from "./state";

function statusBadge(status: string): string {
  const map: Record<string, string> = {
    new: "NEW",
    fixed: "FIXED ✓",
    regressed: "REGRESSED ⚠",
    persistent: "PERSIST",
  };
  return map[status] ?? status.toUpperCase();
}

function formatSince(record: ErrorRecord): string {
  if (record.fixedAt) return `iter ${record.fixedAt} (fixed)`;
  if (record.status === "new") return `iter ${record.firstSeenAt}`;
  if (record.status === "regressed") {
    const last = record.regressedAt?.[record.regressedAt.length - 1] ?? record.lastSeenAt;
    return `iter ${record.firstSeenAt}→${last}`;
  }
  return `iter ${record.firstSeenAt}→${record.lastSeenAt}`;
}

/**
 * Build the markdown iteration prompt injected into the main session
 * at the start of each loop iteration.
 */
export function buildIterationPrompt(state: DevLoopState): string {
  const step = state.currentStep + 1;
  const total = state.maxSteps === Infinity ? "∞" : String(state.maxSteps);
  const modeLabel =
    state.mode === "goal" ? "Goal Loop" :
    state.mode === "passes" ? "Fixed Passes" : "Pipeline";

  const lines: string[] = [];
  lines.push(`## Dev Loop — ${modeLabel} — Iteration ${step}/${total}`);
  lines.push("");
  lines.push("### Goal");
  lines.push(state.goal);
  lines.push("");

  // Error registry table
  const active = state.errorRegistry.filter(e => e.status !== "fixed");
  if (active.length > 0) {
    lines.push("### Error Registry");
    lines.push("| Status | File | Error | Since |");
    lines.push("|--------|------|-------|-------|");
    for (const err of active) {
      const loc = err.line ? `${err.file}:${err.line}` : err.file;
      lines.push(`| ${statusBadge(err.status)} | \`${loc}\` | ${err.message} | ${formatSince(err)} |`);
    }
    lines.push("");
  } else {
    lines.push("### Error Registry");
    lines.push("No outstanding errors.");
    lines.push("");
  }

  // Review findings
  const openFindings = state.reviewFindings.filter(f => f.status === "open");
  if (openFindings.length > 0) {
    lines.push("### Review Findings");
    for (const f of openFindings) {
      const icon =
        f.severity === "critical" ? "🔴" :
        f.severity === "important" ? "⚠️" : "📝";
      lines.push(`- ${icon} \`${f.file}\` — ${f.message} (${f.severity})`);
    }
    lines.push("");
  }

  // Priority guidance
  lines.push("### Priority Order");
  lines.push("1. **REGRESSED ⚠** — something came back, fix immediately");
  lines.push("2. **NEW** — newly introduced, fix before adding more");
  lines.push("3. **PERSIST** — old unresolved, may need different approach");
  lines.push("4. **REVIEW** — code quality issues from review");
  lines.push("");

  // Instructions
  lines.push("### This Iteration");
  lines.push("1. Analyze the error registry above");
  lines.push("2. Determine what to fix — pick the highest-priority error");
  lines.push("3. Spawn an **impl subagent** with full context (error details + verify commands)");
  lines.push("4. After impl returns, spawn a **review subagent** with ONLY the changed file list");
  lines.push('5. Call `dev_control` with status "next" (needs more work) or "done" (goal met)');

  return lines.join("\n");
}
