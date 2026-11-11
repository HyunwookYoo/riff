import { describe, expect, it } from "vitest";
import { trimDiff } from "./diffTrim";

const text = (path: string) => `diff --git a/${path} b/${path}
index 1111111..2222222 100644
--- a/${path}
+++ b/${path}
@@ -1 +1 @@
-old
+new
`;

describe("trimDiff", () => {
  it("drops asset sections (any case) and keeps code, in order", () => {
    const keep1 = text("src/a.ts"), keep2 = text("src/b cpp.cpp");
    const r = trimDiff(keep1 + text("Content/Hero.UASSET") + keep2 + text("Maps/L.umap"));
    expect(r.diff).toBe(keep1 + keep2);
    expect(r.omitted).toEqual(["Content/Hero.UASSET", "Maps/L.umap"]);
  });

  it("uses the new path of a rename", () => {
    const rename = "diff --git a/old.txt b/tex/new.png\nsimilarity index 100%\nrename from old.txt\nrename to tex/new.png\n";
    const back = "diff --git a/old.png b/new.txt\nsimilarity index 100%\nrename from old.png\nrename to new.txt\n";
    const r = trimDiff(rename + back);
    expect(r.diff).toBe(back);
    expect(r.omitted).toEqual(["tex/new.png"]);
  });

  it("uses the old path of a deletion", () => {
    const del = "diff --git a/snd/hit.wav b/snd/hit.wav\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/snd/hit.wav\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n";
    const r = trimDiff(del + text("a.ts"));
    expect(r.diff).toBe(text("a.ts"));
    expect(r.omitted).toEqual(["snd/hit.wav"]);
  });

  it("drops binary sections whatever the extension", () => {
    const bin = "diff --git a/data/blob b/data/blob\nindex 1111111..2222222 100644\nBinary files a/data/blob and b/data/blob differ\n";
    const patch = "diff --git a/x.dat b/x.dat\nnew file mode 100644\nindex 0000000..2222222\nGIT binary patch\nliteral 3\nKcmZQz\n\nliteral 0\nHcmV?d00001\n\n";
    const r = trimDiff(bin + text("a.ts") + patch);
    expect(r.diff).toBe(text("a.ts"));
    expect(r.omitted).toEqual(["data/blob", "x.dat"]);
  });

  it("keeps a text line that only mentions a binary marker", () => {
    const d = "diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1 +1 @@\n-Binary files a and b differ\n+GIT binary patch\n";
    expect(trimDiff(d)).toEqual({ diff: d, omitted: [] });
  });

  it("returns text with no sections as is", () => {
    expect(trimDiff("")).toEqual({ diff: "", omitted: [] });
    expect(trimDiff("not a diff\n")).toEqual({ diff: "not a diff\n", omitted: [] });
  });
});
