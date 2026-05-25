/// Recursive tree built from a flat list of repo-relative file paths
/// (`git ls-files` output). Used by the blame-mode file picker.
export type TreePathNode =
  | { kind: "file"; name: string; path: string }
  | { kind: "dir"; name: string; path: string; children: TreePathNode[] };

interface DirAccum {
  kind: "dir";
  name: string;
  path: string;
  children: TreePathNode[];
  byName: Map<string, DirAccum>;
}

/** Build a sorted tree (dirs first, then files; each group alphabetical). */
export function buildPathTree(paths: string[]): TreePathNode[] {
  const root: DirAccum = {
    kind: "dir",
    name: "",
    path: "",
    children: [],
    byName: new Map(),
  };
  for (const p of paths) {
    if (!p) continue;
    const parts = p.split("/");
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      let next = cur.byName.get(name);
      if (!next) {
        const dirPath = parts.slice(0, i + 1).join("/");
        next = {
          kind: "dir",
          name,
          path: dirPath,
          children: [],
          byName: new Map(),
        };
        cur.children.push(next);
        cur.byName.set(name, next);
      }
      cur = next;
    }
    const leaf = parts[parts.length - 1];
    cur.children.push({ kind: "file", name: leaf, path: p });
  }
  sortNodes(root.children);
  return root.children;
}

function sortNodes(nodes: TreePathNode[]): void {
  for (const n of nodes) {
    if (n.kind === "dir") sortNodes(n.children);
  }
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** Every directory above `filePath`. `src/lib/ui/Foo.svelte` →
 * `["src", "src/lib", "src/lib/ui"]`. Empty for top-level files. */
export function ancestorDirs(filePath: string): string[] {
  const parts = filePath.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    out.push(parts.slice(0, i).join("/"));
  }
  return out;
}
