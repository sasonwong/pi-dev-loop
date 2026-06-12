import type { ErrorRecord, DevLoopConfig } from "./state";

/**
 * Replace `{files}` placeholders in a command string with the actual file list.
 * Uses a global regex so all occurrences are replaced.
 * Returns the command unchanged if there are no placeholders.
 */
export function expandCommand(cmd: string, changedFiles: string[]): string {
  return cmd.replace(/\{files\}/g, changedFiles.join(" "));
}

/**
 * Build the full-context task string for an implementation subagent.
 * The subagent receives error details, additional context, and the
 * verification commands it MUST pass before returning.
 *
 * @param changedFiles - Files changed so far in this iteration (for {files} expansion).
 */
export function packImplTask(
  error: ErrorRecord,
  config: DevLoopConfig,
  extraContext?: string,
  changedFiles: string[] = [],
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
      const cmd = expandCommand(step.command, changedFiles);
      lines.push(`- \`${cmd}\``);
    }
    lines.push("");
  }

  // Structured output section
  lines.push("### Structured Output Format");
  lines.push("When your work is complete, your response must end with a JSON code block (no text after the closing ```):");
  lines.push("");
  lines.push('```json');
  lines.push('{');
  lines.push('  "changedFiles": ["...", "..."],');
  lines.push('  "verificationPassed": true,');
  lines.push('  "summary": "What was done and the result",');
  lines.push('  "errorsFixed": [');
  lines.push('    {"id": "abc123", "category": "type", "file": "src/main.ts", "line": 42, "message": "..."}');
  lines.push('  ],');
  lines.push('  "errorsRemaining": []');
  lines.push('}');
  lines.push('```');
  lines.push("");
  lines.push("- `errorsFixed`: errors confirmed fixed (no longer appear in verification output)");
  lines.push("- `errorsRemaining`: errors that persist after your fix");
  lines.push("- `verificationPassed`: MUST be `true` for all required commands to pass");

  return lines.join("\n");
}

/**
 * Build a context-free review task for a review subagent.
 * Only the list of changed files is provided — no task context,
 * so the reviewer evaluates the code independently.
 */
export function packReviewTask(changedFiles: string[]): string {
  if (changedFiles.length === 0) {
    return "## Code Review Task\n\nNo files changed to review.";
  }
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

  lines.push("### Structured Output Format");
  lines.push("Your response must end with a JSON code block (no text after the closing ```):");
  lines.push("");
  lines.push('```json');
  lines.push('{');
  lines.push('  "findings": [');  
  lines.push('    {"severity": "critical", "file": "src/main.ts", "message": "..."},');
  lines.push('    {"severity": "important", "file": "src/main.ts", "message": "..."},');
  lines.push('    {"severity": "minor", "file": "src/main.ts", "message": "..."}');
  lines.push('  ]');
  lines.push('}');
  lines.push('```');

  return lines.join("\n");
}
