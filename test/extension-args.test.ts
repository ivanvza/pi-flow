import { describe, expect, it } from "vitest";
import { parseWorkflowArgs } from "../src/extension/index.js";

describe("parseWorkflowArgs", () => {
  it("lists on empty args", () => {
    expect(parseWorkflowArgs("")).toEqual({ kind: "list" });
    expect(parseWorkflowArgs("   ")).toEqual({ kind: "list" });
  });

  it("parses list, runs, cancel, pause, and resume", () => {
    expect(parseWorkflowArgs("list")).toEqual({ kind: "list" });
    expect(parseWorkflowArgs("runs")).toEqual({ kind: "runs" });
    expect(parseWorkflowArgs("cancel")).toEqual({ kind: "cancel" });
    expect(parseWorkflowArgs("pause")).toEqual({ kind: "pause" });
    expect(parseWorkflowArgs("resume")).toEqual({ kind: "resume" });
  });

  it("treats a subcommand with trailing text as a workflow ref", () => {
    expect(parseWorkflowArgs("runs extra")).toEqual({
      kind: "run",
      ref: "runs",
      input: { task: "extra" },
    });
  });

  it("parses a bare workflow ref", () => {
    expect(parseWorkflowArgs("echo")).toEqual({ kind: "run", ref: "echo", input: {} });
  });

  it("treats trailing text as the task input", () => {
    expect(parseWorkflowArgs("autoimplement fix the flaky test")).toEqual({
      kind: "run",
      ref: "autoimplement",
      input: { task: "fix the flaky test" },
    });
  });

  it("parses --input-json", () => {
    expect(parseWorkflowArgs(`branch --input-json {"task":"x"}`)).toEqual({
      kind: "run",
      ref: "branch",
      input: { task: "x" },
    });
  });

  it("rejects --input-json without a value", () => {
    expect(() => parseWorkflowArgs("branch --input-json")).toThrow(/requires a JSON value/);
  });

  it("rejects malformed --input-json", () => {
    expect(() => parseWorkflowArgs("branch --input-json {broken")).toThrow();
  });

  it("treats task text starting with --input-json as plain text", () => {
    expect(parseWorkflowArgs("echo --input-jsonschema help")).toEqual({
      kind: "run",
      ref: "echo",
      input: { task: "--input-jsonschema help" },
    });
  });

  it("supports path refs", () => {
    expect(parseWorkflowArgs("./.pi/workflows/echo.workflow.ts hello")).toEqual({
      kind: "run",
      ref: "./.pi/workflows/echo.workflow.ts",
      input: { task: "hello" },
    });
  });
});
