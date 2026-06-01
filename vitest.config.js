import { defineConfig } from "vitest/config";

// Standalone Vitest config — intentionally does NOT reuse vite.config.js. That
// config loads the SvelteKit plugin, which expects Kit's full module graph and
// misbehaves under Vitest. These are pure-logic unit tests: any module that
// touches Svelte runes ($state in *.svelte.ts) or Tauri `invoke` is mocked in
// the test, so no Svelte compilation or DOM environment is required.
//
// Component (.svelte) rendering tests would additionally need the svelte()
// plugin + jsdom + @testing-library/svelte; out of scope here.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.ts"],
  },
});
