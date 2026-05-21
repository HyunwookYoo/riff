import type { ChangedFile } from "$lib/types";

export type TreeNode =
  | { kind: "file"; file: ChangedFile }
  | { kind: "dir"; name: string; path: string; children: TreeNode[] };

interface DirAccum {
  kind: "dir";
  name: string;
  path: string;
  children: TreeNode[];
  byName: Map<string, DirAccum>;
}

function newDir(name: string, path: string): DirAccum {
  return { kind: "dir", name, path, children: [], byName: new Map() };
}

/** Build a sorted tree (dirs first, then files; each group alphabetical). */
export function buildTree(files: ChangedFile[]): TreeNode[] {
  const root = newDir("", "");
  for (const f of files) {
    const parts = f.path.split("/");
    let cur: DirAccum = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      let next = cur.byName.get(part);
      if (!next) {
        const dirPath = parts.slice(0, i + 1).join("/");
        next = newDir(part, dirPath);
        cur.children.push(next);
        cur.byName.set(part, next);
      }
      cur = next;
    }
    cur.children.push({ kind: "file", file: f });
  }
  return sortNodes(root.children);
}

function sortNodes(nodes: TreeNode[]): TreeNode[] {
  for (const n of nodes) {
    if (n.kind === "dir") {
      sortNodes(n.children);
    }
  }
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    const an = a.kind === "dir" ? a.name : a.file.path;
    const bn = b.kind === "dir" ? b.name : b.file.path;
    return an.localeCompare(bn);
  });
  return nodes;
}
