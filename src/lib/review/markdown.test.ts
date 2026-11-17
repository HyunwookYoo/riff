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
  it("passes web and mail links", () => {
    expect(externalUrl("https://x.test/a")).toBe("https://x.test/a");
    expect(externalUrl("http://x.test/")).toBe("http://x.test/");
    expect(externalUrl("mailto:a@x.test")).toBe("mailto:a@x.test");
  });

  it("refuses everything else", () => {
    expect(externalUrl("javascript:alert(1)")).toBeNull();
    expect(externalUrl("file:///c:/x")).toBeNull();
    expect(externalUrl("tauri://localhost/")).toBeNull();
    expect(externalUrl("not a url")).toBeNull();
  });
});
