import type { ErrorRecord, DevLoopConfig } from "./state";

/**
 * Build the full-context task string for an implementation subagent.
 * The subagent receives error details, additional context, and the
 * verification commands it MUST pass before returning.
 */
export function packImplTask(
  error: ErrorRecord,
  config: DevLoopConfig,
  extraContext?: string,
): string {
  const lines: string[] = [];
  lines.push("## Implementation Task");
  lines.push("");
  lines.push("Fix the following error using TDD (write failing test → implement → verify all commands pass).");
  lines.push("");

  const loc = error.line ? `${error.file}:${error.line}` : error.file;
  lines.push("### Error Details");
  lines.push(`- File: \`${loc}\``);
  lines.push(`- Category: ${error.category}`);
  lines.push(`- Message: ${error.message}`);
  lines.push("");

  if (extraContext) {
    lines.push("### Additional Context");
    lines.push(extraContext);
    lines.push("");
  }

  const implSteps = config.verifySteps.filter(v => v.runsOn === "impl");
  if (implSteps.length > 0) {
    lines.push("### Required Verification (MUST pass before returning)");
    for (const step of implSteps) {
      lines.push(`- \`${step.command}\``);
    }
    lines.push("");
  }

  lines.push("Return: changedFiles[], verificationPassed (boolean), summary");

  return lines.join("\n");
}

/**
 * Build a context-free review task for a review subagent.
 * Only the list of changed files is provided — no task context,
 * so the reviewer evaluates the code independently.
 */
export function packReviewTask(changedFiles: string[]): string {
  const lines: string[] = [];
  lines.push("## Code Review Task");
  lines.push("");
  lines.push("Review the following changed files for issues:");
  lines.push("");
  for (const file of changedFiles) {
    lines.push(`- \`${file}\``);
  }
  lines.push("");
  lines.push("Look for:");
  lines.push("- Edge cases not handled");
  lines.push("- Missing or incorrect error handling");
  lines.push("- Test coverage gaps");
  lines.push("- Maintainability concerns");
  lines.push("");
  lines.push('Return: findings[] with severity (critical/important/minor), file, message');

  return lines.join("\n");
}
