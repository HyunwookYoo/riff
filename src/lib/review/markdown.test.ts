// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { externalUrl, sanitizeHtml } from "./markdown";

describe("sanitizeHtml", () => {
  it("drops scripts", () => {
    const out = sanitizeHtml("<p>a</p><script>alert(1)</script>");
    expect(out).toContain("<p>a</p>");
    expect(out).not.toContain("script");
  });

  it("drops event handlers", () => {
    expect(sanitizeHtml('<img src="x" onerror="alert(1)">')).not.toContain("onerror");
  });

  it("drops javascript: links", () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).not.toContain("javascript:");
  });

  it("drops style and forms", () => {
    const out = sanitizeHtml('<p style="color:red">x</p><style>p{}</style><form><input name="q"></form>');
    expect(out).not.toContain("style");
    expect(out).not.toContain("<form");
  });

  it("drops SVG, MathML and image-map links, which navigate without an <a>", () => {
    const out = sanitizeHtml(
      '<svg><a xlink:href="https://evil.test/"><text>x</text></a></svg>' +
        '<math><mi xlink:href="https://evil.test/">y</mi></math>' +
        '<map name="m"><area href="https://evil.test/"></map>',
    );
    expect(out).not.toContain("evil.test");
    expect(out).not.toMatch(/<(svg|math|area|map)/);
  });

  it("keeps GitHub's markdown output", () => {
    const html =
      "<h2>t</h2><table><tbody><tr><td>1</td></tr></tbody></table>" +
      "<details><summary>s</summary>b</details>" +
      '<a href="https://x.test/">l</a>' +
      '<ul><li class="task-list-item"><input type="checkbox" disabled="" checked=""> done</li></ul>';
    const out = sanitizeHtml(html);
    expect(out).toContain("<h2>t</h2>");
    expect(out).toContain("<td>1</td>");
    expect(out).toContain("<details><summary>s</summary>b</details>");
    expect(out).toContain('href="https://x.test/"');
    expect(out).toMatch(/<input[^>]*type="checkbox"[^>]*disabled/);
  });
});

describe("externalUrl", () => {
  const pr = "https://github.test/o/r/pull/1";

  it("passes web and mail links", () => {
    expect(externalUrl("https://x.test/a", pr)).toBe("https://x.test/a");
    expect(externalUrl("http://x.test/", pr)).toBe("http://x.test/");
    expect(externalUrl("mailto:a@x.test", pr)).toBe("mailto:a@x.test");
  });

  it("resolves relative links against the PR page, as GitHub does", () => {
    expect(externalUrl("/o/r/blob/main/a.md", pr)).toBe("https://github.test/o/r/blob/main/a.md");
    expect(externalUrl("files", pr)).toBe("https://github.test/o/r/pull/files");
  });

  it("refuses in-page and empty links", () => {
    expect(externalUrl("#user-content-fn-1", pr)).toBeNull();
    expect(externalUrl("", pr)).toBeNull();
  });

  it("refuses relative links without a base", () => {
    expect(externalUrl("/o/r", "")).toBeNull();
    expect(externalUrl("https://x.test/", "")).toBe("https://x.test/");
  });

  it("refuses everything else", () => {
    expect(externalUrl("javascript:alert(1)", pr)).toBeNull();
    expect(externalUrl("file:///c:/x", pr)).toBeNull();
    expect(externalUrl("tauri://localhost/", pr)).toBeNull();
    expect(externalUrl("http://[bad", pr)).toBeNull();
  });
});
