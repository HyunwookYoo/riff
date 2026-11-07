import type { GhRepo } from "./types";

function ownerName(path: string): { owner: string; name: string } | null {
  const segs = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "").split("/");
  if (segs.length !== 2 || !segs[0] || !segs[1]) return null;
  return { owner: segs[0], name: segs[1] };
}

export function parseRemote(url: string): GhRepo | null {
  const u = url.trim();
  const scp = /^[^@/\s:]+@([^:/\s]+):(.+)$/.exec(u);
  if (scp) {
    const on = ownerName(scp[2]);
    return on && { host: scp[1], ...on };
  }
  try {
    const parsed = new URL(u);
    if (!["http:", "https:", "ssh:", "git:"].includes(parsed.protocol) || !parsed.hostname) return null;
    const on = ownerName(parsed.pathname);
    return on && { host: parsed.hostname, ...on };
  } catch {
    return null;
  }
}
