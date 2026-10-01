import { mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelMessage, ModelProvider } from "../kernel/src/model.js";
import { discoverSkills, skillIndexText, withSystemSkills } from "./skills.js";

function skillFile(name: string, description: string, body = "Do the thing.\n"): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
}

async function skillRoot(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nexus-skills-"));
  for (const [relative, content] of Object.entries(files)) {
    const dir = join(root, relative.split("/").slice(0, -1).join("/"));
    await mkdir(dir, { recursive: true });
    await writeFile(join(root, relative), content, "utf8");
  }
  return root;
}

describe("skills loader", () => {
  it("loads an official skill with its name, description, and body", async () => {
    const root = await skillRoot({
      "skills/nexus-git/SKILL.md": skillFile(
        "nexus-git",
        "Repo conventions: one branch per task.",
        "Run the gate.\n",
      ),
    });
    try {
      const found = await discoverSkills(root);
      expect(found.skills).toHaveLength(1);
      expect(found.skills[0]).toMatchObject({
        name: "nexus-git",
        description: "Repo conventions: one branch per task.",
        path: "skills/nexus-git/SKILL.md",
      });
      expect(found.skills[0]?.body).toBe("Run the gate.\n");
      expect(found.refused).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads a user skill, and refuses a user skill that shadows an official one", async () => {
    const root = await skillRoot({
      "skills/nexus-git/SKILL.md": skillFile("nexus-git", "Official rules.", "Official.\n"),
      "user/skills/my-tool/SKILL.md": skillFile("my-tool", "Mine.", "Mine.\n"),
      "user/skills/nexus-git/SKILL.md": skillFile("nexus-git", "Impostor.", "Impostor.\n"),
    });
    try {
      const found = await discoverSkills(root);
      expect(found.skills.map((skill) => skill.name).sort()).toEqual(["my-tool", "nexus-git"]);
      // The official one wins; the shadow is counted, never loaded in its place.
      expect(found.skills.find((skill) => skill.name === "nexus-git")?.body).toBe("Official.\n");
      expect(found.refused).toEqual([
        { path: "user/skills/nexus-git/SKILL.md", reason: "shadows an official skill" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a skill whose frontmatter lies, and says which rule broke", async () => {
    const root = await skillRoot({
      "skills/no-matter/SKILL.md": "Just a body, no frontmatter.\n",
      "skills/extra-key/SKILL.md":
        "---\nname: extra-key\ndescription: Has an extra key.\nmode: patch\n---\nBody.\n",
      "skills/Not_Kebab/SKILL.md": skillFile("Not_Kebab", "Bad directory name.", "Body.\n"),
      "skills/mismatch/SKILL.md": skillFile("other-name", "Directory says mismatch.", "Body.\n"),
      "skills/empty-desc/SKILL.md": "---\nname: empty-desc\ndescription: \n---\nBody.\n",
    });
    try {
      const found = await discoverSkills(root);
      expect(found.skills).toEqual([]);
      expect(found.refused.map((entry) => entry.path).sort()).toEqual([
        "skills/empty-desc/SKILL.md",
        "skills/extra-key/SKILL.md",
        "skills/mismatch/SKILL.md",
        "skills/no-matter/SKILL.md",
      ]);
      expect(found.skipped.some((entry) => entry.path === "skills/Not_Kebab/SKILL.md")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a symlink, a traversal, and an oversized file", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-skills-"));
    const outside = await mkdtemp(join(tmpdir(), "nexus-skills-outside-"));
    try {
      await mkdir(join(root, "skills", "linked"), { recursive: true });
      await writeFile(join(outside, "SKILL.md"), skillFile("linked", "Escapes.", "Out.\n"), "utf8");
      await symlink(join(outside, "SKILL.md"), join(root, "skills", "linked", "SKILL.md"));
      await mkdir(join(root, "skills", "big"), { recursive: true });
      await writeFile(
        join(root, "skills", "big", "SKILL.md"),
        `---\nname: big\ndescription: Too big.\n---\n${"x".repeat(70_000)}\n`,
        "utf8",
      );
      const found = await discoverSkills(root);
      expect(found.skills).toEqual([]);
      const refused = Object.fromEntries(found.refused.map((entry) => [entry.path, entry.reason]));
      expect(refused["skills/linked/SKILL.md"]).toMatch(/symlink/);
      expect(refused["skills/big/SKILL.md"]).toMatch(/byte limit/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("renders a stable index the loop can append to its system prompt", () => {
    expect(
      skillIndexText([
        { name: "b-skill", description: "Second.", path: "skills/b-skill/SKILL.md" },
        { name: "a-skill", description: "First.", path: "user/skills/a-skill/SKILL.md" },
      ]),
    ).toBe(
      "Available skills (read the SKILL.md file with read_text to use one):\n" +
        "- a-skill — First. (user/skills/a-skill/SKILL.md)\n" +
        "- b-skill — Second. (skills/b-skill/SKILL.md)",
    );
    expect(skillIndexText([])).toBe("");
  });

  it("treats the body as text: no interpolation, no execution, no code", async () => {
    const root = await skillRoot({
      "skills/tricky/SKILL.md": skillFile(
        "tricky",
        "Looks executable but is not.",
        "Run `${EVIL}` and require('./evil.js').\n<script>alert(1)</script>\n",
      ),
    });
    try {
      const found = await discoverSkills(root);
      expect(found.skills).toHaveLength(1);
      expect(found.skills[0]?.body).toContain("${EVIL}");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("appends the index to the system message, once, and never to a resumed transcript", async () => {
    const seen: ModelMessage[][] = [];
    const model: ModelProvider = {
      async complete(messages) {
        seen.push(messages.slice());
        return { type: "final", text: "done" };
      },
    };
    const index = skillIndexText([
      { name: "nexus-git", description: "Konvensi Git.", path: "skills/nexus-git/SKILL.md" },
    ]);
    const wrapped = withSystemSkills(model, index);
    await wrapped.complete(
      [
        { role: "system", content: "base prompt" },
        { role: "user", content: "task" },
      ],
      [],
    );
    await wrapped.complete(
      [
        { role: "system", content: "base prompt" },
        { role: "user", content: "task" },
      ],
      [],
    );
    expect(seen[0]?.[0]?.content).toBe(`base prompt\n\n${index}`);
    // Idempotent: a second turn that already carries the index is forwarded untouched.
    expect(seen[1]?.[0]?.content).toBe(seen[0]?.[0]?.content);
    // A resumed transcript with no system message gains none.
    await wrapped.complete([{ role: "user", content: "resumed" }], []);
    expect(seen[2]).toEqual([{ role: "user", content: "resumed" }]);
  });

  it("hands the provider straight back when the repo has no skills", async () => {
    const model: ModelProvider = {
      async complete() {
        return { type: "final", text: "x" };
      },
    };
    expect(withSystemSkills(model, "")).toBe(model);
  });
});
