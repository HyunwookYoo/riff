import { Channel, invoke } from "@tauri-apps/api/core";

type AiEvent =
  | { kind: "activity"; text: string }
  | {
      kind: "result"; output: unknown; cost_usd: number | null;
      subtype: string | null; is_error: boolean; result: string | null;
    };

// Random start: the backend's cancelled set outlives a webview reload (see rebaseCheck.ts).
let nextRunId = crypto.getRandomValues(new Uint32Array(1))[0] >>> 1;

/**
 * One read-only Claude Code run in the repo at `path`. `onActivity` gets a
 * line per tool call; `done` resolves to the output matching `schema`, or
 * rejects with the CLI's message, or "cancelled" after `cancel()`.
 */
export function aiRun(
  path: string,
  prompt: string,
  schema: object,
  onActivity: (t: string) => void,
): { done: Promise<unknown>; cancel: () => void } {
  const id = nextRunId++;
  const channel = new Channel<AiEvent>();
  channel.onmessage = (e) => {
    if (e.kind === "activity") onActivity(e.text);
  };
  const done = invoke<unknown>("ai_run", {
    path,
    prompt,
    schema: JSON.stringify(schema),
    model: null,
    id,
    onEvent: channel,
  });
  return { done, cancel: () => void invoke("cancel_ai_run", { id }).catch(() => {}) };
}
