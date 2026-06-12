// src/auto-detect.ts
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import type { VerifyStep } from "./state";

/**
 * Auto-detect available verify commands by scanning the project.
 * Checks for config files and package.json scripts.
 * Returns an array of VerifyStep, or empty array if nothing is detected.
 */
export function detectVerifySteps(): VerifyStep[] {
  const steps: VerifyStep[] = [];

  // 1. Check package.json scripts for known patterns
  const pkgScripts = readPackageScripts();
  const scriptPriority = ["typecheck", "test", "lint", "check", "build"];

  for (const name of scriptPriority) {
    if (pkgScripts.includes(name)) {
      steps.push({ command: `bun run ${name}`, runsOn: "impl" });
    }
  }

  // 2. Check for config files (even without package.json scripts)
  if (!hasScript(pkgScripts, "typecheck") && existsSync("tsconfig.json")) {
    steps.push({ command: "bun run typecheck", runsOn: "impl" });
  }

  if (!hasScript(pkgScripts, "test") && hasTestFiles()) {
    steps.push({ command: "bun run test", runsOn: "impl" });
  }

  if (!hasScript(pkgScripts, "lint") && hasLintConfig()) {
    steps.push({ command: "bun run lint", runsOn: "impl" });
  }

  return steps;
}

// ── Internal helpers ──

function readPackageScripts(): string[] {
  try {
    const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
    return Object.keys(pkg.scripts ?? {});
  } catch {
    return [];
  }
}

function hasScript(scripts: string[], name: string): boolean {
  return scripts.includes(name);
}

function hasTestFiles(): boolean {
  return existsSync("tests") || existsSync("test") || existsSync("__tests__");
}

function hasLintConfig(): boolean {
  return (
    existsSync(".eslintrc") ||
    existsSync(".eslintrc.json") ||
    existsSync(".eslintrc.js") ||
    existsSync(".eslintrc.yaml") ||
    existsSync(".eslintrc.yml") ||
    existsSync("eslint.config.js") ||
    existsSync(".eslintrc.cjs")
  );
}
