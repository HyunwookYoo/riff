import { describe, expect, it } from "vitest";
import { checkRobloxEvidence, citedDocs, docsDateLabel, downgradeUnchecked, repoKey, robloxApisOf, withParity } from "./roblox";
import type { AiFinding } from "./types";
import type { ApiDoc } from "../../types";

const docs: ApiDoc[] = [
  { name: "BasePart", path: "classes/BasePart.yaml", text: "name: BasePart\ndescription: |\n  A part that\n    can be anchored.\n" },
  { name: "Enum.Material", path: "enums/Material.yaml", text: "name: Material\nitems: [Plastic]\n" },
];
const ev = (path: string, quote: string) => ({ evidence: [{ path, line: null, quote }] });

describe("repoKey", () => {
  it("is host/owner/name, lowercased", () => {
    expect(repoKey({ host: "GitHub.com", owner: "Acme", name: "Widgets" })).toBe("github.com/acme/widgets");
  });
});

describe("checkRobloxEvidence", () => {
  it("passes a quote found in the cited file", () => {
    expect(checkRobloxEvidence(ev("roblox:classes/BasePart.yaml", "can be anchored."), docs)).toBe(true);
  });
  it("collapses whitespace on both sides", () => {
    expect(checkRobloxEvidence(ev("roblox:classes/BasePart.yaml", "A part that can   be\nanchored"), docs)).toBe(true);
  });
  it("fails when the quote is in another file than the one cited", () => {
    expect(checkRobloxEvidence(ev("roblox:enums/Material.yaml", "can be anchored"), docs)).toBe(false);
  });
  it("fails for a file riff did not supply, a missing or empty quote, or no roblox evidence", () => {
    expect(checkRobloxEvidence(ev("roblox:classes/Humanoid.yaml", "name"), docs)).toBe(false);
    expect(checkRobloxEvidence(ev("roblox:classes/BasePart.yaml", "cannot be anchored"), docs)).toBe(false);
    expect(checkRobloxEvidence(ev("roblox:classes/BasePart.yaml", "  \n "), docs)).toBe(false);
    expect(checkRobloxEvidence(ev("classes/BasePart.yaml", "can be anchored"), docs)).toBe(false);
    expect(checkRobloxEvidence({ evidence: [] }, docs)).toBe(false);
  });
  it("one checked quote is enough", () => {
    const c = { evidence: [...ev("a.ts", "x").evidence, ...ev("roblox:enums/Material.yaml", "Plastic").evidence] };
    expect(checkRobloxEvidence(c, docs)).toBe(true);
  });
});

describe("robloxApisOf", () => {
  it("takes trimmed, distinct, non-empty names", () => {
    expect(robloxApisOf({ robloxApis: [" BasePart ", "BasePart", "", 3, "Enum.Material"] })).toEqual(["BasePart", "Enum.Material"]);
  });
  it("is empty when absent or malformed", () => {
    expect(robloxApisOf({})).toEqual([]);
    expect(robloxApisOf({ robloxApis: "BasePart" })).toEqual([]);
    expect(robloxApisOf(null)).toEqual([]);
  });
});

describe("citedDocs", () => {
  it("returns the supplied docs the candidates cite, once each", () => {
    const cands = [ev("roblox:enums/Material.yaml", "q"), ev("roblox:enums/Material.yaml", "r"), ev("a.ts", "x")];
    expect(citedDocs(cands, docs)).toEqual([docs[1]]);
    expect(citedDocs([ev("roblox:classes/Nope.yaml", "q")], docs)).toEqual([]);
  });
});

describe("downgradeUnchecked", () => {
  const f = (o: Partial<AiFinding>): AiFinding => ({
    id: "f0", path: "a.ts", side: "RIGHT", line: 1, startLine: null, severity: "high", body: "b",
    evidence: [], status: "confirmed", quote: [], ...o,
  });
  it("makes a confirmed Roblox finding without a checked quote unconfirmed, and leaves the rest", () => {
    const good = f({ tag: "roblox", ...ev("roblox:enums/Material.yaml", "Plastic") });
    const bad = f({ tag: "roblox", ...ev("roblox:enums/Material.yaml", "Wood") });
    const plain = f({ ...ev("a.ts", "Wood") });
    expect(downgradeUnchecked([good, bad, plain], docs)).toEqual([good, { ...bad, status: "unconfirmed" }, plain]);
  });
});

describe("withParity", () => {
  it("appends the key once when on and drops it when off", () => {
    expect(withParity(["a/b/c"], "h/o/n", true)).toEqual(["a/b/c", "h/o/n"]);
    expect(withParity(["h/o/n", "a/b/c"], "h/o/n", true)).toEqual(["a/b/c", "h/o/n"]);
    expect(withParity(["h/o/n", "a/b/c"], "h/o/n", false)).toEqual(["a/b/c"]);
    expect(withParity([], "h/o/n", false)).toEqual([]);
  });
});

describe("docsDateLabel", () => {
  it("is the date part of the commit date, or not downloaded", () => {
    expect(docsDateLabel({ date: "2026-11-10T21:04:00+09:00" })).toBe("2026-11-10");
    expect(docsDateLabel(null)).toBe("not downloaded");
  });
});
