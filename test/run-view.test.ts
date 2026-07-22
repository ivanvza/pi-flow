import { describe, expect, it } from "vitest";
import {
  moveDetailNav,
  navDelta,
  renderRunDetailLines,
  runListItems,
} from "../src/render/run-view.js";
import type { LoadedRunBundle } from "../src/workflows/store.js";
import type { WorkflowRunState, WorkflowStepRecord } from "../src/workflows/types.js";

const NOW = new Date("2026-07-19T00:01:00.000Z");

function makeBundle(overrides: Partial<WorkflowRunState> = {}): LoadedRunBundle {
  const state: WorkflowRunState = {
    runId: "run-1",
    workflowName: "demo",
    startedAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:30.000Z",
    status: "completed",
    input: {},
    outputs: {},
    results: {},
    steps: [],
    ...overrides,
  };
  return {
    runDir: `/tmp/${state.runId}`,
    manifest: {
      schema: "pi-workflows.run-bundle.v1",
      runId: state.runId,
      workflowName: state.workflowName,
      startedAt: state.startedAt,
      status: state.status,
      traceSchema: "pi-workflows.trace-event.v1",
      paths: { workflow: "workflow.json", state: "state.json", trace: "trace.ndjson" },
    },
    state,
    snapshot: null,
  };
}

describe("navDelta", () => {
  it("maps each key to a scroll/step delta", () => {
    expect(navDelta("up", 10)).toEqual({ scroll: -1, step: 0 });
    expect(navDelta("down", 10)).toEqual({ scroll: 1, step: 0 });
    expect(navDelta("pageUp", 10)).toEqual({ scroll: -10, step: 0 });
    expect(navDelta("pageDown", 10)).toEqual({ scroll: 10, step: 0 });
    expect(navDelta("left", 10)).toEqual({ scroll: 0, step: -1 });
    expect(navDelta("right", 10)).toEqual({ scroll: 0, step: 1 });
  });

  it("scales paging by the page size", () => {
    expect(navDelta("pageUp", 12).scroll).toBe(-12);
    expect(navDelta("pageDown", 12).scroll).toBe(12);
  });
});

describe("moveDetailNav", () => {
  const bounds = { maxScroll: 8, stepCount: 4 };

  it("clamps scroll to 0 and maxScroll", () => {
    expect(
      moveDetailNav({ scroll: 0, selectedStep: null }, { scroll: -5, step: 0 }, bounds).scroll,
    ).toBe(0);
    expect(
      moveDetailNav({ scroll: 6, selectedStep: null }, { scroll: 99, step: 0 }, bounds).scroll,
    ).toBe(8);
  });

  it("resolves a live cursor to the last step on the first left", () => {
    const next = moveDetailNav({ scroll: 5, selectedStep: null }, { scroll: 0, step: -1 }, bounds);
    expect(next.selectedStep).toBe(2);
  });

  it("snaps back to live at the tail", () => {
    const next = moveDetailNav({ scroll: 0, selectedStep: 2 }, { scroll: 0, step: 1 }, bounds);
    expect(next.selectedStep).toBeNull();
  });

  it("is a no-op stepping right while live", () => {
    const next = moveDetailNav({ scroll: 6, selectedStep: null }, { scroll: 0, step: 1 }, bounds);
    expect(next).toEqual({ scroll: 6, selectedStep: null });
  });

  it("floors the step cursor at 0", () => {
    const next = moveDetailNav({ scroll: 6, selectedStep: 0 }, { scroll: 0, step: -1 }, bounds);
    expect(next).toEqual({ scroll: 6, selectedStep: 0 });
  });

  it("resets scroll when the step changes", () => {
    const next = moveDetailNav({ scroll: 7, selectedStep: 3 }, { scroll: 0, step: -1 }, bounds);
    expect(next.scroll).toBe(0);
  });

  it("yields a null cursor when there are no steps", () => {
    const next = moveDetailNav(
      { scroll: 0, selectedStep: null },
      { scroll: 0, step: -1 },
      { maxScroll: 0, stepCount: 0 },
    );
    expect(next.selectedStep).toBeNull();
  });

  it("renormalises a stale cursor with a zero delta", () => {
    const next = moveDetailNav(
      { scroll: 0, selectedStep: 3 },
      { scroll: 0, step: 0 },
      { maxScroll: 4, stepCount: 3 },
    );
    expect(next.selectedStep).toBeNull();
  });
});

describe("runListItems", () => {
  it("carries runDir, glyph, runId and elapsed", () => {
    const items = runListItems([makeBundle({ finishedAt: "2026-07-19T00:00:45.000Z" })], NOW);
    expect(items).toHaveLength(1);
    expect(items[0]?.value).toBe("/tmp/run-1");
    expect(items[0]?.label).toBe("✓ demo");
    expect(items[0]?.description).toBe("run-1 · 45s");
  });

  it("sanitizes a run title containing escape sequences", () => {
    const items = runListItems([makeBundle({ runTitle: "ship \u001b[31mit\nnow" })], NOW);
    expect(items[0]?.label).toBe("\u2713 demo \u2014 ship it now");
    expect(items[0]?.label).not.toContain("\u001b");
    expect(items[0]?.label).not.toContain("\n");
  });
});

describe("renderRunDetailLines", () => {
  const SIZE = { width: 80, height: 200 };

  it("omits the inline key hint when the host pins its own", () => {
    const bundle = makeBundle();
    expect(renderRunDetailLines(bundle, SIZE, NOW).join("\n")).toContain("replay steps");
    expect(renderRunDetailLines(bundle, SIZE, NOW, 0, null, false).join("\n")).not.toContain(
      "replay steps",
    );
  });

  it("bounds a huge step body instead of scanning it whole", () => {
    const step: WorkflowStepRecord = {
      attemptId: "attempt-1",
      nodeId: "build",
      nodeType: "action",
      outcome: "ok",
      startedAt: "2026-07-19T00:00:00.000Z",
      finishedAt: "2026-07-19T00:00:01.000Z",
      promptText: null,
      output: null,
    };
    // A JSON body arrives as one enormous line; an error body arrives as many.
    const wide = renderRunDetailLines(
      makeBundle({ steps: [{ ...step, output: { log: "x".repeat(500_000) } }] }),
      { width: 80, height: 5_000 },
      NOW,
    );
    expect(Math.max(...wide.map((line) => line.length))).toBeLessThan(500);

    const tall = renderRunDetailLines(
      makeBundle({
        steps: [{ ...step, outcome: "failed", error: "boom\n".repeat(50_000) }],
      }),
      { width: 80, height: 5_000 },
      NOW,
    );
    expect(tall.join("\n")).toContain("more lines truncated");
    expect(tall.length).toBeLessThan(300);
  });
});
