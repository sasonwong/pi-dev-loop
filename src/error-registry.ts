import { createHash } from "node:crypto";

import type { ErrorRecord } from "./state";

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
export function fingerprint(file: string, line: number, message: string): string {
  const normal = message
    .replace(/line \d+/gi, "line N")
    .replace(/:\d+:/g, ":N:")
    .replace(/expected \d+/gi, "expected N")
    .replace(/got \d+/gi, "got N")
    .trim();
  return createHash("sha256")
    .update(`${file}:${line}:${normal}`)
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

/**
 * Simple heuristic: map exit code to error category.
 * Refined per-tool in a later task.
 */
export function categorize(exitCode: number, _output: string): ErrorRecord["category"] {
  if (exitCode === 0) return "compile";
  return "compile";
}
