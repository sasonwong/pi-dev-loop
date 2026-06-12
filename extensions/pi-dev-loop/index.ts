// extensions/pi-dev-loop/index.ts — pi-dev-loop extension entry point
//
// Commands:   /dev goal|stop|status|pause|resume
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
} from "../../src/state.ts";
import { buildConfig, parseInlineVerifies } from "../../src/verify-config.ts";
import { buildIterationPrompt } from "../../src/session-prompt.ts";

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
  lines.push("## Dev Loop Initialization");
  lines.push("");
  lines.push(`Goal: ${goal}`);
  lines.push("");
  const implVerifies = config.verifySteps.filter(v => v.runsOn === "impl");
  if (implVerifies.length > 0) {
    lines.push("### Verification Commands");
    for (const v of implVerifies) lines.push(`- \`${v.command}\``);
    lines.push("");
  }
  lines.push("Start your first iteration: analyze the goal, spawn impl subagents,");
  lines.push('then call `dev_control` with status "next" or "done".');
  return lines.join("\n");
}

function updateWidget(state: DevLoopState, ctx: ExtensionContext) {
  if (!state.active) {
    ctx.ui.setStatus("dev-loop", undefined);
    ctx.ui.setWidget("dev-loop", undefined);
    return;
  }
  const openErrors = state.errorRegistry.filter(e => e.status !== "fixed").length;
  const label = `iter ${state.currentStep + 1} (${openErrors} errors)`;
  ctx.ui.setStatus("dev-loop", `🔄 ${label}`);
  ctx.ui.setWidget("dev-loop", [
    `┌─ Dev Loop: ${state.mode} ────────`,
    `│ ${state.goal}`,
    `│ ${label}`,
    `└──────────────────────────────────`,
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
    config: state.config,
    lastCleanSnapshot: state.lastCleanSnapshot,
    latestSnapshot: state.latestSnapshot,
    done: state.done,
    reasonDone: state.reasonDone,
  };
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
        "\nAnalyze the error registry → deploy impl subagent(s) → deploy review subagent(s) → call dev_control." +
        "\nCall `dev_control` with status \"next\" to continue or \"done\" when the goal is fully met.",
    };
  });

  // ── /dev command ──
  pi.registerCommand("dev", {
    description: "Start/control a dev loop. Usage: /dev goal <desc> [options] | /dev stop | /dev status",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify(
          "Usage:\n  /dev goal <desc> [--verify cmd]\n  /dev stop\n  /dev status\n  /dev pause\n  /dev resume",
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
          `Dev Loop — ${state.mode}`,
          `Iteration: ${state.currentStep + 1}${state.maxSteps === Infinity ? "" : `/${state.maxSteps}`}`,
          `Goal: ${state.goal}`,
          `Errors: ${state.errorRegistry.filter(e => e.status !== "fixed").length} open`,
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

      // ── /dev goal ... ──
      if (subcmd !== "goal") {
        ctx.ui.notify(`Unknown subcommand "${subcmd}". Use: goal, stop, status, pause, resume`, "error");
        return;
      }

      await ctx.waitForIdle();

      // Parse: /dev goal <desc> [--verify cmd] [--max-iterations N]
      const rest = parts.slice(1); // remove "goal"
      const verifyFlags: string[] = [];
      let maxIterations = 20;
      const goalParts: string[] = [];

      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "--verify" && i + 1 < rest.length) {
          verifyFlags.push("--verify", rest[++i]);
        } else if (rest[i] === "--max-iterations" && i + 1 < rest.length) {
          maxIterations = parseInt(rest[++i], 10) || 20;
        } else {
          goalParts.push(rest[i]);
        }
      }

      const goal = goalParts.join(" ");
      if (!goal) {
        ctx.ui.notify("Provide a goal description", "error");
        return;
      }

      const verifySteps = parseInlineVerifies(verifyFlags);
      const config = buildConfig({ maxIterations, verifySteps });

      state = createState("goal", goal, config);
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
    async execute(_id: string, params: {
      status: "next" | "done";
      summary: string;
      implSubagents: Array<{
        id: string; task: string; changedFiles: string[];
        verificationPassed: boolean; summary: string;
      }>;
      reviewFindings: Array<{ severity: "critical" | "important" | "minor"; file: string; message: string }>;
    }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
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
            { type: "text", text: `✓ Dev loop complete after ${state.currentStep + 1} iteration(s). ${state.reasonDone}` },
          ],
          details: { state: toSnapshot(state) },
        };
      }

      // status === "next" — advance iteration
      // 1. Record review findings
      for (const f of params.reviewFindings ?? []) {
        state.reviewFindings.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          severity: f.severity,
          file: f.file,
          message: f.message,
          status: "open",
        });
      }

      state.currentStep++;

      // 2. Check max iterations
      if (state.currentStep >= state.config.maxIterations) {
        state.active = false;
        state.pauseReason = "max-iterations";
        updateWidget(state, ctx);
        return {
          content: [
            {
              type: "text",
              text: `⚠ Dev loop paused after ${state.currentStep} iterations (max reached). Use /dev resume to continue or /dev stop to end.`,
            },
          ],
          details: { state: toSnapshot(state) },
        };
      }

      // 3. Update widget and schedule next iteration
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
        content: [
          { type: "text", text: `→ Advancing to iteration ${state.currentStep + 1}.` },
        ],
        details: { state: toSnapshot(state) },
      };
    },
    renderCall(args: { status: string }, theme: {
      fg: (color: string, text: string) => string;
      bold: (text: string) => string;
    }) {
      return new Text(
        theme.fg("toolTitle", "dev_control ") +
        theme.fg(args.status === "done" ? "success" : "accent", args.status),
        0, 0,
      );
    },
    renderResult(result: { details?: { state?: DevLoopState } }, _opts: unknown, theme: {
      fg: (color: string, text: string) => string;
    }) {
      const d = result.details;
      if (!d?.state) return new Text("", 0, 0);
      const s = d.state;
      return new Text(
        theme.fg(s.done ? "success" : "accent", `${s.done ? "✓" : "→"} iter ${s.currentStep + 1} — ${s.mode}`),
        0, 0,
      );
    },
  });
}
