import type {
  AgentStepExecutor,
  AgentStepRequest,
  AgentStepSubmission,
} from "../workflows/types.js";

export type SubmissionResult =
  | { accepted: true; message: string }
  | { accepted: false; message: string };

export type PromptDelivery = {
  prompt: string;
  /** True when the agent is known to be mid-run, so delivery must be queued. */
  streaming: boolean;
};

export type ConversationStepExecutorOptions = {
  /** Deliver a prompt into the pi conversation. */
  sendPrompt: (delivery: PromptDelivery) => void;
  /** Reminders sent when the agent settles without submitting. Default 2. */
  maxNudges?: number;
  /** Rejected submissions tolerated per step before it fails. Default 5. */
  maxRejections?: number;
};

type PendingStep = {
  request: AgentStepRequest;
  resolve: (submission: AgentStepSubmission) => void;
  reject: (error: unknown) => void;
  nudgesSent: number;
  rejectionsSent: number;
  cleanup: () => void;
  /** Resolves when this step stops being the pending step. */
  cleared: Promise<void>;
  markCleared: () => void;
};

const DEFAULT_MAX_NUDGES = 2;
// Enough for a few genuine validation-correction rounds; a model stuck
// re-emitting or submitting garbage fails the step here instead of grinding to
// the node timeout.
const DEFAULT_MAX_REJECTIONS = 5;

/** Byte-compare two step outputs. A re-emitted tool call preserves key order,
 * so JSON.stringify is a sufficient duplicate check. */
function sameOutput(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * AgentStepExecutor that runs steps inside the current pi conversation. The
 * engine hands it a prompt; it delivers the prompt as a user message and
 * resolves once the model submits an accepted output through the `workflow`
 * tool. If the agent settles without submitting, it nudges the model a
 * bounded number of times before failing the step. A submission that just
 * re-emits the previous step's output is rejected, and a step that spends its
 * rejection budget fails fast rather than grinding to the node timeout.
 */
export class ConversationStepExecutor implements AgentStepExecutor {
  private readonly sendPrompt: (delivery: PromptDelivery) => void;
  private readonly maxNudges: number;
  private readonly maxRejections: number;
  private pending: PendingStep | null = null;
  private streaming = false;
  private heldByUser = false;
  /** The last output this run accepted, to catch a model that re-emits its
   * previous answer for the next step. Unset until the first acceptance. */
  private lastAccepted: { output: unknown } | null = null;

  constructor(options: ConversationStepExecutorOptions) {
    this.sendPrompt = options.sendPrompt;
    this.maxNudges = options.maxNudges ?? DEFAULT_MAX_NUDGES;
    this.maxRejections = options.maxRejections ?? DEFAULT_MAX_REJECTIONS;
  }

  /** Track agent streaming state (wire to agent_start / agent_settled). */
  setStreaming(streaming: boolean): void {
    this.streaming = streaming;
  }

  get pendingStepId(): string | null {
    return this.pending?.request.contract.nodeId ?? null;
  }

  /**
   * Hold the pending step for the user: no nudges are sent while held, so an
   * escape-interrupted conversation stays quiet until the user resumes.
   */
  hold(): void {
    this.heldByUser = true;
  }

  get held(): boolean {
    return this.heldByUser;
  }

  /**
   * Release a user hold. When a step is still pending, its prompt is
   * re-delivered so the model picks the step back up.
   */
  release(): void {
    if (!this.heldByUser) {
      return;
    }
    this.heldByUser = false;
    const pending = this.pending;
    if (!pending) {
      return;
    }
    try {
      this.sendPrompt({ prompt: pending.request.prompt, streaming: this.streaming });
    } catch (error) {
      this.clearPending();
      pending.reject(error);
    }
  }

  async runAgentStep(request: AgentStepRequest, signal: AbortSignal): Promise<AgentStepSubmission> {
    if (this.pending) {
      throw new Error("Another workflow step is already awaiting output");
    }
    return await new Promise<AgentStepSubmission>((resolve, reject) => {
      const onAbort = () => {
        const reason: unknown = signal.reason ?? new Error("Workflow step aborted");
        this.clearPending();
        reject(reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      let markCleared!: () => void;
      const cleared = new Promise<void>((resolveCleared) => {
        markCleared = resolveCleared;
      });
      this.pending = {
        request,
        resolve,
        reject,
        nudgesSent: 0,
        rejectionsSent: 0,
        cleanup: () => signal.removeEventListener("abort", onAbort),
        cleared,
        markCleared,
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      try {
        this.sendPrompt({ prompt: request.prompt, streaming: this.streaming });
      } catch (error) {
        // A failed delivery must not leave the step installed, or every
        // subsequent agent node would fail with "already awaiting output".
        this.clearPending();
        reject(error);
      }
    });
  }

  /**
   * Called by the `workflow` tool when the model submits a step output. The
   * output targets the single pending step; the model supplies no step or
   * attempt id, so there is nothing for it to mislabel.
   *
   * ponytail: a gate-less self-loop (a node with an A→A edge and a shape-only
   * validator) whose model re-submits the previous iteration's output on the
   * next turn would have that stale output accepted for the new attempt. The
   * captured-pending identity check below still prevents any cross-step
   * corruption; the "call once, then end your turn" contract is the mitigation.
   * Upgrade path: give looping nodes a content-aware validate(), or dedup
   * identical consecutive same-node outputs here.
   */
  async submit(output: unknown): Promise<SubmissionResult> {
    const pending = this.pending;
    if (!pending) {
      return {
        accepted: false,
        message:
          "No workflow step is awaiting output. Do not call the workflow tool outside an active workflow step.",
      };
    }
    const expected = pending.request.contract.nodeId;
    // Anti-echo: a model that re-emits its previous answer for this step is not
    // producing this step's output. Reject it here so a wrong shape never
    // reaches a downstream node that assumes the right one. Checked before
    // validate() so a known duplicate costs nothing.
    // ponytail: false-positive if two consecutive steps legitimately produce a
    // byte-identical output; the rejection is correctable and the budget bounds
    // it. Upgrade path: compare per-node instead of against the last accepted.
    if (this.lastAccepted && sameOutput(output, this.lastAccepted.output)) {
      return this.rejectSubmission(
        pending,
        `This output is identical to the previous step's output. Produce the result for step ${JSON.stringify(expected)}, not a copy of the last one.`,
      );
    }
    // Race validation against the step being cleared: a hung `validate`
    // callback must not leave this tool call (and therefore pi) blocked after
    // a timeout or cancel already resolved the run.
    const result = await Promise.race([
      pending.request.accept(output),
      pending.cleared.then(() => null),
    ]);
    // The step may have timed out or been cancelled (and a newer step
    // installed) while validation was awaited; a stale submission must not
    // clear or resolve the newer pending step.
    if (result === null || this.pending !== pending) {
      return {
        accepted: false,
        message: `Step ${JSON.stringify(expected)} is no longer awaiting output.`,
      };
    }
    if (!result.ok) {
      return this.rejectSubmission(
        pending,
        `Output rejected for step ${JSON.stringify(expected)}: ${result.error}`,
      );
    }
    this.lastAccepted = { output };
    this.clearPending();
    pending.resolve({ output: result.value });
    return {
      accepted: true,
      message: [
        `Output accepted for step ${JSON.stringify(expected)}.`,
        "If the workflow continues, the next step arrives as a new user message. End your turn now.",
      ].join(" "),
    };
  }

  /**
   * Bounce a bad submission back to the model, or fail the step once it has
   * spent its rejection budget so a model that cannot produce valid output
   * ends the node instead of grinding to the timeout.
   */
  private rejectSubmission(pending: PendingStep, message: string): SubmissionResult {
    pending.rejectionsSent += 1;
    if (pending.rejectionsSent >= this.maxRejections) {
      this.clearPending();
      pending.reject(
        new Error(
          `Step ${JSON.stringify(
            pending.request.contract.nodeId,
          )} rejected ${pending.rejectionsSent} submissions without a valid output`,
        ),
      );
      return {
        accepted: false,
        message: `${message} The step's retry budget is spent; failing it.`,
      };
    }
    return { accepted: false, message };
  }

  /**
   * Called when the agent settles. Returns true when a nudge was sent, false
   * when there was nothing to do. Fails the pending step once the nudge
   * budget is exhausted.
   */
  handleAgentSettled(): boolean {
    const pending = this.pending;
    if (!pending) {
      return false;
    }
    if (this.heldByUser) {
      // The user interrupted deliberately; reminding the model now would
      // steal the conversation back. The step waits for an explicit resume.
      return false;
    }
    if (pending.nudgesSent >= this.maxNudges) {
      this.clearPending();
      pending.reject(
        new Error(
          `Agent settled ${pending.nudgesSent + 1} times without submitting step ${JSON.stringify(
            pending.request.contract.nodeId,
          )} via the workflow tool`,
        ),
      );
      return false;
    }
    pending.nudgesSent += 1;
    const { nodeId } = pending.request.contract;
    try {
      this.sendPrompt({
        prompt: [
          `Reminder: workflow step ${JSON.stringify(nodeId)} is still awaiting your output.`,
          "Complete it by calling the `workflow` tool with:",
          `{"output": <your result>}`,
          `Expected output: ${pending.request.contract.expectedOutput ?? "a JSON object with your result"}`,
        ].join("\n"),
        streaming: this.streaming,
      });
    } catch (error) {
      // No reminder turn was started, so nothing would settle the step; fail
      // it promptly instead of waiting out the node timeout.
      this.clearPending();
      pending.reject(error);
      return false;
    }
    return true;
  }

  private clearPending(): void {
    this.pending?.cleanup();
    this.pending?.markCleared();
    this.pending = null;
  }
}
