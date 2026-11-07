import { describe, it, expect } from "vitest";
import { parseRemote } from "./remote";

describe("parseRemote", () => {
  it("parses scp-style", () => {
    expect(parseRemote("git@github.krafton.com:sbx/sandbox.git")).toEqual({ host: "github.krafton.com", owner: "sbx", name: "sandbox" });
  });
  it("parses ssh url with port", () => {
    expect(parseRemote("ssh://git@github.com:22/a/b.git")).toEqual({ host: "github.com", owner: "a", name: "b" });
  });
  it("parses https variants", () => {
    expect(parseRemote("https://github.com/a/b")).toEqual({ host: "github.com", owner: "a", name: "b" });
    expect(parseRemote("https://user@github.com/a/b.git/")).toEqual({ host: "github.com", owner: "a", name: "b" });
  });
  it("rejects non-remotes", () => {
    expect(parseRemote("C:/repos/x")).toBeNull();
    expect(parseRemote("file:///x")).toBeNull();
    expect(parseRemote("https://host/only-one-segment")).toBeNull();
  });
});
