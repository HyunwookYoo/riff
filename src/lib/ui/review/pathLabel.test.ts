import { describe, it, expect } from "vitest";
import { fileLabel } from "./pathLabel";

describe("fileLabel", () => {
  it("puts the file name first and keeps the last two folders", () => {
    expect(fileLabel("Sandbox/Source/Sandbox/Private/Tests/MCP/McpTool.cpp")).toEqual({
      name: "McpTool.cpp",
      dir: "…/Tests/MCP",
    });
  });
  it("keeps short directories whole", () => {
    expect(fileLabel("Sandbox/Plugins")).toEqual({ name: "Plugins", dir: "Sandbox" });
    expect(fileLabel("src/lib/a.ts")).toEqual({ name: "a.ts", dir: "src/lib" });
  });
  it("has no directory at the root", () => {
    expect(fileLabel("README.md")).toEqual({ name: "README.md", dir: "" });
  });
});
