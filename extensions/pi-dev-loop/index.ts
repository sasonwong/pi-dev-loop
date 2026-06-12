// extensions/pi-dev-loop/index.ts — pi-dev-loop extension entry point
//
// Commands:   /dev goal|stop|status|pause|resume|history
// Tools:      dev_control (called by LLM to signal iteration completion)
// Events:     input (prefix transform), before_agent_start (skill injection),
//             session_start / session_tree (state reconstruction)
// Resources:  skill + prompt registration

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import {
  createState,
  detectProgress,
  defaultConfig,
  type DevLoopState,
  type DevLoopConfig,
  type ErrorRecord,
} from "../../src/state.ts";
import { mergeRegistry, fingerprint, type ErrorSignature } from "../../src/error-registry.ts";
import { buildConfig, parseInlineVerifies, mergeConfigs } from "../../src/verify-config.ts";
import { loadConfigFromFile } from "../../src/load-config.ts";
import { takeSnapshot, hasUncommittedChanges, rollbackToSnapshot } from "../../src/git.ts";
import { buildIterationPrompt } from "../../src/session-prompt.ts";

// ── Types ─────────────────────────────────────────────────────

interface ImplSubagentReport {
  id: string;
  task: string;
  changedFiles: string[];
  verificationPassed: boolean;
  summary: string;
  errorsFixed: ErrorSignature[];
  errorsRemaining: ErrorSignature[];
}

interface ReviewFindingReport {
  severity: "critical" | "important" | "minor";
  file: string;
  message: string;
}

// ── Helpers ────────────────────────────────────────────────────

const _dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(_dirname, "../..");

function emptyState(): DevLoopState {
  return {
    active: false, mode: "goal", goal: "",
    currentStep: 0, maxSteps: 0,
    errorRegistry: [], reviewFindings: [],
    consecutiveZeroProgress: 0,
    stages: [], currentStage: 0,
    config: defaultConfig(),
    done: false, reasonDone: "",
  };
}

function buildDevCommandPrompt(goal: string, config: DevLoopConfig): string {
  const lines: string[] = [];
  lines.push("## Dev Loop — Iteration 1");
  lines.push("");
  lines.push(`Goal: ${goal}`);
  lines.push("");
  const implVerifies = config.verifySteps.filter(v => v.runsOn === "impl");
  if (implVerifies.length > 0) {
    lines.push("### Verification Commands (MUST pass before dev_control)");
    for (const v of implVerifies) lines.push(`- \`${v.command}\``);
    lines.push("");
  }
  lines.push("### How to start");
  lines.push("1. Analyze the codebase to understand what needs to change");
  lines.push("2. Spawn an **impl subagent** with full context:");
  lines.push('   `subagent({ agent: "worker", task: packImplTask(...) })`');
  lines.push("3. After impl returns, spawn a **review subagent**:");
  lines.push('   `subagent({ agent: "reviewer", task: packReviewTask(changedFiles) })`');
  lines.push("4. Call `dev_control({ status: \"next\", ... })` to continue");
  lines.push('   or `dev_control({ status: "done", ... })` if the goal is fully met');
  return lines.join("\n");
}

function updateWidget(state: DevLoopState, ctx: ExtensionContext) {
  if (!state.active) {
    ctx.ui.setStatus("dev-loop", undefined);
    ctx.ui.setWidget("dev-loop", undefined);
    return;
  }
  const total = state.errorRegistry.length;
  const fixed = state.errorRegistry.filter(e => e.status === "fixed").length;
  const open = total - fixed;
  const barLen = 10;
  const filled = total > 0 ? Math.round((fixed / total) * barLen) : 0;
  const bar = "\u25a0".repeat(filled) + "\u25a1".repeat(barLen - filled);
  const regressed = state.errorRegistry.filter(e => e.status === "regressed").length;
  const persistent = state.errorRegistry.filter(e => e.status === "persistent").length;
  const newErrors = state.errorRegistry.filter(e => e.status === "new").length;

  const label = `iter ${state.currentStep + 1}/${state.config.maxIterations}  [${bar}] ${open} open`;
  let detail = "";
  if (regressed > 0) detail += ` \u26a0 ${regressed} regressed`;
  if (newErrors > 0) detail += `  \u25a0 ${newErrors} new`;
  if (persistent > 0) detail += `  \u25a0 ${persistent} persist`;

  ctx.ui.setStatus("dev-loop", `\ud83d\udd04 ${label}`);
  ctx.ui.setWidget("dev-loop", [
    `\u250c\u2500 Dev Loop \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`,
    `\u2502 ${state.goal}`,
    `\u2502 ${label}${detail}`,
    `\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`,
  ]);
}

function toSnapshot(state: DevLoopState): object {
  return {
    active: state.active,
    mode: state.mode,
    goal: state.goal,
    currentStep: state.currentStep,
    maxSteps: state.maxSteps,
    errorRegistry: state.errorRegistry,
    reviewFindings: state.reviewFindings,
    consecutiveZeroProgress: state.consecutiveZeroProgress,
    pauseReason: state.pauseReason,
    config: state.config,
    lastCleanSnapshot: state.lastCleanSnapshot,
    latestSnapshot: state.latestSnapshot,
    done: state.done,
    reasonDone: state.reasonDone,
  };
}

function buildHistoryReport(ctx: ExtensionContext): string {
  const entries: string[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg.role === "toolResult" && msg.toolName === "dev_control") {
      const details = msg.details as {
        state?: DevLoopState; progress?: string;
      } | undefined;
      if (details?.state) {
        const s = details.state;
        const status = s.done ? "\u2713" : s.pauseReason ? "\u23f8" : "\u2192";
        const progressTag = details.progress ? ` [${details.progress}]` : "";
        // Use the summary from the dev_control call params if available
        const summary =
          (msg.params as { summary?: string })?.summary ??
          s.reasonDone ??
          "no summary";
        entries.push(
          `${status} Iteration ${s.currentStep}:${progressTag} ${summary}`,
        );
      }
    }
  }
  if (entries.length === 0) return "No dev loop history found.";
  return entries.join("\n");
}

// ── Extension entry ────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let state = emptyState();

  // ── Session reconstruction ──
  function reconstructState(ctx: ExtensionContext) {
    state = emptyState();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (msg.role === "toolResult" && msg.toolName === "dev_control") {
        const details = msg.details as { state?: Record<string, unknown> } | undefined;
        if (details?.state) {
          state = { ...emptyState(), ...details.state } as DevLoopState;
        }
      }
    }
  }

  pi.on("session_start", async (_e, ctx) => reconstructState(ctx));
  pi.on("session_tree", async (_e, ctx) => reconstructState(ctx));

  // ── Resource discovery (skill + prompt paths) ──
  pi.on("resources_discover", () => ({
    skillPaths: [join(PACKAGE_ROOT, "skills/pi-dev-loop/SKILL.md")],
    promptPaths: [join(PACKAGE_ROOT, "prompts/dev-goal.md")],
  }));

  // ── Input prefix transform (devloop: / #devloop) ──
  pi.on("input", async (event, ctx) => {
    const trimmed = event.text.trim();
    const match = trimmed.match(/^(?:devloop:|#devloop)\s*(.*)$/is);
    if (!match) return { action: "continue" };
    const objective = match[1]?.trim();
    if (!objective) {
      ctx.ui.notify("Usage: devloop: <objective>", "warning");
      return { action: "handled" };
    }
    return {
      action: "transform",
      text: `You are starting a dev loop. Goal: ${objective}\n\nStart by analyzing the project, then begin your first iteration. Use dev_control("next") to continue, dev_control("done") when complete.`,
    };
  });

  // ── System prompt injection (skill + loop context) ──
  pi.on("before_agent_start", async (event) => {
    if (!state.active) return;
    return {
      systemPrompt:
        event.systemPrompt +
        "\n\n## Active Dev Loop\n" +
        `Mode: ${state.mode} | Iteration: ${state.currentStep + 1}` +
        (state.maxSteps === Infinity ? "" : `/${state.maxSteps}`) +
        `\nGoal: ${state.goal}` +
        "\nYou are the **orchestrator**. Do NOT write code directly." +
        "\nAnalyze the error registry \u2192 deploy impl subagent(s) \u2192 deploy review subagent(s) \u2192 call dev_control." +
        "\nCall `dev_control` with status \"next\" to continue or \"done\" when the goal is fully met.",
    };
  });

  // ── /dev command ──
  pi.registerCommand("dev", {
    description:
      "Start/control a dev loop. Usage: /dev goal <desc> [options] | /dev stop | /dev status | /dev history",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify(
          "Usage:\n  /dev goal <desc> [--verify cmd] [--from-config [path]]\n" +
            "  /dev stop\n  /dev status\n  /dev pause\n  /dev resume\n  /dev history",
          "info",
        );
        return;
      }

      const parts = args.trim().split(/\s+/);
      const subcmd = parts[0];

      if (subcmd === "stop") {
        if (!state.active) { ctx.ui.notify("No active loop", "info"); return; }
        state.active = false;
        state.done = true;
        state.reasonDone = "Stopped by user";
        updateWidget(state, ctx);
        ctx.ui.notify("Dev loop stopped", "warning");
        return;
      }

      if (subcmd === "status") {
        if (!state.active) { ctx.ui.notify("No active loop", "info"); return; }
        const lines = [
          `Dev Loop \u2014 ${state.mode}`,
          `Iteration: ${state.currentStep + 1}${state.maxSteps === Infinity ? "" : `/${state.maxSteps}`}`,
          `Goal: ${state.goal}`,
          `Errors: ${state.errorRegistry.filter(e => e.status !== "fixed").length} open / ${state.errorRegistry.length} total`,
          `Review findings: ${state.reviewFindings.filter(f => f.status === "open").length} open`,
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (subcmd === "pause") {
        if (!state.active) { ctx.ui.notify("No active loop", "info"); return; }
        state.active = false;
        ctx.ui.setStatus("dev-loop", "paused");
        ctx.ui.notify("Dev loop paused. Use /dev resume to continue.", "info");
        return;
      }

      if (subcmd === "resume") {
        if (state.active) { ctx.ui.notify("Already active", "info"); return; }
        if (state.done) { ctx.ui.notify("Loop already completed", "info"); return; }
        state.active = true;
        updateWidget(state, ctx);
        pi.sendUserMessage(buildIterationPrompt(state));
        ctx.ui.notify("Dev loop resumed", "info");
        return;
      }

      if (subcmd === "history") {
        const report = buildHistoryReport(ctx);
        ctx.ui.notify(report, "info");
        return;
      }

      // ── /dev goal ... ──
      if (subcmd !== "goal") {
        ctx.ui.notify(
          `Unknown subcommand "${subcmd}". Use: goal, stop, status, pause, resume, history`,
          "error",
        );
        return;
      }

      await ctx.waitForIdle();

      // Parse: /dev goal <desc> [--verify cmd] [--max-iterations N] [--from-config [path]]
      const rest = parts.slice(1);
      const verifyFlags: string[] = [];
      let maxIterations = 20;
      let fromConfigPath: string | undefined;
      const goalParts: string[] = [];

      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "--verify" && i + 1 < rest.length) {
          verifyFlags.push("--verify", rest[++i]);
        } else if (rest[i] === "--max-iterations" && i + 1 < rest.length) {
          maxIterations = parseInt(rest[++i], 10) || 20;
        } else if (rest[i] === "--from-config") {
          if (i + 1 < rest.length && !rest[i + 1].startsWith("--") && rest[i + 1].length > 0) {
            fromConfigPath = rest[++i];
          } else {
            fromConfigPath = "";
          }
        } else {
          goalParts.push(rest[i]);
        }
      }

      const goal = goalParts.join(" ");
      if (!goal) {
        ctx.ui.notify("Provide a goal description", "error");
        return;
      }

      let config: DevLoopConfig;

      if (fromConfigPath !== undefined) {
        const yamlConfig = loadConfigFromFile(fromConfigPath || undefined);
        if (!yamlConfig) {
          const pathHint = fromConfigPath || ".pidev.yml";
          ctx.ui.notify(`Config file not found or invalid: ${pathHint}`, "error");
          return;
        }
        const cliVerify = parseInlineVerifies(verifyFlags);
        const cliOverrides: Partial<DevLoopConfig> = { maxIterations };
        if (cliVerify.length > 0) cliOverrides.verifySteps = cliVerify;
        config = mergeConfigs(yamlConfig, cliOverrides);
      } else {
        const verifySteps = parseInlineVerifies(verifyFlags);
        config = buildConfig({ maxIterations, verifySteps });
      }

      state = createState("goal", goal, config);
      if (config.verifySteps.length === 0) {
        ctx.ui.notify("Warning: no verify commands configured. Loop will rely on LLM judgment to determine completion.", "warning");
      }
      updateWidget(state, ctx);
      pi.sendUserMessage(buildDevCommandPrompt(goal, config));
    },
  });

  // ── dev_control tool ──
  pi.registerTool({
    name: "dev_control",
    label: "Dev Loop Control",
    description: [
      "Signal dev loop progress. Call this after impl subagent(s) and review subagent(s) complete.",
      "status 'next': advance to the next iteration.",
      "status 'done': the goal is fully met.",
    ].join(" "),
    parameters: Type.Object({
      status: StringEnum(["next", "done"] as const),
      summary: Type.String({ description: "What was accomplished this iteration" }),
      implSubagents: Type.Array(
        Type.Object({
          id: Type.String(),
          task: Type.String(),
          changedFiles: Type.Array(Type.String()),
          verificationPassed: Type.Boolean(),
          summary: Type.String(),
          errorsFixed: Type.Array(
            Type.Object({
              id: Type.String(),
              category: Type.String(),
              file: Type.String(),
              line: Type.Optional(Type.Number()),
              message: Type.String(),
            }),
          ),
          errorsRemaining: Type.Array(
            Type.Object({
              id: Type.String(),
              category: Type.String(),
              file: Type.String(),
              line: Type.Optional(Type.Number()),
              message: Type.String(),
            }),
          ),
        }),
        { description: "Results from implementation subagents" },
      ),
      reviewFindings: Type.Array(
        Type.Object({
          severity: StringEnum(["critical", "important", "minor"] as const),
          file: Type.String(),
          message: Type.String(),
        }),
        { description: "Findings from review subagents" },
      ),
    }),
    async execute(
      _id: string,
      params: {
        status: "next" | "done";
        summary: string;
        implSubagents: ImplSubagentReport[];
        reviewFindings: ReviewFindingReport[];
      },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      if (!state.active) {
        return {
          content: [{ type: "text", text: "No active dev loop. Start one with /dev goal." }],
          details: { state: null },
        };
      }

      if (params.status === "done") {
        state.active = false;
        state.done = true;
        state.reasonDone = params.summary;
        updateWidget(state, ctx);
        return {
          content: [
            {
              type: "text",
              text: `\u2713 Dev loop complete after ${state.currentStep + 1} iteration(s). ${state.reasonDone}`,
            },
          ],
          details: { state: toSnapshot(state) },
        };
      }

      // ── status === "next" — Decision Engine ──

      // Step 1: Verification check — all subagents MUST pass
      if (!params.implSubagents || params.implSubagents.length === 0) {
        return {
          content: [{
            type: "text",
            text: "\u2717 No impl subagents reported. Provide at least one impl subagent result.",
          }],
          details: { state: toSnapshot(state), blockReason: "no_subagents" },
        };
      }

      const allPassed = params.implSubagents.every(s => s.verificationPassed === true);
      if (!allPassed) {
        return {
          content: [{
            type: "text",
            text: "\u2717 Verification failed for one or more impl subagents. " +
              "All subagents must pass verification before advancing. " +
              "Fix the issues and call dev_control again.",
          }],
          details: { state: toSnapshot(state), blockReason: "verification_failed" },
        };
      }

      // Step 2: Collect review findings + auto-convert critical to error registry
      const incomingErrors: ErrorSignature[] = [];
      for (const f of params.reviewFindings ?? []) {
        state.reviewFindings.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          severity: f.severity,
          file: f.file,
          message: f.message,
          status: "open",
        });
        if (f.severity === "critical") {
          incomingErrors.push({
            id: fingerprint(f.file, undefined, f.message),
            category: "review",
            file: f.file,
            message: f.message,
          });
        }
      }

      // Step 3: Collect remaining errors from impl subagents
      for (const sub of params.implSubagents) {
        for (const err of sub.errorsRemaining ?? []) {
          if (err.id && err.file) {
            incomingErrors.push({
              id: err.id,
              category: (err.category as ErrorSignature["category"]) ?? "compile",
              file: err.file,
              line: err.line,
              message: err.message,
            });
          }
        }
      }

      // Step 4: Preserve old state for progress detection
      const oldErrorRegistry = [...state.errorRegistry];

      // Step 5: Merge registry
      state.errorRegistry = mergeRegistry(state.errorRegistry, incomingErrors, state.currentStep);

      // Step 6: Detect progress
      const progress = detectProgress(
        oldErrorRegistry,
        state.errorRegistry,
        state.consecutiveZeroProgress,
        state.config,
      );

      // Step 7: Decision branch
      state.currentStep++;

      if (progress === "regression") {
        state.pauseReason = "regression";
        state.active = false;

        if (state.config.guardrails.rollbackOnRegression && state.lastCleanSnapshot) {
          try {
            rollbackToSnapshot(state.lastCleanSnapshot);
          } catch {
            // Soft fail
          }
        }

        updateWidget(state, ctx);
        return {
          content: [{
            type: "text",
            text: `\u26a0 Regression detected at iteration ${state.currentStep}. ` +
              "Previously fixed errors have reappeared. The loop is paused." +
              (state.lastCleanSnapshot
                ? ` Auto-rolled back to clean snapshot ${state.lastCleanSnapshot.slice(0, 7)}. `
                : " ") +
              "Use /dev resume to retry with a different approach, or /dev stop to end.",
          }],
          details: { state: toSnapshot(state), progress, regression: true },
        };
      }

      if (progress === "zero-progress") {
        state.consecutiveZeroProgress++;
        if (state.consecutiveZeroProgress >= state.config.maxConsecutiveZeroProgress) {
          state.pauseReason = "zero-progress";
          state.active = false;
          updateWidget(state, ctx);
          return {
            content: [{
              type: "text",
              text: `\u26a0 Zero progress for ${state.consecutiveZeroProgress} consecutive iterations. ` +
                "The error set is not changing. Loop paused. " +
                "Consider a fundamentally different approach, then use /dev resume.",
            }],
            details: { state: toSnapshot(state), progress },
          };
        }
      } else {
        state.consecutiveZeroProgress = 0;
        if (state.latestSnapshot) {
          state.lastCleanSnapshot = state.latestSnapshot;
        }
      }

      // Step 8: Check completion
      const openErrors = state.errorRegistry.filter(e => e.status !== "fixed").length;
      const openFindings = state.reviewFindings.filter(f => f.status === "open").length;

      if (openErrors === 0 && openFindings === 0) {
        state.active = false;
        state.done = true;
        state.reasonDone = "All errors resolved, all review findings addressed";
        updateWidget(state, ctx);
        return {
          content: [{
            type: "text",
            text: `\u2713 All errors resolved after ${state.currentStep} iteration(s). Goal achieved.`,
          }],
          details: { state: toSnapshot(state) },
        };
      }

      // Step 9: Check max iterations
      if (state.currentStep >= state.config.maxIterations) {
        state.active = false;
        state.pauseReason = "max-iterations";
        updateWidget(state, ctx);
        return {
          content: [{
            type: "text",
            text: `\u26a0 Max iterations (${state.config.maxIterations}) reached. ` +
              "Loop paused. Use /dev resume to continue or /dev stop to end.",
          }],
          details: { state: toSnapshot(state) },
        };
      }

      // Step 10: Git auto-snapshot before next iteration
      if (state.config.guardrails.gitAutoSnapshot) {
        try {
          if (hasUncommittedChanges()) {
            const snap = takeSnapshot(`pre-iter-${state.currentStep + 1}`);
            state.latestSnapshot = snap.hash;
            if (!state.lastCleanSnapshot) {
              state.lastCleanSnapshot = snap.hash;
            }
          }
        } catch {
          // Soft fail — snapshot is best-effort
        }
      }

      // Step 11: Check for ask_user verifier (pause for user confirmation)
      const mainSteps = state.config.verifySteps.filter(v => v.runsOn === "main");
      if (mainSteps.length > 0) {
        state.active = false;
        updateWidget(state, ctx);
        const questions = mainSteps
          .map(s => `- ${(s as { question?: string }).question ?? "\u8bf7\u786e\u8ba4\u662f\u5426\u7ee7\u7eed"}`)
          .join("\n");
        pi.sendUserMessage(
          `## User Confirmation\n\nIteration ${state.currentStep} completed.\n\n${questions}\n\nEnter \`/dev resume\` to continue or \`/dev stop\` to end.`,
        );
        return {
          content: [{
            type: "text",
            text: "\u23f8 Paused for user confirmation. Use /dev resume to continue.",
          }],
          details: { state: toSnapshot(state), awaitingUser: true },
        };
      }

      // Step 12: Schedule next iteration
      updateWidget(state, ctx);
      setTimeout(() => {
        pi.sendMessage(
          {
            customType: "dev-loop-iteration",
            content: buildIterationPrompt(state),
            display: false,
          },
          { triggerTurn: true, deliverAs: "steer" },
        );
      }, 100);

      return {
        content: [{
          type: "text",
          text: `\u2192 Advancing to iteration ${state.currentStep + 1}. Progress: ${progress}.`,
        }],
        details: { state: toSnapshot(state), progress },
      };
    },
    renderCall(
      args: { status: string },
      theme: { fg: (color: string, text: string) => string },
    ) {
      return new Text(
        theme.fg("toolTitle", "dev_control ") +
          theme.fg(args.status === "done" ? "success" : "accent", args.status),
        0,
        0,
      );
    },
    renderResult(
      result: { details?: { state?: DevLoopState; progress?: string } },
      _opts: unknown,
      theme: { fg: (color: string, text: string) => string },
    ) {
      const d = result.details;
      if (!d?.state) return new Text("", 0, 0);
      const s = d.state;
      const progressTag = d.progress ? ` [${d.progress}]` : "";
      const color = s.done ? "success" : s.pauseReason ? "warning" : "accent";
      const icon = s.done ? "\u2713" : s.pauseReason ? "\u23f8" : "\u2192";
      return new Text(
        theme.fg(color, `${icon} iter ${s.currentStep + 1} \u2014 ${s.mode}${progressTag}`),
        0,
        0,
      );
    },
  });
}
