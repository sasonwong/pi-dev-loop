import { createHash } from "node:crypto";

import type { ErrorRecord, CustomParserConfig, ParserConfig, VerifyStep } from "./state";

export interface ErrorSignature {
  id: string;
  category: ErrorRecord["category"];
  file: string;
  line?: number;
  message: string;
}

/**
 * Generate a stable error fingerprint by normalizing variable parts of the
 * message (line numbers, column references, expected/got counts) and hashing.
 */
export function fingerprint(file: string, line: number | undefined, message: string): string {
  const normal = message
    .replace(/line \d+/gi, "line N")
    .replace(/:\d+:/g, ":N:")
    .replace(/expected \d+/gi, "expected N")
    .replace(/got \d+/gi, "got N")
    .trim();
  const linePart = line !== undefined ? `:${line}` : ":0";
  return createHash("sha256")
    .update(`${file}${linePart}:${normal}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Merge a new set of error signatures into the existing error registry.
 *
 * State transitions:
 *   fixed error reappears → regressed
 *   new error persists    → persistent
 *   open error gone       → fixed
 *   never-seen error      → new
 */
export function mergeRegistry(
  existing: ErrorRecord[],
  incoming: ErrorSignature[],
  iteration: number,
): ErrorRecord[] {
  const updated: ErrorRecord[] = [];
  const incomingIds = new Set(incoming.map(e => e.id));
  const fixedIds = new Set(
    existing.filter(r => r.status === "fixed").map(r => r.id),
  );

  for (const record of existing) {
    if (record.status === "fixed") {
      // Check for regression: a previously fixed error reappears
      if (incomingIds.has(record.id)) {
        updated.push({
          ...record,
          status: "regressed",
          lastSeenAt: iteration,
          regressedAt: [...(record.regressedAt ?? []), iteration],
        });
        incomingIds.delete(record.id);
      }
      continue;
    }

    if (incomingIds.has(record.id)) {
      // Error still present — advance status from "new" to "persistent"
      const newStatus = record.status === "new" ? "persistent" : record.status;
      updated.push({ ...record, status: newStatus, lastSeenAt: iteration });
      incomingIds.delete(record.id);
    } else {
      // Error gone — mark as fixed
      updated.push({ ...record, status: "fixed", fixedAt: iteration });
    }
  }

  // Remaining incoming = brand new errors (never seen before)
  for (const sig of incoming) {
    if (!incomingIds.has(sig.id)) continue;
    if (fixedIds.has(sig.id)) continue; // already handled as regression above
    updated.push({
      id: sig.id,
      category: sig.category,
      file: sig.file,
      line: sig.line,
      message: sig.message,
      status: "new",
      firstSeenAt: iteration,
      lastSeenAt: iteration,
    });
  }

  // Preserve fixed records for future regression detection
  for (const record of existing) {
    if (record.status === "fixed") {
      const already = updated.some(u => u.id === record.id);
      if (!already) updated.push(record);
    }
  }

  return updated;
}

// ── Parser regex patterns ───────────────────────────────────

const TSC_RE = /(\S+\.\w+):(\d+):\d+ - (?:error|warning) TS\(?\d+\)?: (.+)$/gm;

function parseTSCOutput(output: string): ErrorSignature[] {
  const results: ErrorSignature[] = [];
  for (const match of output.matchAll(TSC_RE)) {
    const file = match[1].trim();
    const line = parseInt(match[2], 10);
    const message = match[3].trim();
    results.push({
      id: fingerprint(file, line, message),
      category: "type",
      file,
      line,
      message,
    });
  }
  return results;
}

function parseESLintOutput(output: string): ErrorSignature[] {
  const results: ErrorSignature[] = [];
  const lines = output.split("\n");
  let currentFile: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Filename line (non-empty, no leading whitespace, has file extension)
    const fileMatch = line.match(/^(\S+\.\w+)$/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      continue;
    }
    // Indented error line in stylish format
    const errMatch = line.match(/^\s+(\d+):\d+\s+(?:error|warning)\s+\S+\s+(.+)$/);
    if (errMatch && currentFile) {
      const lineNum = parseInt(errMatch[1], 10);
      const message = errMatch[2].trim();
      results.push({
        id: fingerprint(currentFile, lineNum, message),
        category: "lint",
        file: currentFile,
        line: lineNum,
        message,
      });
    }
  }
  return results;
}

function parseVitestOutput(output: string): ErrorSignature[] {
  const results: ErrorSignature[] = [];
  const lines = output.split("\n");
  let currentTestName: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const failMatch = line.match(/^\s+×\s+(.+?)(?:\s+\(\d+ms\))?$/);
    if (failMatch) {
      currentTestName = failMatch[1].trim();
      continue;
    }
    const msgMatch = line.match(/^\s+→\s+(.+)$/);
    if (msgMatch && currentTestName) {
      const assertionMsg = msgMatch[1].trim();
      // Look ahead in following lines for a source file reference
      let file = "test";
      let lineNum: number | undefined;
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const stackMatch = lines[j].match(/^\s+-\s+(\S+\.\w+):(\d+):\d+/);
        if (stackMatch) {
          file = stackMatch[1];
          lineNum = parseInt(stackMatch[2], 10);
          break;
        }
      }
      const message = `${currentTestName}: ${assertionMsg}`;
      results.push({
        id: fingerprint(file, lineNum ?? 0, message),
        category: "test",
        file,
        line: lineNum,
        message,
      });
      currentTestName = null;
    }
  }
  return results;
}

/**
 * Parse tool output using a custom regex config with named capture groups.
 */
export function parseCustomOutput(
  output: string,
  config: CustomParserConfig,
): ErrorSignature[] {
  let re: RegExp;
  try {
    re = new RegExp(config.pattern, "gm");
  } catch (e) {
    throw new Error(`Invalid parser regex pattern: ${config.pattern} — ${(e as Error).message}`);
  }
  const results: ErrorSignature[] = [];
  const fileGroup = config.fileGroup ?? "file";
  const lineGroup = config.lineGroup ?? "line";
  const messageGroup = config.messageGroup ?? "message";

  for (const match of output.matchAll(re)) {
    const groups = match.groups ?? {};
    const file = groups[fileGroup]?.trim();
    const lineStr = groups[lineGroup]?.trim();
    const message = groups[messageGroup]?.trim();
    if (!file || !message) continue;
    const line = lineStr ? parseInt(lineStr, 10) : undefined;
    const id = fingerprint(file, line ?? 0, message);
    results.push({ id, category: config.category, file, line, message });
  }
  return results;
}

/**
 * Parse tool output into structured ErrorSignature[].
 * Supports builtin parsers ("tsc", "eslint", "vitest") and custom regex config.
 * Always returns an array (empty = no errors found).
 */
export function parseOutput(
  output: string,
  parser: ParserConfig,
): ErrorSignature[] {
  if (!output || output.trim().length === 0) return [];

  if (typeof parser === "string") {
    switch (parser) {
      case "tsc":     return parseTSCOutput(output);
      case "eslint":  return parseESLintOutput(output);
      case "vitest":  return parseVitestOutput(output);
      default:        return [];
    }
  }

  return parseCustomOutput(output, parser);
}

/**
 * Look up the parser configuration for a given command string from verify steps.
 * Returns null if the command is not found or has no parser configured.
 */
export function getParserForCommand(
  command: string,
  steps: VerifyStep[],
): ParserConfig | null {
  const step = steps.find(s => s.command === command);
  if (!step || !step.parser) return null;
  // Narrow string to BuiltinParserName; if not a valid name, treat as null
  const parser = step.parser;
  if (typeof parser === "string") {
    if (parser === "tsc" || parser === "eslint" || parser === "vitest") {
      return parser;
    }
    return null;
  }
  return parser;
}
