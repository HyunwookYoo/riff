/**
 * A changed file's list label: the file name first, then its folder shortened
 * to the last two segments ("…/Tests/MCP"), so long UE paths stay readable.
 */
export function fileLabel(path: string): { name: string; dir: string } {
  const parts = path.split("/");
  const name = parts.pop() ?? path;
  const dir = parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : parts.join("/");
  return { name, dir };
}
