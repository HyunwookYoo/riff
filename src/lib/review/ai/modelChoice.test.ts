import { describe, expect, it } from "vitest";
import { EFFORTS, MODEL_ALIASES, choiceFromForm, choiceLabel, formFromChoice, isValidEffort, isValidModel } from "./modelChoice";

describe("model / effort validation", () => {
  it("accepts aliases, full ids and [1m] suffixes", () => {
    for (const m of [...MODEL_ALIASES, "claude-opus-5-5", "opus[1m]", "us.anthropic.claude:v1_2", "a".repeat(64)]) {
      expect(isValidModel(m), m).toBe(true);
    }
  });
  it("rejects empty, spaced, shell-ish, flag-like and over-long models", () => {
    for (const m of ["", "opus 4", "opus;x", "a/b", "-p", "--dangerously-skip-permissions", "é", "a".repeat(65)]) {
      expect(isValidModel(m), m).toBe(false);
    }
  });
  it("accepts only the CLI's effort levels", () => {
    expect(EFFORTS).toEqual(["low", "medium", "high", "xhigh", "max"]);
    for (const e of EFFORTS) expect(isValidEffort(e)).toBe(true);
    for (const e of ["", "HIGH", "extreme", "high "]) expect(isValidEffort(e), e).toBe(false);
  });
});

describe("model / effort form", () => {
  it("maps a choice to the selects, custom ids to the text field", () => {
    expect(formFromChoice({ model: null, effort: null })).toEqual({ model: "", custom: "", effort: "" });
    expect(formFromChoice({ model: "opus", effort: "high" })).toEqual({ model: "opus", custom: "", effort: "high" });
    expect(formFromChoice({ model: "claude-opus-5-5", effort: null })).toEqual({ model: "custom", custom: "claude-opus-5-5", effort: "" });
  });
  it("reads the form back, or null when the custom model or effort is invalid", () => {
    expect(choiceFromForm({ model: "", custom: "ignored", effort: "" })).toEqual({ model: null, effort: null });
    expect(choiceFromForm({ model: "sonnet", custom: "", effort: "max" })).toEqual({ model: "sonnet", effort: "max" });
    expect(choiceFromForm({ model: "custom", custom: "  opus[1m] ", effort: "low" })).toEqual({ model: "opus[1m]", effort: "low" });
    expect(choiceFromForm({ model: "custom", custom: "  ", effort: "" })).toBeNull();
    expect(choiceFromForm({ model: "custom", custom: "bad model", effort: "" })).toBeNull();
    expect(choiceFromForm({ model: "", custom: "", effort: "extreme" })).toBeNull();
  });
  it("round-trips", () => {
    for (const c of [{ model: null, effort: "xhigh" }, { model: "fable", effort: null }, { model: "claude-x-1", effort: "low" }]) {
      expect(choiceFromForm(formFromChoice(c))).toEqual(c);
    }
  });
});

describe("choiceLabel", () => {
  it("names each part, 'default' when unset or absent", () => {
    expect(choiceLabel({ model: "opus", effort: "high" })).toBe("opus · high");
    expect(choiceLabel({ model: null, effort: "low" })).toBe("default · low");
    expect(choiceLabel({ model: "sonnet", effort: null })).toBe("sonnet · default");
    expect(choiceLabel({})).toBe("default");
    expect(choiceLabel({ model: null, effort: null })).toBe("default");
  });
});
