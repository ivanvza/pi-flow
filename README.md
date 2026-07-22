# pi-flow

pi-flow is a workflow extension for the [pi coding agent](https://pi.dev).
It lets you define multi-step agent workflows as TypeScript graphs, trigger
them at any point in a pi conversation with `/workflow`, and watch them run
live in a standalone terminal viewer.

The workflow model is a port of [openclaw/acpx](https://github.com/openclaw/acpx)
flows into pi itself. Agent steps run inside your current pi conversation, so
the model keeps everything it already knows from the discussion. The model
completes each step by calling a JSON `workflow` tool, which gives the engine
structured, validated output to route on.

## Install

```bash
pi install git:github.com/ivanvza/pi-flow
```

Or try it without installing:

```bash
pi -e git:github.com/ivanvza/pi-flow
```

The `pi-flow` viewer binary is part of the same package. To get it on
your PATH, clone the repo and run `npm install && npm run build && npm link`,
or run it in place with `npx tsx src/viewer/cli.ts`.

## Quick start

Put a workflow file in `.pi/workflows/` (project) or `~/.pi/agent/workflows/`
(global):

```typescript
// .pi/workflows/echo.workflow.ts
import { agent, defineWorkflow } from "pi-flow";

export default defineWorkflow({
  name: "echo",
  presentationPrompt: "Give the user the concise reply from the workflow result.",
  startAt: "reply",
  nodes: {
    reply: agent({
      prompt: ({ input }) => `Answer concisely: ${(input as { task?: string }).task}`,
      expectedOutput: `{ "reply": "your concise answer" }`,
    }),
  },
  edges: [],
});
```

Then, from any pi conversation:

```
/workflow echo summarize this repository
```

| Command                             | Effect                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `/workflow`                         | Arrow-key picker of discovered workflows, then an optional task prompt. |
| `/workflow runs`                    | Browse run bundles in pi: pick a run, then a live detail view.          |
| `/workflow <name-or-path> [task]`   | Run it. Trailing text becomes `{ task: "..." }`, no text becomes `{}`.  |
| `/workflow <name> --input-json {…}` | Run with arbitrary JSON input.                                          |
| `/workflow pause`                   | Let the current step finish, then hold the run before the next node.    |
| `/workflow resume`                  | Continue, re-delivering the pending step prompt.                        |
| `/workflow cancel`                  | Abort the active run, or clear a leftover widget when no run is live.   |

Pressing escape to interrupt a turn pauses the workflow automatically, so the
run never nudges the model while you have taken the conversation back. The
names `cancel`, `list`, `pause`, `resume`, and `runs` are rejected as workflow
names.

While a run is on screen, the footer status bar shows a compact
`wf <name> [status] <node>` indicator alongside the widget.

`presentationPrompt` is optional. When present, pi-flow uses it after the
structured run ends to request one normal, human-readable assistant response.
Workflows without it remain silent after their final structured output, which
keeps shell-only and machine-consumed workflows model-free.

Because the workflow runs in your current conversation, you can discuss a
problem at length and then trigger a workflow that builds on it — see the
`elegant-solution` example.

## Watching a run

`/workflow runs` browses runs from inside pi and is the quickest way to check
on one mid-session. The standalone `pi-flow view` binary remains for a
second terminal, after pi exits, or in CI, and does not require pi to be
installed.

Runs persist to `~/.pi/agent/workflows/runs/` as they execute. The viewer
tails that directory and re-renders on every state change:

```bash
pi-flow view          # interactive picker, live updates
pi-flow view <runId>  # jump straight to one run
pi-flow runs          # plain list of recent runs
pi-flow view --once   # print a snapshot and exit (good for scripts)
```

The run detail view draws the workflow as a boxed graph, like the acpx replay
viewer: every node sits in a box (heavy border for the active node), branches
carry their case labels, the taken path is highlighted, and loops route
through a gutter on the right back into their target from above. `←/→` scrubs
backwards and forwards through the recorded steps and re-derives every node's
status as of that step, with the selected step's full output shown below;
scrubbing to the end snaps back to following the run live. Escape goes back to
the run list rather than quitting.

```
              │ ┌──────────────────┐
              ▼ ▼                  │
  ┌──────────────────────────┐     │
  │ ✓ verify [action] 8.0s ×2 │    │
  └──────────────────────────┘     │
              │                    │
              ▼                    │
  ┏━━━━━━━━━━━━━━━━━━━━━━━━━━┓     │
  ┃ ◐ review [agent] 12s ×2  ┃     │
  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━┛     │
     ┌─ clean ─┘ └─ issues ─┐      │
     ▼                      ▼      │
┌───────────┐    ┌───────────────┐ │
│ · done    │    │ ✓ fix [agent] │ │
└───────────┘    └───────────────┘ │
                        └──────────┘
```

Inside pi, a widget above the editor shows the same boxed graph while a
workflow is running, windowed around the active node when it is taller than
pi's widget budget. Scroll the window with `shift+↑` / `shift+↓`; it snaps back
to following the active node whenever the workflow advances a step.

## Node types

A workflow is a graph of named nodes with exactly one entry point. Each node
finishes with a JSON output, and edges decide what runs next.

| Helper                                             | What it does                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `agent({ prompt, expectedOutput })`                | Prompts the model in the live conversation; it submits via the `workflow` tool.                   |
| `compute({ run })`                                 | Pure local TypeScript function.                                                                   |
| `action({ run })`                                  | Side-effecting local TypeScript function.                                                         |
| `shell({ exec, parse })`                           | Runtime-owned shell command.                                                                      |
| `checkpoint({ summary })`                          | Parks the run `waiting` for a human; with an outgoing edge, `/workflow resume` continues past it. |
| `decision({ choices, question })` + `decisionEdge` | Constrained choice with compile-time case checking.                                               |

See [docs/workflows.md](docs/workflows.md) for the full authoring reference
and [docs/run-bundles.md](docs/run-bundles.md) for the on-disk run format.

## Bundled skill

Installing the package also installs the `pi-flow-authoring`
[skill](skills/pi-flow-authoring/SKILL.md), so asking pi to build or
change a workflow gets it the authoring rules on demand without you pointing
at the docs. Skills load from the package manifest, so a directory-shaped
source is required: `pi -e .` picks them up, `pi -e ./src/extension/index.ts`
loads the extension alone.

## Examples

Short, copyable snippets — a minimal step, a decision branch, a review loop
that routes back on `revise`, and a shell-only step — live in the
[`pi-flow-authoring` skill](skills/pi-flow-authoring/SKILL.md), next
to the full authoring reference in [docs/workflows.md](docs/workflows.md).

## License

[MIT](LICENSE)
