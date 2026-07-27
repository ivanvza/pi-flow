# Workflow authoring reference

This document is the authoring reference for pi-flow definitions. It
covers the file format, every node type, edge routing, the step contract the
model sees, and how runs behave at runtime. For the on-disk run format, see
[run-bundles.md](run-bundles.md).

## Workflow files

A workflow is a TypeScript module whose default export is `defineWorkflow(...)`.
Files are discovered by suffix (`.workflow.ts`, `.workflow.js`, `.workflow.mts`,
`.workflow.mjs`) from two directories, in precedence order:

1. `.pi/workflows/` in the project (highest precedence on name collisions)
2. `~/.pi/agent/workflows/` globally

The workflow's command name is the file stem, so `.pi/workflows/triage.workflow.ts`
runs as `/workflow triage`. A direct path also works: `/workflow ./somewhere/x.workflow.ts`.
Files are loaded with [jiti](https://github.com/unjs/jiti), so plain TypeScript
works without a build step, and `import ... from "pi-flow"` resolves to
the engine that loaded the file.

```typescript
import { agent, compute, defineWorkflow } from "pi-flow";

export default defineWorkflow({
  name: "example",
  title: ({ input }) => `example: ${(input as { task?: string }).task}`,
  presentationPrompt: "Present the final answer clearly and concisely.",
  startAt: "ask",
  maxSteps: 50,
  nodes: {
    ask: agent({
      prompt: ({ input }) => `Answer: ${(input as { task?: string }).task}`,
      expectedOutput: `{ "answer": "text" }`,
    }),
    finish: compute({ run: ({ outputs }) => outputs.ask }),
  },
  edges: [{ from: "ask", to: "finish" }],
});
```

Top-level fields:

| Field                | Type                   | Notes                                                                                                                                                                                                              |
| -------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`               | `string`               | Required. Used in run ids and the step contract. `cancel`, `list`, `pause`, `resume`, and `runs` are reserved for `/workflow` subcommands.                                                                         |
| `title`              | `string` or function   | Optional run title, resolved once at start from `{ input, workflowName }`. Async resolution is bounded (30s) and cancellable.                                                                                      |
| `presentationPrompt` | `string` or function   | Optional instructions for a normal assistant response after the run. A function receives `{ state, finalOutput, signal }` and may return a prompt or `undefined`. See [Result presentation](#result-presentation). |
| `startAt`            | `string`               | Required. Id of the first node.                                                                                                                                                                                    |
| `nodes`              | `Record<string, node>` | Required, non-empty. Node ids must match `[A-Za-z_][A-Za-z0-9_-]*`.                                                                                                                                                |
| `edges`              | `WorkflowEdge[]`       | Required. See routing below.                                                                                                                                                                                       |
| `maxSteps`           | `number`               | Optional loop bound, default 100. The run fails when exceeded.                                                                                                                                                     |

`defineWorkflow` validates the shape eagerly (node ids, edge shapes, function
fields) and validates the graph (unknown targets, duplicate outgoing edges,
unreachable nodes) when a run starts.

## Node context

Every node callback receives the same context object:

```typescript
type WorkflowNodeContext = {
  input: unknown; // the run input
  outputs: Record<string, unknown>; // accepted output per finished node id
  results: Record<string, WorkflowNodeResult>; // full result records, including failures
  state: WorkflowRunState; // the live run state (read-only by convention)
  signal: AbortSignal; // aborted on node timeout or run cancellation
};
```

`outputs` only contains nodes that finished with outcome `ok`. When a node runs
more than once (a loop), the latest result wins. A failed retry removes the
node's earlier output from `outputs`.

Every value crossing the engine boundary — the run input, every node output,
and every accepted step output — must survive a JSON round-trip
(`JSON.parse(JSON.stringify(x))` deep-equality), or the node fails. Use plain
JSON values only: no `Date`, `Map`, `Set`, class instances, `NaN`/`Infinity`,
or `undefined` object properties. A node that returns `undefined` is
normalized to `null`.

Long-running compute, action, and checkpoint callbacks should observe
`context.signal` (pass it to `fetch`/`spawn`, or check `signal.aborted` between
steps). When the node times out or the run is cancelled, the engine stops
waiting immediately, but only cooperative callbacks stop doing work.

## Node types

### agent

Sends a prompt into the current pi conversation and waits for the model to
submit output through the `workflow` tool.

```typescript
agent({
  prompt: ({ outputs }) => `Review this: ${JSON.stringify(outputs.implement)}`,
  expectedOutput: `{ "verdict": "clean" | "issues_found" }`,
  validate: (output) => output, // optional; throw to reject the submission
  timeoutMs: 30 * 60_000, // optional; default 15 minutes
  statusDetail: "reviewing", // optional; shown in widget and viewer
});
```

The engine appends a step contract to the prompt (see below). When the model
calls the tool, the output passes through normalization (a JSON string is
parsed tolerantly), a key check, and then `validate`. When `expectedOutput` is
written as a JSON object (the convention above), its top-level keys are
enforced: a submission missing any of them is rejected with the missing keys
named, so a model that returns the wrong shape (for example an earlier step's
`{route, reason}`) is corrected at this node instead of poisoning a later one.
Only key presence is checked, so the value hints stay freeform; a non-JSON
`expectedOutput` enforces nothing. If `validate` throws, the model can retry
within the same step. If the agent ends its turn without submitting, the
extension nudges it, twice by default, then fails the step.

### compute

Runs a TypeScript function inline. Use it for pure data shaping.

```typescript
compute({ run: ({ outputs }) => ({ merged: { ...outputs } }) });
```

### action

Performs a side effect. Two forms exist. The function form runs arbitrary
TypeScript:

```typescript
action({ run: async ({ input }) => await deployPreview(input) });
```

The shell form (`shell` is a synonym that requires `exec`) runs a command owned
by the runtime, so the workflow author decides exactly what executes, with a
timeout and captured output:

```typescript
shell({
  exec: ({ input }) => ({
    command: "git",
    args: ["status", "--porcelain"],
    cwd: "/path/to/repo",
    env: { GIT_PAGER: "cat" },
    timeoutMs: 10_000,
  }),
  parse: (result) => ({ dirty: result.stdout.trim().length > 0 }),
});
```

| `exec` field       | Type                     | Default                                                             |
| ------------------ | ------------------------ | ------------------------------------------------------------------- |
| `command`          | `string`                 | Required.                                                           |
| `args`             | `string[]`               | `[]`                                                                |
| `cwd`              | `string`                 | `process.cwd()`                                                     |
| `env`              | `Record<string, string>` | Merged over `process.env`.                                          |
| `stdin`            | `string`                 | None.                                                               |
| `shell`            | `boolean \| string`      | `false`                                                             |
| `allowNonZeroExit` | `boolean`                | `false`; a non-zero exit or a kill signal otherwise fails the node. |
| `timeoutMs`        | `number`                 | None; the node-level `timeoutMs` still applies.                     |
| `maxOutputChars`   | `number`                 | `1_000_000`, per stream, so verbose commands cannot exhaust memory. |

Without `parse`, the node output is the full `ShellActionResult` (`command`,
`args`, `cwd`, `stdout`, `stderr`, `exitCode`, `signal`, `durationMs`). Both
action forms record a receipt (command, exit code, duration) in the step
record for auditability, including when the command fails.

### checkpoint

Records a `waiting` state for human review. What happens next depends on
whether the checkpoint declares an outgoing edge.

```typescript
checkpoint({
  summary: "human decides how to proceed",
  run: ({ outputs }) => outputs.reconcile, // optional; default output is { summary }
});
```

**No outgoing edge — terminal.** The run ends as `waiting` and the checkpoint
output is the run's final output. This is the default and the behavior a bare
`checkpoint({})` at the end of a graph has always had.

**An outgoing edge — resumable.** The run parks: status is `waiting`,
`waitingOn` names the checkpoint, and the run loop holds. `/workflow resume`
continues it through that edge, `/workflow cancel` stops it. The next node
reads the checkpoint's output from `outputs.<checkpointId>`, and a `switch`
edge routes on the checkpoint's own output, so a human decision can pick the
branch:

```typescript
defineWorkflow({
  name: "review-then-publish",
  startAt: "draft",
  nodes: {
    draft: agent({ prompt: () => "Draft the post", expectedOutput: `{ "post": "text" }` }),
    review: checkpoint({ run: ({ outputs }) => ({ decision: "approve", draft: outputs.draft }) }),
    publish: compute({ run: ({ outputs }) => ({ published: outputs.review }) }),
    revise: agent({ prompt: () => "Revise the draft", expectedOutput: `{ "post": "text" }` }),
  },
  edges: [
    { from: "draft", to: "review" },
    {
      from: "review",
      switch: { on: "$.decision", cases: { approve: "publish", reject: "revise" } },
    },
  ],
});
```

Four things are worth knowing about a resumable park:

- **Resume is in-session only.** The hold lives in the engine instance, so
  quitting pi abandons the run. Its bundle stays `waiting` with no `finishedAt`,
  which readers should treat as abandoned rather than finished.
- **No presentation turn fires at the park.** `presentationPrompt` still runs
  for terminal checkpoints and at real completion; a resumable park emits a
  notification naming both commands instead.
- **`maxSteps` is a whole-run budget** and spans the park, so a resumed run
  keeps counting from where it stopped rather than restarting its budget.
- **A malformed `switch` edge out of a checkpoint fails the run** instead of
  parking a run that could never route anywhere, because the next node is
  resolved before the park is entered.

A checkpoint may still declare only one outgoing edge; the usual
multiple-outgoing-edges rule applies to it like any other node.

### decision

`decision` is sugar over `agent` for constrained choices. It builds the prompt
suffix listing the choices, sets `expectedOutput`, and validates that the
submitted object carries one of the allowed values in the decision field
(default `route`).

```typescript
const choices = ["y", "n"] as const;

decision({
  choices,
  question: ({ outputs }) => `Same as proposed? ${JSON.stringify(outputs.propose)}`,
  field: "route", // optional; default "route", must match /^[A-Za-z_][A-Za-z0-9_]*$/
});
```

Pair it with `decisionEdge`, which builds the matching `switch` edge and makes
a missing case a compile-time error:

```typescript
decisionEdge({ from: "compare", choices, cases: { y: "implement", n: "reconcile" } });
```

`decision` accepts the other `agent` options (`timeoutMs`, `statusDetail`) but
owns `prompt`, `expectedOutput`, and `validate`. Pass the same `field` to both
`decision` and `decisionEdge`, or the edge reads the wrong path. Validation
only guarantees that the submitted object carries an allowed value in that
field; the `reason` the prompt asks for is not enforced.

## Edges and routing

Each node has at most one outgoing edge. A plain edge is unconditional:

```typescript
{ from: "a", to: "b" }
```

A `switch` edge routes on a JSON path evaluated against the node's output (or
its result record, with `$result.`):

```typescript
{ from: "review", switch: { on: "$.route", cases: { clean: "done", issues_found: "fix" } } }
```

Path roots:

- `$.field` and `$output.field` read from the node's accepted output.
- `$result.field` reads from the result record. `$result.outcome` is the main
  use, with values `ok`, `failed`, `timed_out`, or `cancelled`, which lets a
  workflow route failures to a recovery node instead of failing the run.

`defineWorkflow` rejects a `switch.on` that does not start with one of these
prefixes, and rejects an empty `cases` map. The resolved value must be a
scalar (string, number, or boolean); routing on an object or array fails the
run.

A missing case for the resolved value fails the run with a routing error. A
node with no outgoing edge (or no matching failure route) ends the run:
`completed` on success, `failed`/`timed_out`/`cancelled` otherwise.

## The step contract

The engine appends a contract block to every `agent` prompt naming the
workflow and the step, quoting `expectedOutput` verbatim (default: `a JSON
object with your result`), and instructing the model to call the `workflow`
tool exactly once with `{"output"}`. `expectedOutput` is the only part of it a
workflow controls.

The `workflow` tool takes `{ output }` only — the model supplies no step or
attempt id, so there is nothing to mislabel; the output targets the single
pending step. Submissions are rejected (with a reason the model sees) when no
step is pending, `validate` throws, or the output is a byte-for-byte copy of
the previous step's output (a model re-emitting its last answer). A step that
spends its rejection budget (default 5) fails fast instead of grinding to the
node timeout. Acceptance resolves the step and the engine advances; the next
agent prompt arrives as a new user message in the same conversation.

## Result presentation

Workflow nodes produce structured JSON for routing and persistence. When a
person should see a normal prose response after the run, add
`presentationPrompt` at the top level:

```typescript
export default defineWorkflow({
  name: "report",
  presentationPrompt: ({ state, finalOutput }) =>
    state.status === "waiting"
      ? `Explain this recommendation and ask the user to decide: ${JSON.stringify(finalOutput)}`
      : "Summarize the completed result and any remaining limitations.",
  // ...startAt, nodes, and edges
});
```

- Resolved after the final state is persisted, then delivered as one hidden
  message carrying the instructions and a bounded final result, answered by
  one normal assistant response.
- Returning `undefined`, returning an empty string, or omitting the field
  produces no follow-up. Cancelled runs are never presented.
- Async builders have 30 seconds and receive an `AbortSignal` that fires on
  timeout, session shutdown, or when a new workflow or user turn starts; stale
  presentations are discarded.
- Another workflow cannot start until a queued presentation settles, so
  results cannot interleave.
- Presentation is outside the graph: it cannot route to another node, change
  the run status, or alter the run bundle. A failure to build the prompt or
  deliver the message surfaces as a warning and leaves the run unchanged.

## Runtime behavior

Runs execute one node at a time. Every transition is persisted to the run
bundle before the engine moves on, which is what makes the live viewer
possible. Defaults worth knowing:

- Node timeout is 15 minutes unless the node sets `timeoutMs`. A timed-out
  node has outcome `timed_out` and can be routed with `$result.outcome`.
- `maxSteps` (workflow-level, default 100) bounds loops built from cycles in
  the graph.
- `/workflow pause` requests a pause: the current step finishes normally,
  then the run holds at the step boundary (`paused: true` in the run state,
  `run_paused` in the trace) until `/workflow resume` or `/workflow cancel`.
  Pausing never interrupts a node mid-flight.
- Interrupting a turn (escape) auto-pauses the run: the pending agent step is
  held without nudges and the engine pauses at the next boundary. Node
  timeouts keep ticking while held, so a long-abandoned step still times out.
  `/workflow resume` re-delivers the pending step prompt.
- `/workflow cancel` aborts the current node and marks the run `cancelled`.
  When no run is live but the widget still shows a parked or finished run,
  the same command clears the widget.
- One workflow runs per session at a time.
- Agent nudges: if the model ends its turn without submitting the pending
  step, it gets a reminder, twice by default, then the step fails.

## Picking and browsing runs in pi

`/workflow` (or `/workflow list`) opens a native pi overlay listing every
discovered workflow with its `project` or `global` source. Choosing one opens
pi's input dialog for an optional task; enter with text starts the run with
`{ task }`, enter on an empty field starts it with `{}`, and escape aborts
without starting anything.

`/workflow runs` opens the in-pi run browser: an overlay list of run bundles
newest first, feeding a live detail view with a header, graph, step timeline,
and step inspector. The detail view re-reads its bundle once a second, so a
running workflow animates in place.

| View       | Keys                                                                       |
| ---------- | -------------------------------------------------------------------------- |
| Both lists | `↑`/`↓` move (wrapping), `enter` select, `esc` cancel                      |
| Run detail | `↑`/`↓` scroll, `PgUp`/`PgDn` page, `←`/`→` scrub replay steps, `esc` back |

Scrubbing left from the live position selects the last step; stepping right
past the final step snaps back to live so the view resumes following new
steps. Escape from the detail view returns to the run list, not the prompt.

Overlays are terminal-only and degrade by mode. In RPC mode `/workflow` uses
pi's native select dialog and `/workflow runs` notifies a summary of the five
most recent run ids. In print and JSON modes `/workflow` keeps the plain
notification listing. Nothing is a dead end.
