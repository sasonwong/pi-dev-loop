import { execSync } from "node:child_process";

/** Environment preset for git commands — disables editor interactive prompts. */
const GIT_ENV = { ...process.env, GIT_EDITOR: "true" };

export interface GitSnapshot {
  hash: string;
  branch: string;
  timestamp: number;
}

/**
 * Check if the working tree has uncommitted changes.
 * Pass `cwd` for testing, defaults to process.cwd().
 */
export function hasUncommittedChanges(cwd?: string): boolean {
  const dir = cwd ?? process.cwd();
  const output = execSync("git status --porcelain", { cwd: dir, env: GIT_ENV }).toString().trim();
  return output.length > 0;
}

/**
 * Create a snapshot commit of all current changes and tag it.
 * The commit message is prefixed with `prefix` for later identification.
 * A lightweight tag `dev-loop/snap-<short-hash>` is created so that
 * pruneSnapshots can find and clean old snapshots.
 * Throws if there are no changes to commit.
 */
export function takeSnapshot(prefix: string, cwd?: string): GitSnapshot {
  const dir = cwd ?? process.cwd();
  execSync("git add -A", { cwd: dir, env: GIT_ENV });
  const staged = execSync("git diff --cached --stat", { cwd: dir, env: GIT_ENV }).toString().trim();
  if (!staged) {
    throw new Error("No changes to snapshot");
  }
  execSync(`git commit -m "dev-loop: ${prefix}"`, { cwd: dir, env: GIT_ENV });
  const hash = execSync("git rev-parse HEAD", { cwd: dir, env: GIT_ENV }).toString().trim();
  const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: dir, env: GIT_ENV }).toString().trim();
  // Create a lightweight tag for pruneSnapshots to track
  const tagName = `dev-loop/snap-${hash.slice(0, 7)}`;
  try {
    execSync(`git update-ref refs/tags/${tagName} ${hash}`, { cwd: dir, env: GIT_ENV });
  } catch { /* best-effort tag creation */ }
  return { hash, branch, timestamp: Date.now() };
}

/**
 * Hard-reset to a specific snapshot hash. Discards all changes after that point.
 */
export function rollbackToSnapshot(hash: string, cwd?: string): void {
  const dir = cwd ?? process.cwd();
  execSync(`git reset --hard ${hash}`, { cwd: dir, env: GIT_ENV });
}

/**
 * Prune old dev-loop snapshot tags, keeping the most recent `keep` count.
 * Uses lightweight tags (created by takeSnapshot) to identify snapshots.
 * The underlying commits remain in the branch; this only removes the tag refs.
 * This is a best-effort operation — tag deletion failures are silently ignored.
 */
export function pruneSnapshots(keep: number, cwd?: string): void {
  if (keep <= 0) return;
  const dir = cwd ?? process.cwd();
  // List all dev-loop snapshot tags, sorted by commit date (newest first)
  const tagLines = execSync(
    'git for-each-ref --sort=-committerdate refs/tags/dev-loop/snap-* --format="%(refname:short)"',
    { cwd: dir, env: GIT_ENV },
  ).toString().trim().split("\n").filter(Boolean);

  if (tagLines.length <= keep) return;

  // Delete older tags (after the first `keep` entries)
  const toRemove = tagLines.slice(keep);
  for (const tag of toRemove) {
    try {
      execSync(`git tag -d ${tag}`, { cwd: dir, env: GIT_ENV });
    } catch { /* best-effort */ }
  }
}
