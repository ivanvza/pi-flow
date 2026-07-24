import { DynamicBorder, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, SelectList, Text } from "@earendil-works/pi-tui";
import type { Component, KeyId, SelectItem, TUI } from "@earendil-works/pi-tui";
import {
  type DetailNav,
  type DetailNavKey,
  maxDetailScroll,
  moveDetailNav,
  navDelta,
  renderRunDetailLines,
} from "../render/run-view.js";
import { readRunBundle } from "../workflows/store.js";
import type { LoadedRunBundle } from "../workflows/store.js";

// Keep in sync with the maxHeight values below. `SizeValue` is the literal
// template type `number | `${number}%``, so the percentage string cannot be
// computed from the ratio without widening to `string`. pi truncates an
// overlay from the tail, so a component that emits more rows than its own
// maxHeight silently loses its closing border, its hint, and its cursor.
const DETAIL_HEIGHT_RATIO = 0.8;
const PICKER_HEIGHT_RATIO = 0.7;

const PICKER_OVERLAY = { anchor: "center", width: "60%", minWidth: 40, maxHeight: "70%" } as const;
const DETAIL_OVERLAY = { anchor: "center", width: "90%", minWidth: 40, maxHeight: "80%" } as const;

const NAV_KEYS: readonly (readonly [KeyId, DetailNavKey])[] = [
  ["up", "up"],
  ["down", "down"],
  ["pageUp", "pageUp"],
  ["pageDown", "pageDown"],
  ["left", "left"],
  ["right", "right"],
];

/**
 * Framed native picker over `items`. Resolves the chosen `value`, or null when
 * the user cancels or no terminal UI is available.
 */
export async function pickFromList(
  ctx: ExtensionCommandContext,
  title: string,
  items: SelectItem[],
  selectedIndex = 0,
): Promise<string | null> {
  try {
    const picked = await ctx.ui.custom<string | null>(
      (tui, theme, _keybindings, done) => {
        const rule = () => new DynamicBorder((s: string) => theme.fg("border", s));
        const container = new Container();
        container.addChild(rule());
        container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
        // Budget against the overlay's own maxHeight, less the chrome the
        // container emits: 2 rules + title + hint + SelectList's "(n/m)" row.
        // The 3-row floor below deliberately wins on a terminal under ~12 rows,
        // where honouring the budget would leave a 2-item picker; that clips
        // the closing rule but never the cursor, which SelectList windows.
        const budget = Math.floor(tui.terminal.rows * PICKER_HEIGHT_RATIO) - 5;
        const list = new SelectList(
          items,
          Math.min(items.length, Math.max(3, budget)),
          getSelectListTheme(),
        );
        list.setSelectedIndex(selectedIndex);
        list.onSelect = (item) => done(item.value);
        list.onCancel = () => done(null);
        container.addChild(list);
        container.addChild(
          new Text(theme.fg("dim", "↑↓ navigate · enter select · esc cancel"), 1, 0),
        );
        container.addChild(rule());
        return {
          render: (width: number) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            list.handleInput(data);
            tui.requestRender();
          },
        };
      },
      { overlay: true, overlayOptions: PICKER_OVERLAY },
    );
    // custom() resolves undefined outside tui mode without running the factory.
    return picked ?? null;
  } catch {
    // Stale ctx; there is no overlay to show.
    return null;
  }
}

/**
 * Live run detail view. Emits pre-rendered ANSI rows straight out of render()
 * rather than through Text, which word-wraps and would mangle the box graph.
 */
class RunDetail implements Component {
  private bundle: LoadedRunBundle | null = null;
  /** False until the first read settles, so a slow load is not reported as a
   * deleted run. */
  private loaded = false;
  private nav: DetailNav = { scroll: 0, selectedStep: null };
  private disposed = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private tui: TUI,
    private theme: Theme,
    private runDir: string,
    private done: (result: null) => void,
  ) {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 1_000);
    this.timer.unref?.();
  }

  /** render() emits exactly this many body rows plus 2 rules and 1 hint, so
   * the total matches maxHeight and pi's tail truncation cannot eat the
   * closing rule. */
  private bodyHeight(): number {
    return Math.max(3, Math.floor(this.tui.terminal.rows * DETAIL_HEIGHT_RATIO) - 3);
  }

  private bounds(width: number): { maxScroll: number; stepCount: number } {
    if (!this.bundle) {
      return { maxScroll: 0, stepCount: 0 };
    }
    // ponytail: maxDetailScroll re-renders the whole body, which is fine at one
    // call per keypress and per second for a body of this size. Upgrade path:
    // cache it against (bundle, width, selectedStep).
    return {
      maxScroll: maxDetailScroll(
        this.bundle,
        { width, height: this.bodyHeight() },
        this.nav.selectedStep,
        false,
      ),
      stepCount: this.bundle.state.steps.length,
    };
  }

  private async refresh(): Promise<void> {
    const bundle = await readRunBundle(this.runDir);
    // dispose() runs after this promise resolves and its throws are swallowed,
    // so the flag is what actually closes the race.
    if (this.disposed) {
      return;
    }
    this.bundle = bundle;
    this.loaded = true;
    this.nav = moveDetailNav(
      this.nav,
      { scroll: 0, step: 0 },
      this.bounds(this.tui.terminal.columns),
    );
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.done(null);
      return;
    }
    const hit = NAV_KEYS.find(([keyId]) => matchesKey(data, keyId));
    if (!hit) {
      // Deliberately no repaint on keys this view ignores.
      return;
    }
    this.nav = moveDetailNav(
      this.nav,
      navDelta(hit[1], Math.max(1, this.bodyHeight() - 1)),
      this.bounds(this.tui.terminal.columns),
    );
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const height = this.bodyHeight();
    const rule = new DynamicBorder((s: string) => this.theme.fg("border", s)).render(width);
    // The frame pins its own hint below, so the body suppresses the inline one.
    const body = this.bundle
      ? renderRunDetailLines(
          this.bundle,
          { width, height },
          new Date(),
          this.nav.scroll,
          this.nav.selectedStep,
          false,
        )
      : [
          this.theme.fg(
            "dim",
            this.loaded ? "Run bundle unavailable — esc to go back" : "Loading…",
          ),
        ];
    const pad = Array.from({ length: Math.max(0, height - body.length) }, () => "");
    return [
      ...rule,
      ...body,
      ...pad,
      this.theme.fg("dim", " esc back · ↑/↓ scroll · PgUp/PgDn page · ←/→ steps"),
      ...rule,
    ];
  }

  invalidate(): void {
    // Nothing is cached; all themed output is computed fresh in render().
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.timer = null;
  }
}

/** Open the live detail overlay for one run. Returns when the user goes back. */
export async function showRunDetail(ctx: ExtensionCommandContext, runDir: string): Promise<void> {
  // ponytail: the detail body keeps src/render's own 16-colour palette rather
  // than the pi theme, because src/render is pi-agnostic (it may import only
  // src/workflows) and has no pi Theme; only the frame, title and hint are
  // themed. Upgrade path: thread a colour-fn adapter through graph-render.ts.
  try {
    await ctx.ui.custom<null>(
      (tui, theme, _keybindings, done) => new RunDetail(tui, theme, runDir, done),
      { overlay: true, overlayOptions: DETAIL_OVERLAY },
    );
  } catch {
    // Stale ctx; there is no overlay to show.
  }
}
