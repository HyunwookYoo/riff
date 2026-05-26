import { listSubmodules, validateRepo } from "./git";
import type { RepoEntry } from "./types";

/**
 * Last path component, OS-agnostic. Trims trailing slashes so paths like
 * `C:\repo\` produce `repo`, not an empty string.
 */
function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/**
 * Build the full workspace repo list (§13.4) given the main repo path and
 * any manually saved extras. The main repo is always entry 0. Submodules
 * declared in `.gitmodules` are appended automatically — uninitialized ones
 * are skipped (their working tree doesn't exist on disk, so there's nothing
 * to diff). Manual repos that no longer resolve to a valid git repo are
 * dropped silently.
 *
 * Discovery failures are non-fatal: a bad `.gitmodules` shouldn't block the
 * user from opening their main repo. On any error this falls back to
 * `[main only]`.
 */
export async function buildWorkspace(
  mainPath: string,
  manualPaths: string[],
): Promise<RepoEntry[]> {
  const repos: RepoEntry[] = [
    {
      path: mainPath,
      kind: "main",
      displayName: basename(mainPath),
    },
  ];

  try {
    const submodules = await listSubmodules(mainPath);
    for (const sm of submodules) {
      // Uninitialized submodule = no working tree → no files to diff, no
      // blame target. Skip entirely; the user can `git submodule update`
      // and reopen the repo.
      if (!sm.initialized) continue;
      repos.push({
        path: sm.absolute_path,
        kind: "submodule",
        displayName: sm.path, // relative path inside main, e.g. "vendor/sub"
        parentGitlinkPath: sm.path,
      });
    }
  } catch (e) {
    console.warn("listSubmodules failed:", e);
  }

  // Validate manual repos in parallel and append the valid ones in their
  // saved order. Failed entries fall through silently — the user can retry
  // via the Add repo UI later.
  const validated = await Promise.all(
    manualPaths.map(async (p) => {
      try {
        await validateRepo(p);
        return p;
      } catch {
        return null;
      }
    }),
  );
  for (const p of validated) {
    if (p === null) continue;
    repos.push({
      path: p,
      kind: "manual",
      displayName: basename(p),
    });
  }

  return repos;
}
