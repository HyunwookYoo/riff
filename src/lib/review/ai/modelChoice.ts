/** Claude Code `--model` / `--effort` for a run; null leaves the CLI's own setting. */
export interface AiChoice { model: string | null; effort: string | null }

export const MODEL_ALIASES = ["opus", "sonnet", "haiku", "fable"] as const;
/** The `--effort` values `claude --help` lists. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** As `model_ok` in src-tauri/src/ai/mod.rs, which checks again before a run; change both together. */
export function isValidModel(m: string): boolean {
  return /^[A-Za-z0-9._:[\]-]{1,64}$/.test(m) && !m.startsWith("-");
}

export function isValidEffort(e: string): boolean {
  return (EFFORTS as readonly string[]).includes(e);
}

/**
 * The model/effort selects: `model` is "" (default), an alias or "custom" (then `custom` holds
 * the id); `effort` is "" (default) or a level.
 */
export interface ChoiceForm { model: string; custom: string; effort: string }

export function formFromChoice(c: AiChoice): ChoiceForm {
  const alias = c.model === null || (MODEL_ALIASES as readonly string[]).includes(c.model);
  return { model: alias ? (c.model ?? "") : "custom", custom: alias ? "" : c.model!, effort: c.effort ?? "" };
}

/** The choice the form holds; null while the custom model or the effort is invalid. */
export function choiceFromForm(f: ChoiceForm): AiChoice | null {
  const model = f.model === "custom" ? f.custom.trim() : f.model || null;
  const effort = f.effort || null;
  if ((model !== null && !isValidModel(model)) || (effort !== null && !isValidEffort(effort))) return null;
  return { model, effort };
}

/** "opus · high"; "default" for an unset part, or alone when both are. */
export function choiceLabel(c: { model?: string | null; effort?: string | null }): string {
  if (!c.model && !c.effort) return "default";
  return `${c.model ?? "default"} · ${c.effort ?? "default"}`;
}
