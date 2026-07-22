import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverWorkflows,
  loadWorkflowFile,
  resolveWorkflowRef,
  workflowFileStem,
} from "../src/workflows/loader.js";
import { makeTempDir } from "./helpers.js";

const REPO_ROOT = path.resolve(__dirname, "..");

// A self-contained echo workflow fixture. Imports from "pi-flow" so the
// import-rewrite in writeEcho points it at the local engine source.
const ECHO_SOURCE = `import { agent, defineWorkflow } from "pi-flow";

export default defineWorkflow({
  name: "echo",
  startAt: "reply",
  nodes: {
    reply: agent({
      prompt: ({ input }) => \`Answer concisely: \${(input as { task?: string }).task}\`,
      expectedOutput: '{ "reply": "your concise answer" }',
    }),
  },
  edges: [],
});
`;

async function makeSearchDirs() {
  const cwd = await makeTempDir("pi-flow-cwd");
  const homeDir = await makeTempDir("pi-flow-home");
  await fs.mkdir(path.join(cwd, ".pi", "workflows"), { recursive: true });
  await fs.mkdir(path.join(homeDir, ".pi", "agent", "workflows"), { recursive: true });
  return { cwd, homeDir };
}

async function writeEcho(targetDir: string, fileName: string): Promise<string> {
  const target = path.join(targetDir, fileName);
  const source = ECHO_SOURCE.replace(
    `from "pi-flow"`,
    `from ${JSON.stringify(path.join(REPO_ROOT, "src", "workflows", "index.ts"))}`,
  );
  await fs.writeFile(target, source, "utf8");
  return target;
}

describe("workflowFileStem", () => {
  it("strips workflow suffixes", () => {
    expect(workflowFileStem("/a/b/echo.workflow.ts")).toBe("echo");
    expect(workflowFileStem("/a/b/echo.workflow.js")).toBe("echo");
  });
});

describe("discoverWorkflows", () => {
  it("finds project and global workflows, project first", async () => {
    const { cwd, homeDir } = await makeSearchDirs();
    await writeEcho(path.join(cwd, ".pi", "workflows"), "local.workflow.ts");
    await writeEcho(path.join(homeDir, ".pi", "agent", "workflows"), "global.workflow.ts");

    const discovered = await discoverWorkflows({ cwd, homeDir });

    expect(discovered.map((w) => [w.name, w.source])).toEqual([
      ["local", "project"],
      ["global", "global"],
    ]);
  });

  it("prefers project workflows on name collisions", async () => {
    const { cwd, homeDir } = await makeSearchDirs();
    await writeEcho(path.join(cwd, ".pi", "workflows"), "same.workflow.ts");
    await writeEcho(path.join(homeDir, ".pi", "agent", "workflows"), "same.workflow.ts");

    const discovered = await discoverWorkflows({ cwd, homeDir });

    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.source).toBe("project");
  });

  it("returns empty for missing directories", async () => {
    const cwd = await makeTempDir("pi-flow-empty");
    const homeDir = await makeTempDir("pi-flow-empty-home");
    expect(await discoverWorkflows({ cwd, homeDir })).toEqual([]);
  });
});

describe("loadWorkflowFile", () => {
  it("loads a workflow module via jiti", async () => {
    const echoPath = await writeEcho(await makeTempDir("pi-flow-echo"), "echo.workflow.ts");
    const workflow = await loadWorkflowFile(echoPath);
    expect(workflow.name).toBe("echo");
    expect(workflow.startAt).toBe("reply");
  });

  it("rejects modules that do not export defineWorkflow", async () => {
    const dir = await makeTempDir("pi-flow-bad");
    const badPath = path.join(dir, "bad.workflow.ts");
    await fs.writeFile(badPath, "export default { name: 'nope' };\n", "utf8");
    await expect(loadWorkflowFile(badPath)).rejects.toThrow(/defineWorkflow/);
  });
});

describe("resolveWorkflowRef", () => {
  it("resolves names to discovered workflows", async () => {
    const { cwd, homeDir } = await makeSearchDirs();
    const target = await writeEcho(path.join(cwd, ".pi", "workflows"), "mine.workflow.ts");

    const resolved = await resolveWorkflowRef("mine", { cwd, homeDir });

    expect(resolved).toEqual({ path: target, source: "project" });
  });

  it("resolves direct paths", async () => {
    const { cwd, homeDir } = await makeSearchDirs();
    const echoPath = await writeEcho(await makeTempDir("pi-flow-echo-path"), "echo.workflow.ts");
    const resolved = await resolveWorkflowRef(echoPath, { cwd, homeDir });
    expect(resolved).toEqual({ path: echoPath, source: "path" });
  });

  it("lists available names for unknown refs", async () => {
    const { cwd, homeDir } = await makeSearchDirs();
    await writeEcho(path.join(cwd, ".pi", "workflows"), "known.workflow.ts");
    await expect(resolveWorkflowRef("unknown", { cwd, homeDir })).rejects.toThrow(/known/);
  });
});
