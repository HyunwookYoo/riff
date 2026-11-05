import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./git", () => ({
  rebaseCheck: vi.fn(),
  cancelRebaseCheck: vi.fn(),
}));

import { rebaseCheck, cancelRebaseCheck } from "./git";
import {
  startRebaseCheck,
  checkText,
  checkBadge,
  filesText,
  aiRequest,
  type CheckState,
  type ConflictCheck,
} from "./rebaseCheck";
import type { Commit, RebaseCheck } from "./types";

const mockCheck = vi.mocked(rebaseCheck);
const mockCancel = vi.mocked(cancelRebaseCheck);

const commit: Commit = {
  sha: "abcdef1234567",
  short_sha: "abcdef1",
  parents: [],
  author: "a",
  time: 0,
  summary: "fix the thing",
  refs: [],
  body: "",
};
const conflict: ConflictCheck = {
  kind: "conflict",
  at: 2,
  total: 5,
  commit,
  files: [
    { path: "a.txt", kind: null },
    { path: "b.uasset", kind: "binary" },
  ],
};

beforeEach(() => {
  mockCheck.mockReset();
  mockCancel.mockReset();
  mockCancel.mockResolvedValue(undefined);
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("startRebaseCheck", () => {
  it("emits checking, progress, then the result", async () => {
    mockCheck.mockImplementation(async (...args) => {
      args[5]({ done: 1, total: 3 });
      return { kind: "clean", commits: 3 } as RebaseCheck;
    });
    const seen: CheckState[] = [];
    startRebaseCheck("/r", "main", "feat", null, (s) => seen.push(s));
    await flush();
    expect(seen).toEqual([
      { kind: "checking", done: 0, total: 0 },
      { kind: "checking", done: 1, total: 3 },
      { kind: "clean", commits: 3 },
    ]);
  });

  it("emits nothing after cancel and cancels the same id", async () => {
    let resolve!: (r: RebaseCheck) => void;
    mockCheck.mockImplementation(() => new Promise((r) => (resolve = r)));
    const seen: CheckState[] = [];
    const cancel = startRebaseCheck("/r", "main", "feat", null, (s) =>
      seen.push(s),
    );
    cancel();
    resolve({ kind: "clean", commits: 1 });
    await flush();
    expect(seen).toEqual([{ kind: "checking", done: 0, total: 0 }]);
    expect(mockCancel).toHaveBeenCalledWith(mockCheck.mock.calls[0][4]);
  });

  it("cancel after the result is a no-op", async () => {
    mockCheck.mockResolvedValue({ kind: "clean", commits: 1 });
    const cancel = startRebaseCheck("/r", "main", "feat", null, () => {});
    await flush();
    cancel();
    expect(mockCancel).not.toHaveBeenCalled();
  });

  it("does not emit progress that arrives after the result", async () => {
    let report!: (p: { done: number; total: number }) => void;
    mockCheck.mockImplementation(async (...args) => {
      report = args[5];
      return { kind: "clean", commits: 1 } as RebaseCheck;
    });
    const seen: CheckState[] = [];
    startRebaseCheck("/r", "main", "feat", null, (s) => seen.push(s));
    await flush();
    report({ done: 1, total: 1 });
    expect(seen[seen.length - 1]).toEqual({ kind: "clean", commits: 1 });
    expect(seen).toHaveLength(2);
  });

  it("uses a different id per start", () => {
    mockCheck.mockReturnValue(new Promise(() => {}));
    startRebaseCheck("/r", "main", "feat", null, () => {});
    startRebaseCheck("/r", "main", "feat", null, () => {});
    expect(mockCheck.mock.calls[0][4]).not.toBe(mockCheck.mock.calls[1][4]);
  });

  it("turns a rejection into cant_check with the first line", async () => {
    mockCheck.mockRejectedValue("fatal: bad revision 'x'\nmore");
    const seen: CheckState[] = [];
    startRebaseCheck("/r", "main", "feat", null, (s) => seen.push(s));
    await flush();
    expect(seen[seen.length - 1]).toEqual({
      kind: "cant_check",
      reason: "fatal: bad revision 'x'",
    });
  });

  it("does not emit a cancelled result", async () => {
    mockCheck.mockResolvedValue({ kind: "cancelled" });
    const seen: CheckState[] = [];
    startRebaseCheck("/r", "main", "feat", null, (s) => seen.push(s));
    await flush();
    expect(seen).toEqual([{ kind: "checking", done: 0, total: 0 }]);
  });

  it("passes a null branch as an empty string", () => {
    mockCheck.mockReturnValue(new Promise(() => {}));
    startRebaseCheck("/r", "main", null, null, () => {});
    expect(mockCheck.mock.calls[0][2]).toBe("");
  });
});

describe("checkText / checkBadge", () => {
  const cases: [CheckState, string, string][] = [
    [{ kind: "checking", done: 0, total: 0 }, "checking…", "checking…"],
    [
      { kind: "checking", done: 2, total: 5 },
      "checking 2/5…",
      "checking 2/5…",
    ],
    [
      { kind: "clean", commits: 3 },
      "✓ no conflicts (3 commits)",
      "✓",
    ],
    [
      { kind: "clean", commits: 1 },
      "✓ no conflicts (1 commit)",
      "✓",
    ],
    [
      conflict,
      "⚠ conflict at abcdef1 fix the thing (2 of 5)",
      "⚠ conflict at abcdef1",
    ],
    [{ kind: "nothing" }, "nothing to rebase", "nothing to rebase"],
    [
      { kind: "cant_check", reason: "boom" },
      "can't check (boom)",
      "can't check (boom)",
    ],
  ];
  it.each(cases)("%j", (s, text, badge) => {
    expect(checkText(s)).toBe(text);
    expect(checkBadge(s)).toBe(badge);
  });
});

describe("filesText", () => {
  it("marks binary files", () => {
    expect(
      filesText([
        { path: "a.txt", kind: null },
        { path: "b.uasset", kind: "binary" },
      ]),
    ).toBe("a.txt, b.uasset (binary)");
  });

  it("labels any kind merge-tree names", () => {
    expect(
      filesText([
        { path: "sub", kind: "submodule" },
        { path: "x", kind: "modify/delete" },
        { path: "a.txt", kind: null },
      ]),
    ).toBe("sub (submodule), x (modify/delete), a.txt");
  });
});

describe("aiRequest", () => {
  const head = [
    "C:/repo 에서 feat 를 main 위로 rebase 해줘.",
  ];
  const tail = [
    "riff 미리 보기에서 conflict 가 예상돼:",
    '- abcdef1 "fix the thing" (5개 중 2번째): a.txt, b.uasset (binary)',
    "이후 커밋도 conflict 가 날 수 있어.",
    "conflict 마다 양쪽 커밋의 의도를 확인하고 해결해. 의도가 애매하면 멈추고 물어봐.",
    "끝나면 각 conflict 를 어떻게 해결했는지 요약해줘.",
  ];
  const base = { repoPath: "C:/repo", branch: "feat", target: "main", conflict };

  it("builds a plain request", () => {
    expect(aiRequest(base)).toBe([...head, ...tail].join("\n"));
  });

  it("labels a non-binary kind in the file line", () => {
    const c = { ...conflict, files: [{ path: "sub", kind: "submodule" }] };
    expect(aiRequest({ ...base, conflict: c })).toContain(
      '(5개 중 2번째): sub (submodule)\n',
    );
  });

  it("includes the plan block", () => {
    const plan = [
      { action: "pick" as const, short: "1111111", summary: "one" },
      { action: "drop" as const, short: "2222222", summary: "two" },
    ];
    expect(aiRequest({ ...base, plan })).toBe(
      [
        ...head,
        "interactive rebase 로, 아래 계획대로 진행해 (위에서부터 순서대로):",
        "  pick 1111111 one",
        "  drop 2222222 two",
        ...tail,
      ].join("\n"),
    );
  });
});
