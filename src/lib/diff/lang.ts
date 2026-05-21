// Map file path → Shiki language ID. Unknown extensions return null (plain text).
// Keep this list pragmatic — Shiki bundles 200+ grammars but we lazy-load only
// what we map here.

const BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "jsonc",
  rs: "rust",
  go: "go",
  py: "python",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  cs: "csharp",
  php: "php",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  ps1: "powershell",
  psm1: "powershell",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  svelte: "svelte",
  vue: "vue",
  md: "markdown",
  mdx: "mdx",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  xml: "xml",
  sql: "sql",
  lua: "lua",
  dart: "dart",
  scala: "scala",
  zig: "zig",
  nix: "nix",
  dockerfile: "docker",
};

const BY_BASENAME: Record<string, string> = {
  Dockerfile: "docker",
  Makefile: "makefile",
  "CMakeLists.txt": "cmake",
};

export function detectLanguage(filePath: string): string | null {
  const norm = filePath.replace(/\\/g, "/");
  const base = norm.slice(norm.lastIndexOf("/") + 1);
  if (BY_BASENAME[base]) return BY_BASENAME[base];

  const dot = base.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return BY_EXT[ext] ?? null;
}

/** Distinct, alphabetically sorted list of Shiki language IDs supported here. */
export const supportedLanguages: string[] = Array.from(
  new Set([...Object.values(BY_EXT), ...Object.values(BY_BASENAME)]),
).sort();
