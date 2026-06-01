<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import { appState } from "$lib/store.svelte";
  import { setParseUnrealAssets, setUassetguiPath } from "$lib/git";

  let open_ = $state(false);

  function basename(p: string): string {
    const t = p.replace(/[\\/]+$/, "");
    const i = Math.max(t.lastIndexOf("/"), t.lastIndexOf("\\"));
    return i >= 0 ? t.slice(i + 1) : t;
  }

  function toggleParse() {
    const next = !appState.parseUnrealAssets;
    appState.parseUnrealAssets = next;
    void setParseUnrealAssets(next);
  }

  async function browse() {
    const sel = await open({
      directory: false,
      multiple: false,
      title: "Select UAssetGUI.exe",
      filters: [{ name: "UAssetGUI", extensions: ["exe"] }],
    });
    if (typeof sel === "string") {
      appState.uassetguiPath = sel;
      void setUassetguiPath(sel);
    }
  }

  function clearPath() {
    appState.uassetguiPath = null;
    void setUassetguiPath(null);
  }
</script>

<div class="unreal-settings">
  <button
    type="button"
    class="trigger"
    class:active={open_}
    class:configured={!!appState.uassetguiPath && appState.parseUnrealAssets}
    title="Unreal asset preview settings"
    onclick={() => (open_ = !open_)}
  >
    UE
  </button>
  {#if open_}
    <button
      type="button"
      class="backdrop"
      aria-label="Close"
      onclick={() => (open_ = false)}
    ></button>
    <div class="panel" role="dialog" aria-label="Unreal asset settings">
      <label class="check-row">
        <input
          type="checkbox"
          checked={appState.parseUnrealAssets}
          onchange={toggleParse}
        />
        <span>Parse Unreal assets (.uasset / .umap)</span>
      </label>

      <div class="path-row">
        <span class="path-label">UAssetGUI.exe</span>
        <span class="path-value" title={appState.uassetguiPath ?? "not set"}>
          {appState.uassetguiPath ? basename(appState.uassetguiPath) : "not set"}
        </span>
        <button type="button" onclick={browse}>Browse…</button>
        {#if appState.uassetguiPath}
          <button type="button" class="clear" onclick={clearPath}>Clear</button>
        {/if}
      </div>

      <p class="hint">
        Renders binary .uasset/.umap diffs as a parsed property view via
        UAssetGUI's <code>tojson</code>. Pick the engine version per file in the
        diff toolbar.
      </p>
    </div>
  {/if}
</div>

<style>
  .unreal-settings {
    position: relative;
    display: inline-flex;
  }
  .trigger {
    padding: 2px 8px;
    border: 1px solid var(--border);
    background: var(--input-bg);
    color: inherit;
    border-radius: 3px;
    cursor: pointer;
    font-size: 0.85em;
    font-weight: 600;
  }
  .trigger.configured {
    border-color: var(--accent);
    color: var(--accent);
  }
  .trigger.active {
    background: var(--accent-soft);
  }
  .backdrop {
    position: fixed;
    inset: 0;
    background: transparent;
    border: 0;
    padding: 0;
    cursor: default;
    z-index: 40;
  }
  .panel {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 41;
    width: 320px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bar-bg);
    box-shadow: 0 6px 20px rgb(0 0 0 / 0.25);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .check-row {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    font-size: 0.9em;
  }
  .path-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.85em;
  }
  .path-label {
    opacity: 0.75;
    white-space: nowrap;
  }
  .path-value {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--mono);
    opacity: 0.85;
  }
  .path-row button {
    padding: 2px 8px;
    border: 1px solid var(--border);
    background: var(--input-bg);
    color: inherit;
    border-radius: 3px;
    cursor: pointer;
    font-size: 0.95em;
    white-space: nowrap;
  }
  .path-row button.clear {
    opacity: 0.7;
  }
  .hint {
    margin: 0;
    font-size: 0.8em;
    opacity: 0.65;
    line-height: 1.4;
  }
  .hint code {
    font-family: var(--mono);
  }
</style>
