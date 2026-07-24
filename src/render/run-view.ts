import type { LoadedRunBundle } from "../workflows/store.js";
import type { WorkflowRunStatus, WorkflowStepRecord } from "../workflows/types.js";
import { ansi, fitWidth, sanitizeText } from "./ansi.js";
import { formatDuration, runElapsedMs } from "./format.js";
import { renderGraphLines } from "./graph-render.js";

export { formatDuration, runElapsedMs };

export type ViewportSize = {
  width: number;
  height: number;
};

const STATUS_COLORS: Record<WorkflowRunStatus, (text: string) => string> = {
  running: ansi.cyan,
  waiting: ansi.yellow,
  completed: ansi.green,
  failed: ansi.red,
  timed_out: ansi.red,
  cancelled: ansi.yellow,
};

function statusLabel(status: WorkflowRunStatus): string {
  return STATUS_COLORS[status](status);
}

/** Uncoloured run-status glyphs, shared by the widget and the in-pi picker. */
export const STATUS_GLYPHS: Record<WorkflowRunStatus, string> = {
  running: "◐",
  waiting: "⏸",
  completed: "✓",
  failed: "✗",
  timed_out: "✗",
  cancelled: "✗",
};

/**
 * One picker row per run. Declared here rather than imported from pi-tui: this
 * module lives in src/render, which is pi-agnostic (it may import only
 * src/workflows). The shape is structurally assignable to pi-tui's `SelectItem`.
 */
export type RunListItem = {
  value: string;
  label: string;
  description: string;
};

/** Run rows for a native picker. Emits no ANSI so the host theme owns styling. */
export function runListItems(bundles: LoadedRunBundle[], now: Date = new Date()): RunListItem[] {
  return bundles.map(({ runDir, state }) => {
    const title = state.runTitle ? ` — ${sanitizeText(state.runTitle)}` : "";
    return {
      value: runDir,
      label: `${STATUS_GLYPHS[state.status]} ${sanitizeText(state.workflowName)}${title}`,
      description: `${state.runId} · ${formatDuration(runElapsedMs(state, now))}`,
    };
  });
}

function previewValue(value: unknown, maxLength: number): string {
  if (value === undefined) {
    return "";
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  // Bound before the character-by-character passes below: step output is
  // model-controlled and capped at 1 MB per stream, and this only ever yields
  // `maxLength` characters. 4x leaves room for whitespace collapsing.
  const bounded = (text ?? "").slice(0, maxLength * 4);
  // Model-controlled values must not carry escape sequences into the terminal.
  const singleLine = sanitizeText(bounded).replaceAll(/\s+/g, " ").trim();
  return singleLine.length <= maxLength ? singleLine : `${singleLine.slice(0, maxLength - 1)}…`;
}

function stepLine(
  step: WorkflowStepRecord,
  index: number,
  selectedStepIndex: number,
  width: number,
): string {
  const durationMs = Date.parse(step.finishedAt) - Date.parse(step.startedAt);
  const glyph = step.outcome === "ok" ? ansi.green("✓") : ansi.red("✗");
  const marker = index === selectedStepIndex ? ansi.cyan("›") : " ";
  const preview =
    step.error !== undefined
      ? ansi.red(previewValue(step.error, 60))
      : ansi.dim(previewValue(step.output, 60));
  return fitWidth(
    ` ${marker}${glyph} ${step.nodeId} ${ansi.dim(`(${step.nodeType}, ${formatDuration(durationMs)})`)} ${preview}`,
    width,
  );
}

/** Fallback node status list for bundles without a definition snapshot. */
function nodeStatusLine(bundle: LoadedRunBundle, nodeId: string, width: number, now: Date): string {
  const state = bundle.state;
  const nodeType = bundle.snapshot?.nodes[nodeId]?.nodeType ?? "?";
  const result = state.results[nodeId];
  let glyph = ansi.dim("·");
  let suffix = "";
  if (state.currentNode === nodeId) {
    glyph = ansi.cyan("◐");
    const startedAt = state.currentNodeStartedAt
      ? Date.parse(state.currentNodeStartedAt)
      : now.getTime();
    const detail = state.statusDetail ? ` · ${sanitizeText(state.statusDetail)}` : "";
    suffix = ansi.cyan(` running ${formatDuration(now.getTime() - startedAt)}${detail}`);
  } else if (state.waitingOn === nodeId) {
    glyph = ansi.yellow("⏸");
    suffix = ansi.yellow(" waiting");
  } else if (result) {
    glyph = result.outcome === "ok" ? ansi.green("✓") : ansi.red("✗");
    suffix = ansi.dim(` ${formatDuration(result.durationMs)}`);
  }
  return fitWidth(`  ${glyph} ${nodeId} ${ansi.dim(`[${nodeType}]`)}${suffix}`, width);
}

const MAX_INSPECTOR_LINES = 200;

/** Pretty-printed JSON body of the selected step for the inspector pane. */
function inspectorLines(step: WorkflowStepRecord, width: number): string[] {
  const lines: string[] = [];
  const body = step.error !== undefined ? step.error : step.output;
  const rendered =
    typeof body === "string" && step.error !== undefined ? body : JSON.stringify(body, null, 2);
  // Bound the body: a single shell step can capture 1 MB per stream, and both
  // sanitizeText and fitWidth scan character by character. Without this the
  // in-pi overlay re-scans megabytes on every 1s tick, on pi's TUI thread.
  const raws = (rendered ?? "null").split("\n");
  for (const raw of raws.slice(0, MAX_INSPECTOR_LINES)) {
    lines.push(fitWidth(`  ${sanitizeText(raw.slice(0, width * 2))}`, width));
  }
  if (raws.length > MAX_INSPECTOR_LINES) {
    lines.push(ansi.dim(`  … ${raws.length - MAX_INSPECTOR_LINES} more lines truncated`));
  }
  if (step.action) {
    const receipt = [
      step.action.actionType,
      step.action.command,
      ...(step.action.args ?? []),
      step.action.exitCode !== undefined ? `→ exit ${step.action.exitCode}` : "",
    ]
      .filter((part) => part !== undefined && part !== "")
      .join(" ");
    lines.push(fitWidth(ansi.dim(`  ${sanitizeText(receipt)}`), width));
  }
  return lines;
}

/**
 * Full-run detail view: header, graph pane, step timeline, inspector.
 * `scroll` shifts the viewport down over the full body; `selectedStepIndex`
 * scrubs the replay position (defaults to the latest step, i.e. live).
 * `hint` emits the inline key hint; hosts that pin their own footer pass false
 * so the two do not contradict each other.
 */
export function renderRunDetailLines(
  bundle: LoadedRunBundle,
  size: ViewportSize,
  now: Date = new Date(),
  scroll = 0,
  selectedStepIndex: number | null = null,
  hint = true,
): string[] {
  const state = bundle.state;
  const steps = state.steps;
  const selected = selectedStepIndex === null ? steps.length - 1 : selectedStepIndex;
  const lines: string[] = [];
  const title = state.runTitle ? ` — ${sanitizeText(state.runTitle)}` : "";
  lines.push(
    fitWidth(`${ansi.bold(`workflow ${sanitizeText(state.workflowName)}`)}${title}`, size.width),
  );
  const position =
    selectedStepIndex === null || steps.length === 0
      ? ""
      : ` · step ${Math.min(selected, steps.length - 1) + 1}/${steps.length}`;
  const paused = state.paused ? ` · ${ansi.yellow("paused")}` : "";
  lines.push(
    fitWidth(
      `${statusLabel(state.status)}${paused} · run ${state.runId} · elapsed ${formatDuration(runElapsedMs(state, now))}${position}`,
      size.width,
    ),
  );
  if (hint) {
    lines.push(ansi.dim("↑/↓ scroll · ←/→ replay steps · esc back"));
  }
  lines.push("");

  const graph = renderGraphLines(bundle, selected, now, { nodeStyle: "box" }).map((line) =>
    fitWidth(line, size.width),
  );
  if (graph.length > 0) {
    lines.push(...graph);
  } else {
    // No definition snapshot: fall back to a flat executed-node list.
    for (const nodeId of Object.keys(state.results)) {
      lines.push(nodeStatusLine(bundle, nodeId, size.width, now));
    }
  }

  if (steps.length > 0) {
    lines.push("");
    lines.push(ansi.bold("steps"));
    for (const [index, step] of steps.entries()) {
      lines.push(stepLine(step, index, Math.min(selected, steps.length - 1), size.width));
    }
    const inspected = steps[Math.min(Math.max(selected, 0), steps.length - 1)];
    if (inspected) {
      lines.push("");
      lines.push(
        ansi.bold(`step output — ${sanitizeText(inspected.nodeId)} (${inspected.outcome})`),
      );
      lines.push(...inspectorLines(inspected, size.width));
    }
  }

  if (state.error) {
    lines.push("");
    lines.push(fitWidth(ansi.red(`error: ${sanitizeText(state.error)}`), size.width));
  }
  if (state.status === "completed" && state.finalOutput !== undefined) {
    lines.push("");
    lines.push(
      fitWidth(
        `${ansi.bold("output")} ${previewValue(state.finalOutput, size.width - 8)}`,
        size.width,
      ),
    );
  }
  const start = Math.max(0, Math.min(scroll, lines.length - size.height));
  return lines.slice(start, start + size.height);
}

/** Highest useful `scroll` value for the detail view of `bundle`. */
export function maxDetailScroll(
  bundle: LoadedRunBundle,
  size: ViewportSize,
  selectedStepIndex: number | null = null,
  hint = true,
): number {
  const total = renderRunDetailLines(
    bundle,
    { width: size.width, height: Number.MAX_SAFE_INTEGER },
    new Date(),
    0,
    selectedStepIndex,
    hint,
  ).length;
  return Math.max(0, total - size.height);
}

/** Detail-view cursor: `selectedStep` null follows the latest step live. */
export type DetailNav = {
  scroll: number;
  selectedStep: number | null;
};

export type DetailNavKey = "up" | "down" | "left" | "right" | "pageUp" | "pageDown";

const NAV_DELTAS: Record<DetailNavKey, { scroll: number; step: number }> = {
  up: { scroll: -1, step: 0 },
  down: { scroll: 1, step: 0 },
  pageUp: { scroll: -1, step: 0 },
  pageDown: { scroll: 1, step: 0 },
  left: { scroll: 0, step: -1 },
  right: { scroll: 0, step: 1 },
};

/** Scroll/step delta for a navigation key, with paging scaled by `page`. */
export function navDelta(key: DetailNavKey, page: number): { scroll: number; step: number } {
  const delta = NAV_DELTAS[key];
  const scale = key === "pageUp" || key === "pageDown" ? page : 1;
  return { scroll: delta.scroll * scale, step: delta.step };
}

/**
 * Apply a navigation delta to the detail cursor. A zero delta renormalises
 * after new steps land, so a cursor scrubbed to the tail resumes following
 * live and the scroll offset is re-clamped against fresh content.
 */
export function moveDetailNav(
  nav: DetailNav,
  delta: { scroll: number; step: number },
  bounds: { maxScroll: number; stepCount: number },
): DetailNav {
  const { stepCount } = bounds;
  const base =
    delta.step === 0 ? nav.selectedStep : (nav.selectedStep ?? stepCount - 1) + delta.step;
  const selectedStep =
    base === null || stepCount === 0 || base >= stepCount - 1 ? null : Math.max(0, base);
  // Only a cursor that actually moved resets the scroll offset: stepping right
  // while already live, or left while already at step 0, must not jump the
  // reader back to the top. delta.scroll is 0 on step keys, so the clamp branch
  // is a no-op for them.
  const scroll =
    selectedStep === nav.selectedStep
      ? Math.max(0, Math.min(nav.scroll + delta.scroll, Math.max(0, bounds.maxScroll)))
      : 0;
  return { scroll, selectedStep };
}
