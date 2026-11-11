import type { JobDeps } from "./job";

/** A skill the repo commits under `.claude/skills/<dir>/SKILL.md`, as named in its frontmatter. */
export interface RepoRule { path: string; name: string; description: string }

export const MAX_RULES = 40;
export const MAX_RULE_DESCRIPTION = 400;

const SKILLS_DIR = ".claude/skills";
const SKILL_FILE = /^\.claude\/skills\/[^/]+\/SKILL\.md$/;
const BLOCK_INDICATOR = /^[|>][+-]?\d*$/;

function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\(.)/g, (_, c: string) => (c === "n" || c === "t" ? " " : c));
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replaceAll("''", "'");
  return v;
}

/**
 * `name` and `description` from a SKILL.md's leading `---` block: top-level keys only, a value
 * may be quoted, a block scalar (`|`, `>`) or continue on indented lines; it comes back as one
 * line. Null when the block, or either field, is missing.
 */
export function parseSkillFrontmatter(text: string): { name: string; description: string } | null {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "---");
  if (end < 0) return null;
  const fields = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z_][\w-]*):(.*)$/.exec(line);
    if (m) {
      const head = m[2].trim();
      current = BLOCK_INDICATOR.test(head) ? [] : [head];
      fields.set(m[1], current);
    } else if (/^\s/.test(line) || line === "") {
      current?.push(line.trim());
    } else {
      current = null;
    }
  }
  const value = (key: string): string => unquote((fields.get(key) ?? []).join(" ").replace(/\s+/g, " ").trim());
  const name = value("name");
  const description = value("description");
  return name && description ? { name, description } : null;
}

/**
 * The repo's skills as committed at `mergeBase` (the PR can't plant one): `SKILL.md` one level
 * under `.claude/skills`, at most `MAX_RULES`, descriptions capped. A skill that can't be read or
 * parsed is left out; no skills (or no listing) is `[]`.
 */
export async function repoRules(
  d: Pick<JobDeps, "treePaths" | "readFileAt">, repoPath: string, mergeBase: string,
): Promise<RepoRule[]> {
  const paths = await d.treePaths(repoPath, mergeBase, SKILLS_DIR).catch((): string[] => []);
  const rules = await Promise.all(paths.filter((p) => SKILL_FILE.test(p)).slice(0, MAX_RULES).map(async (path) => {
    const fm = parseSkillFrontmatter(await d.readFileAt(repoPath, mergeBase, path).catch(() => ""));
    if (!fm) return null;
    const description = fm.description.length > MAX_RULE_DESCRIPTION
      ? `${fm.description.slice(0, MAX_RULE_DESCRIPTION - 1)}…`
      : fm.description;
    return { path, name: fm.name, description };
  }));
  return rules.filter((r): r is RepoRule => r !== null);
}
