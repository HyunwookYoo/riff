import { describe, expect, it, vi } from "vitest";
import { MAX_RULE_DESCRIPTION, MAX_RULES, parseSkillFrontmatter, repoRules } from "./repoRules";

describe("parseSkillFrontmatter", () => {
  it("reads single-line name and description", () => {
    expect(parseSkillFrontmatter("---\nname: pr-conventions\ndescription: Use this when opening a PR.\n---\n# Body\n"))
      .toEqual({ name: "pr-conventions", description: "Use this when opening a PR." });
  });
  it("unquotes double- and single-quoted values", () => {
    expect(parseSkillFrontmatter('---\nname: "a: b"\ndescription: \'it\'\'s "fine"\'\n---\n'))
      .toEqual({ name: "a: b", description: 'it\'s "fine"' });
    expect(parseSkillFrontmatter('---\nname: x\ndescription: "say \\"hi\\""\n---\n'))
      .toEqual({ name: "x", description: 'say "hi"' });
  });
  it("tolerates CRLF and a BOM", () => {
    expect(parseSkillFrontmatter("﻿---\r\nname: n\r\ndescription: d\r\n---\r\nbody\r\n"))
      .toEqual({ name: "n", description: "d" });
  });
  it("joins block scalars and indented continuation lines into one line", () => {
    const text = "---\nname: context-docs\ndescription: |\n  Use this skill BEFORE creating\n  CLAUDE.md files.\n\n  Second paragraph.\nallowed-tools: Read\n---\n";
    expect(parseSkillFrontmatter(text))
      .toEqual({ name: "context-docs", description: "Use this skill BEFORE creating CLAUDE.md files. Second paragraph." });
    expect(parseSkillFrontmatter("---\nname: n\ndescription: >-\n  folded\n  text\n---\n"))
      .toEqual({ name: "n", description: "folded text" });
    expect(parseSkillFrontmatter("---\nname: n\ndescription: plain start\n  and more\n---\n"))
      .toEqual({ name: "n", description: "plain start and more" });
  });
  it("ignores nested keys and other fields", () => {
    expect(parseSkillFrontmatter("---\nmetadata:\n  name: inner\nname: outer\ndescription: d\n---\n"))
      .toEqual({ name: "outer", description: "d" });
  });
  it("is null without a frontmatter block, a closing fence, a name or a description", () => {
    expect(parseSkillFrontmatter("# Just a doc\nname: x\ndescription: y\n")).toBeNull();
    expect(parseSkillFrontmatter("---\nname: x\ndescription: y\n")).toBeNull();
    expect(parseSkillFrontmatter("---\ndescription: y\n---\n")).toBeNull();
    expect(parseSkillFrontmatter("---\nname: x\n---\n")).toBeNull();
    expect(parseSkillFrontmatter("---\nname: x\ndescription:\n---\n")).toBeNull();
    expect(parseSkillFrontmatter("")).toBeNull();
  });
});

const skill = (name: string, description = `${name} rules`) => `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`;

function deps(files: Record<string, string>) {
  return {
    treePaths: vi.fn(async (_p: string, _rev: string, _prefix: string) => Object.keys(files)),
    readFileAt: vi.fn(async (_p: string, _rev: string, path: string) => {
      const f = files[path];
      if (f === undefined) throw new Error("missing");
      return f;
    }),
  };
}

describe("repoRules", () => {
  it("lists one-level SKILL.md files at the merge-base, skipping nested and other files", async () => {
    const d = deps({
      ".claude/skills/a/SKILL.md": skill("a"),
      ".claude/skills/a/ref/SKILL.md": skill("nested"),
      ".claude/skills/a/notes.md": "notes",
      ".claude/skills/SKILL.md": skill("top"),
      ".claude/skills/b/SKILL.md": skill("b"),
    });
    expect(await repoRules(d, "/repo", "MB1")).toEqual([
      { path: ".claude/skills/a/SKILL.md", name: "a", description: "a rules" },
      { path: ".claude/skills/b/SKILL.md", name: "b", description: "b rules" },
    ]);
    expect(d.treePaths).toHaveBeenCalledWith("/repo", "MB1", ".claude/skills");
    expect(d.readFileAt).toHaveBeenCalledWith("/repo", "MB1", ".claude/skills/a/SKILL.md");
    expect(d.readFileAt).toHaveBeenCalledTimes(2);
  });

  it("drops a skill that cannot be read or parsed, keeping the rest", async () => {
    const d = deps({ ".claude/skills/a/SKILL.md": "no frontmatter", ".claude/skills/b/SKILL.md": skill("b") });
    d.treePaths.mockResolvedValueOnce([".claude/skills/a/SKILL.md", ".claude/skills/gone/SKILL.md", ".claude/skills/b/SKILL.md"]);
    expect((await repoRules(d, "/repo", "MB1")).map((r) => r.name)).toEqual(["b"]);
  });

  it("is empty when the listing fails or there are no skills", async () => {
    const d = deps({});
    expect(await repoRules(d, "/repo", "MB1")).toEqual([]);
    d.treePaths.mockRejectedValueOnce(new Error("bad rev"));
    expect(await repoRules(d, "/repo", "MB1")).toEqual([]);
  });

  it("caps the number of skills and the description length", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < MAX_RULES + 5; i++) files[`.claude/skills/s${String(i).padStart(2, "0")}/SKILL.md`] = skill(`s${i}`, "x".repeat(1000));
    const d = deps(files);
    const rules = await repoRules(d, "/repo", "MB1");
    expect(rules).toHaveLength(MAX_RULES);
    expect(d.readFileAt).toHaveBeenCalledTimes(MAX_RULES);
    expect(rules[0].description).toHaveLength(MAX_RULE_DESCRIPTION);
    expect(rules[0].description.endsWith("…")).toBe(true);
  });
});
