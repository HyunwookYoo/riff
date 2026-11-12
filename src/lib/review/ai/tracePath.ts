import { fenced } from "./prompts";
import type { AiFinding, TraceStep } from "./types";

/** Code block languages GitHub knows, by file extension; others get a plain block. */
const LANG: Record<string, string> = {
  ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", svelte: "svelte", rs: "rust", py: "python", go: "go",
  java: "java", kt: "kotlin", cs: "csharp", lua: "lua", luau: "lua", json: "json", yaml: "yaml", yml: "yaml",
  toml: "toml", sh: "sh", c: "c", h: "cpp", hpp: "cpp", cc: "cpp", cpp: "cpp", cxx: "cpp", inl: "cpp",
};

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** U+2060 WORD JOINER: invisible, and GitHub no longer sees a mention or reference across it. */
const WJ = "⁠";

/**
 * `s` safe as GitHub text: HTML escaped, and @mentions, #123 and GH-123 references broken with
 * a word joiner (GitHub decodes `&#64;` back into a mention, so escaping can't do it).
 */
export function inert(s: string): string {
  return escapeHtml(s).replace(/@(?=\w)/g, `@${WJ}`).replace(/#(?=\d)/g, `#${WJ}`).replace(/\b(GH-)(?=\d)/gi, `$1${WJ}`);
}

/** An inline code span of `s`: a backtick run longer than any in it, padded when it starts or ends with one. */
export function codeSpan(s: string): string {
  const longest = Math.max(0, ...(s.match(/`+/g) ?? []).map((r) => r.length));
  const tick = "`".repeat(longest + 1);
  const pad = s.startsWith("`") || s.endsWith("`") ? " " : "";
  return `${tick}${pad}${s}${pad}${tick}`;
}

function lang(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? (LANG[name.slice(dot + 1).toLowerCase()] ?? "") : "";
}

/** One list item: the quote's block is indented under the marker so it stays inside the item. */
function stepItem(s: TraceStep, i: number): string {
  const marker = `${i + 1}. `;
  const pad = " ".repeat(marker.length);
  const lines = fenced(s.quote.replace(/\n+$/, "")).split("\n");
  lines[0] += lang(s.path);
  const block = lines.map((l) => (l === "" ? l : pad + l)).join("\n");
  return `${marker}${codeSpan(`${s.path}:${s.line}`)} — ${inert(oneLine(s.note))}\n${block}`;
}

/**
 * The failure path as GitHub markdown, appended to a draft comment: a collapsed `<details>` whose
 * summary is the scenario (one line), the steps numbered with their quotes fenced; the scenario
 * and notes are made `inert`.
 * Empty for an empty trace.
 */
export function traceMarkdown(scenario: string, trace: TraceStep[]): string {
  if (trace.length === 0) return "";
  const summary = inert(oneLine(scenario)) || "Failure path";
  return `\n\n<details><summary>${summary}</summary>\n\n${trace.map(stepItem).join("\n")}\n\n</details>`;
}

/** What Add appends to `f`'s comment: its failure path when riff's check confirmed all of it, else nothing. */
export function draftTrace(f: AiFinding): string {
  if (f.status !== "confirmed" || !f.verification || f.verification.unchecked) return "";
  return traceMarkdown(f.failureScenario ?? "", f.verification.trace);
}
