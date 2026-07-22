import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Shipped skills load only when the `pi` manifest names them: pi stops using
 * the convention directory once a `pi` key exists. A SKILL.md with a missing
 * description is dropped at runtime with nothing but a warning, so both the
 * wiring and the frontmatter are asserted here.
 */

const ROOT = path.resolve(__dirname, "..");
const SKILLS_DIR = path.join(ROOT, "skills");

describe("shipped skills", () => {
  it("declares the skills directory in package.json", async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8")) as {
      pi: { skills?: string[] };
      files: string[];
    };
    expect(pkg.pi.skills).toContain("./skills");
    expect(pkg.files).toContain("skills");
  });

  it("gives every skill a valid name and a non-empty description", async () => {
    const entries = (await fs.readdir(SKILLS_DIR, { withFileTypes: true })).filter((entry) =>
      entry.isDirectory(),
    );
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const source = await fs.readFile(path.join(SKILLS_DIR, entry.name, "SKILL.md"), "utf8");
      const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(source)?.[1] ?? "";
      expect(/^name: (.+)$/m.exec(frontmatter)?.[1], entry.name).toMatch(
        /^[a-z0-9]+(-[a-z0-9]+)*$/,
      );
      expect(/^description: (.+)$/m.exec(frontmatter)?.[1]?.trim(), entry.name).toBeTruthy();
    }
  });
});
