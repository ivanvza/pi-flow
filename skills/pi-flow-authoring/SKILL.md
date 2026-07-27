---
name: pi-flow-authoring
description: Author, extend, or debug pi-flow `*.workflow.ts` files — `defineWorkflow` graphs of agent, decision, checkpoint, and shell steps in `.pi/workflows/`, run with `/workflow <name>`. Covers multi-step agent pipelines and loops.
---

# Writing a pi workflow

Full reference: [../../docs/workflows.md](../../docs/workflows.md). The skeleton below is a
runnable review loop; the [Patterns](#patterns) section has minimal, branch, shell, and
loop snippets to copy.

## File placement

- `.pi/workflows/<stem>.workflow.ts` (project) or `~/.pi/agent/workflows/<stem>.workflow.ts`
  (global; project wins on a name collision). `.js`, `.mts`, `.mjs` also work.
- **The command name is the file stem**, not the `name` field:
  `.pi/workflows/triage.workflow.ts` → `/workflow triage`. Keep the two equal anyway.
- The default export must be `defineWorkflow(...)`. Files load through jiti on every run, so
  plain TypeScript works with no build step and no session reload, and
  `import ... from "pi-flow"` resolves to the running engine.

## Skeleton

```typescript
import { agent, compute, decision, decisionEdge, defineWorkflow } from "pi-flow";

// `/workflow review some text` → { task: "some text" }; `--input-json {…}` → that object
type Input = { task?: string };
const choices = ["clean", "issues_found"] as const;

export default defineWorkflow({
  name: "review", // not cancel|list|pause|resume
  title: ({ input }) => `review: ${(input as Input).task}`, // optional
  presentationPrompt: "Summarize the result in plain prose.", // optional
  maxSteps: 20, // optional, default 100
  startAt: "inspect",
  nodes: {
    inspect: agent({
      timeoutMs: 30 * 60_000, // optional, default 15 min
      statusDetail: "inspecting", // optional, shown in widget and viewer
      prompt: ({ input }) => `Inspect: ${(input as Input).task}`,
      expectedOutput: `{ "findings": ["short finding"] }`,
    }),
    judge: decision({
      choices,
      question: ({ outputs }) => `Verdict? ${JSON.stringify(outputs.inspect)}`,
    }),
    fix: agent({ prompt: ({ outputs }) => `Fix: ${JSON.stringify(outputs.judge)}` }),
    done: compute({ run: ({ outputs }) => ({ findings: outputs.inspect }) }),
  },
  edges: [
    // required; use `edges: []` for one node
    { from: "inspect", to: "judge" },
    decisionEdge({ from: "judge", choices, cases: { clean: "done", issues_found: "fix" } }),
    { from: "fix", to: "judge" },
  ],
});
```

## Node constructors

Every callback receives one context: `{ input, outputs, results, state, signal }`.
`outputs[nodeId]` is the JSON output that node submitted, typed `unknown` — cast it. It is
present only for nodes whose latest attempt was `ok`. Hand `signal` to any `fetch`/`spawn`
you start, or that work outlives a cancel.

| Constructor       | Required                                                                                 | Optional                                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent({…})`      | `prompt(ctx) => string \| Promise<string>`                                               | `expectedOutput` (a **string** sample, not a schema), `validate(output, ctx)` — throwing rejects the submission and the model retries within the step |
| `compute({…})`    | `run(ctx) => unknown`                                                                    | —                                                                                                                                                     |
| `action({…})`     | `run(ctx) => unknown`                                                                    | —                                                                                                                                                     |
| `shell({…})`      | `exec(ctx) => ShellActionExecution`                                                      | `parse(result, ctx) => unknown`                                                                                                                       |
| `checkpoint({…})` | —                                                                                        | `summary`, `run(ctx) => unknown`                                                                                                                      |
| `decision({…})`   | `question: string \| ((ctx) => string \| Promise<string>)`, `choices: readonly string[]` | `field` (default `"route"`)                                                                                                                           |

Every constructor also takes `timeoutMs` and `statusDetail`.

- Every value crossing the engine boundary — run input, node output, accepted step output —
  must survive a JSON round-trip, or the node fails. No `Date`, `Map`, `Set`, class
  instances, `NaN`, or `undefined` properties. A node returning `undefined` yields `null`.
- `ShellActionExecution` fields: `command`, `args?`, `cwd?`, `env?`, `stdin?`, `shell?`,
  `allowNonZeroExit?`, `timeoutMs?`, `maxOutputChars?`. A non-zero exit **or a kill signal**
  fails the node unless `allowNonZeroExit` is set.
- `ShellActionResult`, passed to `parse` and used as the output when `parse` is omitted:
  `{ command, args, cwd, stdout, stderr, exitCode, signal, durationMs }`.
- `action()` takes exactly one of `run` or `exec`; use `shell()` for the `exec` form.
- `checkpoint` without `run` outputs `{ summary: summary ?? "checkpoint" }`.
- A `checkpoint` with **no** outgoing edge ends the run as `waiting` and its output becomes
  `finalOutput`. Give it **one** outgoing edge to make it a resumable pause instead: the run
  holds at `waiting` until `/workflow resume` continues it through that edge (in-session).
  To branch after a pause (approve vs. revise), follow the checkpoint with a `decision` — the
  checkpoint itself takes a single outgoing edge like any node.
- `decision` is sugar over `agent`, so it owns `prompt`, `expectedOutput`, and `validate`.
  Its output is the model's own object, guaranteed only to carry `[field]` set to one of
  `choices` — the `reason` it asks for is not enforced. Pass the same `field` to
  `decisionEdge`.

## Edges

At most **one outgoing edge per node**. Branch with a `switch`, never with two edges.

```typescript
{ from: "a", to: "b" }
{ from: "a", switch: { on: "$.route", cases: { yes: "b", no: "c" } } }   // $output. is an alias
{ from: "a", switch: { on: "$result.outcome", cases: { ok: "b", failed: "recover" } } }
```

- `switch.on` must start with `$.`, `$output.`, or `$result.`; `cases` must be non-empty;
  the resolved value must be a scalar (routing on an object or array fails the run).
- Only a `$result.` edge can route a **failed** node. Otherwise a failure ends the run.
- No outgoing edge ends the run, and that node's output becomes `finalOutput`.
- `decisionEdge({ from, choices, cases, field? })` builds the `$.<field>` switch and turns a
  missing case into a compile error.

## Failure modes

| Error                                            | Cause                                                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `must not declare multiple outgoing edges`       | Two edges share a `from`. Use a `switch`.                                                                           |
| `has unreachable nodes`                          | Every node must be reachable from `startAt`.                                                                        |
| `node id … must match ^[A-Za-z_][A-Za-z0-9_-]*$` | No leading digit, no dots or spaces. Ids shadowing `Object.prototype` (`toString`, `constructor`) are rejected too. |
| `workflow name … is reserved`                    | `name` cannot be `cancel`, `list`, `pause`, `resume`, or `runs`.                                                    |
| `must default-export defineWorkflow(...)`        | A bare object literal was exported.                                                                                 |
| `No workflow switch case for …`                  | `cases` is missing a key the node can emit. Fails mid-run.                                                          |
| `exceeded maxSteps`                              | A cycle with no exit case. Every loop needs a decision that can leave it.                                           |

## Agent steps and presentation

The engine appends a step contract to every `agent` prompt, and the model completes the step
by calling the `workflow` tool once with `{ output }`, using `expectedOutput` as the target
shape. Never hand-write that contract — you write only `prompt` text.

Write `expectedOutput` as a JSON object naming every field a downstream node reads, e.g.
`` `{ "title": "string", "body": "string" }` ``. The engine enforces those top-level keys: a
submission missing any is rejected and the model is made to retry, so a weak model that
returns the wrong shape can't poison a later node. Values are freeform hints; only keys are
checked. This is the main lever for keeping runs robust regardless of model — always list the
keys a `compute`/downstream node will read.

Agent steps run **in the current pi conversation**, so the model keeps everything discussed
before `/workflow` started; write prompts that lean on it. One run at a time per session; a
new run can start once the previous one ends.

`presentationPrompt` — `string`, or `(ctx: { state, finalOutput, signal }) => string |
undefined | Promise<...>` — requests one normal prose assistant reply after the run
persists. Returning `undefined` or `""`, or omitting the field, stays silent, and cancelled
runs are never presented. Leave it off for shell-only or machine-consumed workflows.

## Patterns

**Minimal** — one agent step, no edges (the whole run is one node):

```typescript
export default defineWorkflow({
  name: "echo",
  startAt: "reply",
  nodes: {
    reply: agent({
      prompt: ({ input }) => `Answer concisely: ${(input as { task?: string }).task}`,
      expectedOutput: `{ "reply": "your answer" }`,
    }),
  },
  edges: [],
});
```

**Branch to a pause** — a decision routes one lane to a checkpoint; the checkpoint has no
outgoing edge, so that lane parks the run as `waiting` for the user:

```typescript
const choices = ["ok", "unclear"] as const;
// nodes: { triage: decision({ choices, question }), proceed: …, "ask-human": checkpoint({ summary: "need input" }) }
decisionEdge({ from: "triage", choices, cases: { ok: "proceed", unclear: "ask-human" } });
```

**Shell-only** — no agent step; a runtime-owned command whose stdout is parsed into the output:

```typescript
"check-clean": shell({
  exec: () => ({ command: "git", args: ["status", "--porcelain"] }),
  parse: (r) => ({ dirty: r.stdout.trim().length > 0 }),
}),
```

**Loop** — see the [Skeleton](#skeleton): `{ from: "fix", to: "judge" }` is the back-edge and
the `judge` decision's `clean` case is the exit. Every loop needs a decision that can leave it,
or it trips `maxSteps`.
