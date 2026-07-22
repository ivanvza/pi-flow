import readline from "node:readline";
import {
  type DetailNav,
  maxDetailScroll,
  moveDetailNav,
  navDelta,
  renderRunDetailLines,
  renderRunListLines,
  type ViewportSize,
} from "../render/run-view.js";
import { listRunBundles, readRunBundle } from "../workflows/store.js";
import type { LoadedRunBundle } from "../workflows/store.js";
import { watchRunsDir } from "./watch.js";

const ALT_SCREEN_ON = "\u001b[?1049h\u001b[?25l";
const ALT_SCREEN_OFF = "\u001b[?25h\u001b[?1049l";
const CLEAR = "\u001b[2J\u001b[H";

type ViewerMode = { view: "list" } | { view: "detail"; runDir: string };

export type ViewerOptions = {
  runsDir: string;
  runId?: string | undefined;
  /** Redraw interval for elapsed timers while a run is active. */
  tickMs?: number;
};

function viewportSize(): ViewportSize {
  return {
    width: process.stdout.columns ?? 80,
    height: process.stdout.rows ?? 24,
  };
}

/**
 * Interactive live viewer. Watches the runs directory and re-renders as run
 * bundles change on disk. Returns when the user quits.
 */
export async function runViewer(options: ViewerOptions): Promise<void> {
  let mode: ViewerMode = { view: "list" };
  let bundles: LoadedRunBundle[] = [];
  let selectedIndex = 0;
  /** Scroll offset plus replay position; `selectedStep` null follows live. */
  let nav: DetailNav = { scroll: 0, selectedStep: null };
  let detailBounds = { maxScroll: 0, stepCount: 0 };

  if (options.runId) {
    bundles = await listRunBundles(options.runsDir);
    const match = bundles.find((bundle) => bundle.state.runId === options.runId);
    if (!match) {
      throw new Error(`Run not found: ${options.runId}`);
    }
    mode = { view: "detail", runDir: match.runDir };
  }

  const draw = async () => {
    bundles = await listRunBundles(options.runsDir);
    selectedIndex = Math.min(selectedIndex, Math.max(0, bundles.length - 1));
    const size = viewportSize();
    const lines =
      mode.view === "list"
        ? renderRunListLines(bundles, selectedIndex, size)
        : await renderDetail(mode.runDir, size);
    process.stdout.write(CLEAR + lines.join("\n"));
  };

  const renderDetail = async (runDir: string, size: ViewportSize): Promise<string[]> => {
    const bundle = await readRunBundle(runDir);
    if (!bundle) {
      return ["Run bundle disappeared. Press q to go back."];
    }
    // Renormalise against fresh content: a cursor scrubbed to the tail snaps
    // back to live and the scroll offset is re-clamped.
    detailBounds = {
      maxScroll: maxDetailScroll(bundle, size, nav.selectedStep),
      stepCount: bundle.state.steps.length,
    };
    nav = moveDetailNav(nav, { scroll: 0, step: 0 }, detailBounds);
    return renderRunDetailLines(bundle, size, new Date(), nav.scroll, nav.selectedStep);
  };

  process.stdout.write(ALT_SCREEN_ON);
  const stopWatching = watchRunsDir(options.runsDir, () => {
    void draw();
  });
  const ticker = setInterval(() => {
    void draw();
  }, options.tickMs ?? 1_000);

  const rawModeSupported = process.stdin.isTTY === true;
  if (rawModeSupported) {
    process.stdin.setRawMode(true);
  }
  // Keypress events only fire on a decoded stream; raw mode stays because the
  // terminal must not line-buffer.
  readline.emitKeypressEvents(process.stdin);
  process.stdin.resume();

  type Keypress = { name?: string; ctrl?: boolean };
  let onKeypress: (str: string, key: Keypress) => void = () => {};

  try {
    await new Promise<void>((resolve) => {
      onKeypress = (_str, key) => {
        const name = key.name ?? "";
        // Raw mode suppresses SIGINT, so ctrl+c is only what this handler makes
        // it. It must always quit, from any view.
        if (key.ctrl && name === "c") {
          resolve();
          return;
        }
        if (name === "q" || name === "escape") {
          // Leaving the detail view returns to the run list, matching the
          // in-pi overlay; from the list these quit.
          if (mode.view === "detail") {
            mode = { view: "list" };
            void draw();
            return;
          }
          resolve();
          return;
        }
        if (mode.view === "detail") {
          if (name === "up" || name === "down" || name === "left" || name === "right") {
            nav = moveDetailNav(nav, navDelta(name, 1), detailBounds);
            void draw();
          }
          return;
        }
        if (name === "up") {
          selectedIndex = Math.max(0, selectedIndex - 1);
          void draw();
        } else if (name === "down") {
          selectedIndex = Math.min(Math.max(0, bundles.length - 1), selectedIndex + 1);
          void draw();
        } else if (name === "return") {
          const selected = bundles[selectedIndex];
          if (selected) {
            mode = { view: "detail", runDir: selected.runDir };
            nav = { scroll: 0, selectedStep: null };
            void draw();
          }
        }
      };

      process.stdin.on("keypress", onKeypress);
      void draw();
    });
  } finally {
    clearInterval(ticker);
    stopWatching();
    process.stdin.off("keypress", onKeypress);
    if (rawModeSupported) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
    process.stdout.write(ALT_SCREEN_OFF);
  }
}
