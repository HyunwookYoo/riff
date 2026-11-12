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
  return `${marker}\`${s.path}:${s.line}\` — ${oneLine(s.note)}\n${block}`;
}

/**
 * The failure path as GitHub markdown, appended to a draft comment: a collapsed `<details>` whose
 * summary is the scenario (one line, HTML-escaped), the steps numbered with their quotes fenced.
 * Empty for an empty trace.
 */
export function traceMarkdown(scenario: string, trace: TraceStep[]): string {
  if (trace.length === 0) return "";
  const summary = escapeHtml(oneLine(scenario)) || "Failure path";
  return `\n\n<details><summary>${summary}</summary>\n\n${trace.map(stepItem).join("\n")}\n\n</details>`;
}

/** What Add appends to `f`'s comment: its failure path when riff's check confirmed it, else nothing. */
export function draftTrace(f: AiFinding): string {
  if (f.status !== "confirmed" || !f.verification) return "";
  return traceMarkdown(f.failureScenario ?? "", f.verification.trace);
}
