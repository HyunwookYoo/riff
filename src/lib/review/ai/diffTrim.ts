const ASSET = /\.(uasset|umap|uexp|ubulk|fbx|png|tga|psd|wav|mp3|bin)$/i;
const HEADER = "diff --git ";

/**
 * The path a section is about: the new path, or the old one for a deletion. Without
 * ---/+++ or rename lines (binary, mode-only) the header is `a/P b/P`, so P is its first half.
 */
function sectionPath(lines: string[]): string {
  let minus: string | null = null;
  for (const l of lines) {
    if (l.startsWith("@@")) break;
    if (l.startsWith("rename to ")) return l.slice(10);
    if (l.startsWith("+++ b/")) return l.slice(6);
    if (l.startsWith("--- a/")) minus = l.slice(6);
  }
  if (minus !== null) return minus;
  const rest = lines[0].slice(HEADER.length);
  return rest.startsWith("a/") ? rest.slice(2, (rest.length - 1) / 2) : rest;
}

/** `diff` (git's unified output) without asset and binary file sections; `omitted` = their paths. */
export function trimDiff(diff: string): { diff: string; omitted: string[] } {
  const omitted: string[] = [];
  const kept = diff.split(/^(?=diff --git )/m).filter((s) => {
    if (!s.startsWith(HEADER)) return true;
    const lines = s.split(/\r?\n/);
    // Hunk lines start with " ", "+" or "-", so these can only be git's own markers.
    const binary = lines.some((l) => l.startsWith("Binary files ") || l === "GIT binary patch");
    const path = sectionPath(lines);
    if (!binary && !ASSET.test(path)) return true;
    omitted.push(path);
    return false;
  });
  return { diff: kept.join(""), omitted };
}
