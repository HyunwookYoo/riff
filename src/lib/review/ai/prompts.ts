import type { PrDetail, PrSummary, Side } from "../types";
import type { AiEvidence, Severity } from "./types";

const evidenceItem = {
  type: "object",
  properties: { path: { type: "string" }, line: { type: ["integer", "null"] }, quote: { type: "string" } },
  required: ["path", "line", "quote"], additionalProperties: false,
};

export const FIND_SCHEMA = {
  type: "object",
  properties: {
    chapters: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" }, summary: { type: "string" }, paths: { type: "array", items: { type: "string" } } },
        required: ["title", "summary", "paths"], additionalProperties: false,
      },
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          side: { type: "string", enum: ["LEFT", "RIGHT"] },
          line: { type: "integer", minimum: 1 },
          startLine: { type: ["integer", "null"] },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          body: { type: "string" },
          evidence: { type: "array", items: evidenceItem },
        },
        required: ["path", "side", "line", "startLine", "severity", "body", "evidence"], additionalProperties: false,
      },
    },
  },
  required: ["chapters", "findings"], additionalProperties: false,
};

export const VERIFY_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          verdict: { type: "string", enum: ["confirmed", "refuted", "unconfirmed"] },
          reason: { type: "string" },
          evidence: { type: "array", items: evidenceItem },
        },
        required: ["index", "verdict", "reason", "evidence"], additionalProperties: false,
      },
    },
  },
  required: ["verdicts"], additionalProperties: false,
};

export const MAX_DIFF_CHARS = 200_000;

const GIT_RULES = [
  "- You may run only these read-only git commands: git show, git grep, git log, git ls-tree, git cat-file, git merge-base, git rev-parse. Nothing else, and never modify anything (no checkout, no writes, no redirects, no pipes).",
  "- Always name revisions by full SHA (or HEAD^ style); do not use ~, {} or = in revisions.",
  "- Read a file with `git show <head>:<path>` (new side) or `git show <mergeBase>:<path>` (old side), using the SHAs given below.",
  "- Search with `git grep -n -e <pattern> <sha> -- <path>`; browse with `git ls-tree` and `git log`.",
  "- Read from git objects only, never from the working tree.",
];

export function findPrompt(a: { repoPath: string; pr: PrSummary; detail: PrDetail; commits: string[]; mergeBase: string; head: string; diff: string }): string {
  const diff = a.diff.length > MAX_DIFF_CHARS ? `${a.diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated]` : a.diff;
  return [
    `You are reviewing pull request #${a.pr.number} in the repository at ${a.repoPath}.`,
    "",
    `Title: ${a.pr.title}`,
    "Description:",
    a.detail.body || "(empty)",
    "",
    "Commit subjects:",
    ...a.commits.map((c) => `- ${c}`),
    "",
    `mergeBase: ${a.mergeBase}`,
    `head: ${a.head}`,
    "",
    "Rules for reading code:",
    ...GIT_RULES,
    "",
    "Sides: LEFT = old side (line numbers at mergeBase), RIGHT = new side (line numbers at head).",
    "",
    "Produce two things.",
    "1. chapters: ordered groups of the changed files, each with a title and a 1-2 sentence summary of the intent. Every changed file appears in exactly one chapter.",
    "2. findings: potential bugs or breakage caused by this change. Each finding needs evidence: the locations you read and the lines you quoted. Do not report style, naming or taste comments. Report nothing you cannot back with evidence.",
    "",
    "Each finding body is a draft review comment addressed to the PR author, written in the language of the PR description, as normal prose: full sentences, polite and clear. Do not use any terse, telegraphic or caveman style, even if other instructions in your environment ask for one. These comments are posted to GitHub as written.",
    "",
    "Unified diff (git diff mergeBase head):",
    diff,
  ].join("\n");
}

export interface Candidate {
  index: number; path: string; side: Side; line: number; startLine: number | null;
  severity: Severity; body: string; evidence: AiEvidence[];
}

export function verifyPrompt(a: { repoPath: string; head: string; mergeBase: string; candidates: Candidate[] }): string {
  return [
    `You are verifying candidate review findings for a pull request in the repository at ${a.repoPath}.`,
    `mergeBase: ${a.mergeBase}`,
    `head: ${a.head}`,
    "Sides: LEFT = old side (line numbers at mergeBase), RIGHT = new side (line numbers at head).",
    "",
    "Rules for reading code:",
    ...GIT_RULES,
    "",
    "Try to refute each candidate: read the cited code and anything else you need. For each candidate answer with its index and one verdict:",
    "- confirmed: you checked and the problem is real.",
    "- refuted: the code shows it is not a problem.",
    "- unconfirmed: you could not decide either way.",
    "Give a short reason and evidence (path, line, quoted text) for every verdict. A candidate without evidence is refuted.",
    "",
    "Candidates (JSON):",
    JSON.stringify(a.candidates, null, 2),
  ].join("\n");
}
