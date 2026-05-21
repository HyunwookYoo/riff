import {
  createHighlighter,
  type BundledLanguage,
  type Highlighter,
  type ThemedToken,
} from "shiki";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { StateField } from "@codemirror/state";

const LIGHT_THEME = "github-light";
const DARK_THEME = "github-dark";

let highlighterPromise: Promise<Highlighter> | null = null;
const loadedLangs = new Set<string>();

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [LIGHT_THEME, DARK_THEME],
      langs: [],
    });
  }
  return highlighterPromise;
}

async function ensureLang(lang: string): Promise<boolean> {
  const hi = await getHighlighter();
  if (loadedLangs.has(lang)) return true;
  try {
    // @ts-expect-error shiki's loadLanguage accepts the bundled lang id as string
    await hi.loadLanguage(lang);
    loadedLangs.add(lang);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a CodeMirror extension that renders Shiki tokens as inline-color decorations.
 * Returns null if the language is unknown or the grammar fails to load.
 */
export async function shikiExtension(
  text: string,
  lang: string | null,
  isDark: boolean,
): Promise<ReturnType<typeof StateField.define<DecorationSet>> | null> {
  if (!lang) return null;
  if (!(await ensureLang(lang))) return null;

  const hi = await getHighlighter();
  let tokenLines: ThemedToken[][];
  try {
    tokenLines = hi.codeToTokensBase(text, {
      lang: lang as BundledLanguage,
      theme: isDark ? DARK_THEME : LIGHT_THEME,
    });
  } catch {
    return null;
  }

  return StateField.define<DecorationSet>({
    create(state) {
      const builder: { from: number; to: number; color?: string }[] = [];
      const doc = state.doc;
      const lineCount = Math.min(tokenLines.length, doc.lines);
      for (let i = 0; i < lineCount; i++) {
        const line = doc.line(i + 1);
        let offset = line.from;
        for (const tok of tokenLines[i]) {
          const len = tok.content.length;
          if (len === 0) {
            continue;
          }
          const to = Math.min(offset + len, line.to);
          if (tok.color && to > offset) {
            builder.push({ from: offset, to, color: tok.color });
          }
          offset = to;
          if (offset >= line.to) break;
        }
      }
      const decos = builder.map(({ from, to, color }) =>
        Decoration.mark({ attributes: { style: `color:${color}` } }).range(
          from,
          to,
        ),
      );
      return Decoration.set(decos, true);
    },
    update(value) {
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}

import { appState } from "../store.svelte";

export function isDarkMode(): boolean {
  return appState.effectiveTheme === "dark";
}

/**
 * Warm the Shiki highlighter in the background so the first file click
 * doesn't pay for `createHighlighter`. Safe to call multiple times.
 */
export function preheatHighlighter(): void {
  void getHighlighter();
}

/**
 * Background-load the given Shiki language IDs (deduped). Nulls are skipped.
 * Errors per language are swallowed — preload is best-effort.
 */
export async function preloadLanguages(
  langs: Iterable<string | null>,
): Promise<void> {
  const unique = new Set<string>();
  for (const l of langs) {
    if (l) unique.add(l);
  }
  if (unique.size === 0) return;
  await Promise.allSettled(Array.from(unique).map((l) => ensureLang(l)));
}
