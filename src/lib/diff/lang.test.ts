import { describe, it, expect } from "vitest";
import { detectLanguage, supportedLanguages } from "./lang";

describe("detectLanguage", () => {
  it("maps common extensions to Shiki language IDs", () => {
    expect(detectLanguage("src/main.ts")).toBe("typescript");
    expect(detectLanguage("a/b/c.rs")).toBe("rust");
    expect(detectLanguage("script.lua")).toBe("lua");
    expect(detectLanguage("Component.svelte")).toBe("svelte");
  });

  it("lowercases the extension before lookup", () => {
    expect(detectLanguage("README.MD")).toBe("markdown");
    expect(detectLanguage("Main.JSON")).toBe("json");
  });

  it("normalizes Windows backslash paths", () => {
    expect(detectLanguage("C:\\proj\\src\\lib.rs")).toBe("rust");
  });

  it("matches well-known basenames over extension", () => {
    expect(detectLanguage("path/to/Dockerfile")).toBe("docker");
    expect(detectLanguage("Makefile")).toBe("makefile");
    // basename map wins even though the file has a (.txt) extension
    expect(detectLanguage("proj/CMakeLists.txt")).toBe("cmake");
  });

  it("returns null for unknown and extension-less paths", () => {
    expect(detectLanguage("notes.unknownext")).toBeNull();
    expect(detectLanguage("LICENSE")).toBeNull();
    expect(detectLanguage("noext")).toBeNull();
  });

  it("considers only the final extension", () => {
    expect(detectLanguage("archive.tar.gz")).toBeNull(); // gz is unmapped
    expect(detectLanguage("config.test.ts")).toBe("typescript");
  });
});

describe("supportedLanguages", () => {
  it("is sorted and de-duplicated", () => {
    expect(supportedLanguages).toEqual([...supportedLanguages].sort());
    expect(new Set(supportedLanguages).size).toBe(supportedLanguages.length);
  });

  it("includes languages from both the extension and basename maps", () => {
    expect(supportedLanguages).toContain("rust");
    expect(supportedLanguages).toContain("docker"); // from Dockerfile basename
  });
});
