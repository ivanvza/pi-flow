# pi-flow

[![CI](https://github.com/ivanvza/pi-flow/actions/workflows/ci.yml/badge.svg)](https://github.com/ivanvza/pi-flow/actions/workflows/ci.yml)

pi-flow is a workflow extension for the [pi coding agent](https://pi.dev). You
define multi-step agent workflows as TypeScript graphs and trigger them from any
pi conversation with `/workflow`. Agent steps run inside your current
conversation, so the model keeps everything it already knows from the
discussion. It completes each step by calling a JSON `workflow` tool that hands
the engine structured, validated output to route on.

The workflow model is a port of
[openclaw/acpx](https://github.com/openclaw/acpx) flows into pi.

## Install

```bash
pi install git:github.com/ivanvza/pi-flow
```

Or try it without installing:

```bash
pi -e git:github.com/ivanvza/pi-flow
```

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

| Command                               | Effect                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `/workflow`                           | Arrow-key picker of discovered workflows, then an optional task prompt. |
| `/workflow runs`                      | Browse past runs in pi: pick a run, then a live detail view.            |
| `/workflow <name-or-path> [task]`     | Run it. Trailing text becomes `{ task: "..." }`, no text becomes `{}`.  |
| `/workflow <name> --input-json {...}` | Run with arbitrary JSON input.                                          |
| `/workflow pause`                     | Let the current step finish, then hold the run before the next node.    |
| `/workflow resume`                    | Continue, re-delivering the pending step prompt.                        |
| `/workflow cancel`                    | Abort the active run, or clear a leftover widget when no run is live.   |

Pressing escape to interrupt a turn pauses the workflow automatically, so the
run never nudges the model while you have taken the conversation back. The names
`cancel`, `list`, `pause`, `resume`, and `runs` cannot be used as workflow
names.

`presentationPrompt` is optional. When present, pi-flow uses it after the run
ends to request one normal, human-readable assistant response. Without it, a
workflow stays silent after its final structured output, which keeps shell-only
and machine-consumed workflows model-free.

## Watching a run

While a workflow runs, a widget above the editor draws the graph and the footer
shows a compact `wf <name> [status] <node>` indicator. The active node has a
heavy border, branches carry their case labels, the taken path is highlighted,
and loops route back through a right-hand gutter. Scroll a tall graph with
`shift+up` / `shift+down`.

`/workflow runs` opens a run browser inside pi: pick a run, scrub its steps with
`left` / `right`, and scroll the step output with `up` / `down`. This is the
quickest way to check on a run mid-session.

Runs also persist to `~/.pi/agent/workflows/runs/`, so a standalone viewer can
tail them from a second terminal, after pi exits, or in CI. Run it from a clone:

```bash
npx tsx src/viewer/cli.ts view          # live picker
npx tsx src/viewer/cli.ts view <runId>  # one run
npx tsx src/viewer/cli.ts runs          # list recent runs
npx tsx src/viewer/cli.ts view --once   # print a snapshot and exit
```

`npm install && npm run build && npm link` puts the same viewer on your PATH as
the `pi-flow` command.

## Node types

A workflow is a graph of named nodes with exactly one entry point. Each node
finishes with a JSON output, and edges decide what runs next.

| Helper                                             | What it does                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `agent({ prompt, expectedOutput })`                | Prompts the model in the live conversation; it submits via the `workflow` tool.                   |
| `compute({ run })`                                 | Pure local TypeScript function.                                                                   |
| `action({ run })`                                  | Side-effecting local TypeScript function.                                                         |
| `shell({ exec, parse })`                           | Runtime-owned shell command.                                                                      |
| `checkpoint({ summary })`                          | Parks the run `waiting` for a human. With an outgoing edge, `/workflow resume` continues past it. |
| `decision({ choices, question })` + `decisionEdge` | Constrained choice with compile-time case checking.                                               |

See [docs/workflows.md](docs/workflows.md) for the full authoring reference and
[docs/run-bundles.md](docs/run-bundles.md) for the on-disk run format.

## Bundled skill

Installing the package also installs the `pi-flow-authoring`
[skill](skills/pi-flow-authoring/SKILL.md), so asking pi to build or change a
workflow loads the authoring rules on demand. It carries short copyable snippets
(a minimal step, a decision branch, a review loop, a shell-only step) next to
the reference in [docs/workflows.md](docs/workflows.md).

## License

[MIT](LICENSE)
