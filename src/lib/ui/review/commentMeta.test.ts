import { describe, it, expect } from "vitest";
import { authorHue, commentRoles, initials } from "./commentMeta";

describe("commentMeta", () => {
  it("initials take the first letter of up to two name parts", () => {
    expect(initials("kdongil")).toBe("K");
    expect(initials("alex-kang")).toBe("AK");
    expect(initials("sbx_cicd_bot")).toBe("SC");
    expect(initials("유현욱")).toBe("유");
    expect(initials("")).toBe("?");
  });

  it("authorHue is stable per name and within 0..359", () => {
    expect(authorHue("kdongil")).toBe(authorHue("kdongil"));
    expect(authorHue("kdongil")).not.toBe(authorHue("gentlius"));
    for (const n of ["a", "kdongil", "gentlius", "sbx-cicd-bot", "유현욱"]) {
      const h = authorHue(n);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });

  it("commentRoles marks the PR author and the viewer", () => {
    expect(commentRoles("kim", "kim", "me")).toEqual(["Author"]);
    expect(commentRoles("me", "kim", "me")).toEqual(["You"]);
    expect(commentRoles("me", "me", "me")).toEqual(["You", "Author"]);
    expect(commentRoles("lee", "kim", null)).toEqual([]);
    expect(commentRoles("Kim", "kim", null)).toEqual(["Author"]);
  });
});
