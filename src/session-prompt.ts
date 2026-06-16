import type { DevLoopState, ErrorRecord, ReviewFinding } from "./state";

/**
 * Build the markdown iteration prompt injected into the main session
 * at the start of each loop iteration.
 */
export function buildIterationPrompt(state: DevLoopState): string {
  const step = state.currentStep + 1;
  const total = state.maxSteps === Infinity ? "\u221e" : String(state.maxSteps);

  const lines: string[] = [];
  lines.push(`## \ud83d\udd04 Dev Loop \u2014 Iteration ${step}/${total}`);
  lines.push("");
  lines.push(`**Goal:** ${state.goal}`);
  lines.push("");

  // Error registry — compact list
  const active = state.errorRegistry.filter(e => e.status !== "fixed");
  if (active.length > 0) {
    for (const err of active) {
      const badge =
        err.status === "regressed" ? "\u26a0\ufe0f" :
        err.status === "new" ? "\ud83d\udd35" : "\ud83d\udd01";
      const loc = err.line ? `${err.file}:${err.line}` : err.file;
      lines.push(`${badge} \`${loc}\` \u2014 ${err.message}`);
    }
    lines.push("");
  } else {
    lines.push("No outstanding errors.");
    lines.push("");
  }

  // Review findings
  const openFindings = state.reviewFindings.filter(f => f.status === "open");
  for (const f of openFindings) {
    const icon = f.severity === "critical" ? "\ud83d\udd34" : f.severity === "important" ? "\u26a0\ufe0f" : "\ud83d\udcdd";
    lines.push(`${icon} \`${f.file}\` \u2014 ${f.message}`);
  }
  if (openFindings.length > 0) lines.push("");

  // Direct action instruction
  lines.push("**Your job:** Fix errors using TDD. Use `subagent()` to delegate if available.");
  lines.push("After fixes are verified, call `loop_control({ status: \"next\" | \"done\", ... })`");
  lines.push("with the structured results (implSubagents, reviewFindings).");

  return lines.join("\n");
}
