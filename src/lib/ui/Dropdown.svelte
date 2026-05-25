<script lang="ts">
  // Themed replacement for native <select>. The OS-drawn <select> popup on
  // Windows ignores our color-scheme and shows a light panel even when our
  // app is in dark mode — this component renders the panel as plain HTML
  // so it picks up our design tokens.

  interface Option {
    value: string;
    label: string;
  }
  interface Props {
    value: string;
    options: Option[];
    onchange: (v: string) => void;
    title?: string;
  }

  let { value, options, onchange, title }: Props = $props();

  let open = $state(false);
  let trigger = $state<HTMLButtonElement | undefined>(undefined);
  let panel = $state<HTMLDivElement | undefined>(undefined);
  let highlighted = $state(0);

  const currentLabel = $derived(
    options.find((o) => o.value === value)?.label ?? value,
  );

  function toggle() {
    open = !open;
    if (open) {
      const i = options.findIndex((o) => o.value === value);
      highlighted = i >= 0 ? i : 0;
    }
  }
  function close() {
    open = false;
  }
  function pick(v: string) {
    onchange(v);
    close();
    trigger?.focus();
  }

  function onTriggerKeyDown(e: KeyboardEvent) {
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        toggle();
        e.preventDefault();
      }
      return;
    }
    if (e.key === "Escape") {
      close();
      e.preventDefault();
      return;
    }
    if (e.key === "ArrowDown") {
      highlighted = (highlighted + 1) % options.length;
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      highlighted =
        (highlighted - 1 + options.length) % options.length;
      e.preventDefault();
    } else if (e.key === "Enter") {
      pick(options[highlighted].value);
      e.preventDefault();
    }
  }

  function onWindowMouseDown(e: MouseEvent) {
    if (!open) return;
    const t = e.target as Node;
    if (trigger?.contains(t) || panel?.contains(t)) return;
    close();
  }
</script>

<svelte:window onmousedown={onWindowMouseDown} />

<div class="dropdown">
  <button
    type="button"
    class="trigger"
    bind:this={trigger}
    {title}
    onclick={toggle}
    onkeydown={onTriggerKeyDown}
    aria-haspopup="listbox"
    aria-expanded={open}
  >
    <span class="label">{currentLabel}</span>
    <span class="caret" class:open aria-hidden="true">▾</span>
  </button>
  {#if open}
    <div class="panel" bind:this={panel} role="listbox">
      {#each options as opt, i (opt.value)}
        <button
          type="button"
          class="option"
          class:active={opt.value === value}
          class:highlighted={i === highlighted}
          role="option"
          aria-selected={opt.value === value}
          onmouseenter={() => (highlighted = i)}
          onclick={() => pick(opt.value)}
        >
          {opt.label}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .dropdown {
    position: relative;
    display: inline-block;
  }
  .trigger {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 0.9em;
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--input-bg);
    color: inherit;
    cursor: pointer;
    font-family: inherit;
  }
  .trigger:hover {
    background: var(--hover);
  }
  .caret {
    font-size: 0.7em;
    opacity: 0.6;
    transition: transform 0.1s ease;
  }
  .caret.open {
    transform: rotate(180deg);
  }
  .panel {
    position: absolute;
    top: calc(100% + 2px);
    right: 0;
    min-width: 100%;
    max-height: 320px;
    overflow-y: auto;
    background: var(--input-bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 4px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
    padding: 2px;
    z-index: 1000;
    display: flex;
    flex-direction: column;
  }
  .option {
    border: none;
    background: transparent;
    color: inherit;
    padding: 5px 12px;
    text-align: left;
    cursor: pointer;
    font-size: 0.9em;
    font-family: inherit;
    border-radius: 2px;
    white-space: nowrap;
  }
  .option:hover,
  .option.highlighted {
    background: var(--hover);
  }
  .option.active {
    background: var(--selected);
    color: var(--selected-fg);
  }
</style>
