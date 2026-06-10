<script lang="ts">
  interface Props {
    // Image source URLs (data: URLs); empty/null for an absent side.
    oldSrc: string | null;
    newSrc: string | null;
    oldSize: number;
    newSize: number;
  }
  let { oldSrc, newSrc, oldSize, newSize }: Props = $props();

  const oldUrl = $derived(oldSrc || null);
  const newUrl = $derived(newSrc || null);
  const bothSides = $derived(!!oldUrl && !!newUrl);

  // side | swipe | onion. Overlay modes need both sides.
  let mode = $state<"side" | "swipe" | "onion">("side");
  const effectiveMode = $derived(bothSides ? mode : "side");
  let swipe = $state(0.5); // reveal fraction for swipe
  let blend = $state(1); // 0 = old, 1 = new (onion opacity)

  // Zoom + pan, shared across modes so overlaid images stay aligned.
  let zoom = $state(1);
  let panX = $state(0);
  let panY = $state(0);
  const imgStyle = $derived(
    `transform: translate(${panX}px, ${panY}px) scale(${zoom}); transform-origin: center center;`,
  );

  // Reset the view whenever the images change (new file selected).
  $effect(() => {
    void oldSrc;
    void newSrc;
    zoom = 1;
    panX = 0;
    panY = 0;
  });

  function zoomBy(f: number) {
    zoom = Math.min(8, Math.max(0.1, Math.round(zoom * f * 100) / 100));
  }
  function resetView() {
    zoom = 1;
    panX = 0;
    panY = 0;
  }
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
  }

  // Drag to pan when zoomed in.
  let panning = false;
  let sx = 0;
  let sy = 0;
  let spx = 0;
  let spy = 0;
  function onPanDown(e: PointerEvent) {
    if (zoom <= 1) return;
    panning = true;
    sx = e.clientX;
    sy = e.clientY;
    spx = panX;
    spy = panY;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onPanMove(e: PointerEvent) {
    if (!panning) return;
    panX = spx + (e.clientX - sx);
    panY = spy + (e.clientY - sy);
  }
  function onPanUp() {
    panning = false;
  }

  // Swipe divider drag (the handle owns this; the rest of the area pans).
  let overlayEl = $state<HTMLDivElement>();
  function setSwipeFromX(clientX: number) {
    if (!overlayEl) return;
    const r = overlayEl.getBoundingClientRect();
    swipe = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  }
  function onHandleDown(e: PointerEvent) {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setSwipeFromX(e.clientX);
  }
  function onHandleMove(e: PointerEvent) {
    if (e.buttons === 0) return;
    e.stopPropagation();
    setSwipeFromX(e.clientX);
  }

  function fmt(b: number): string {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  }
</script>

<div class="imgdiff">
  <div class="bar">
    {#if bothSides}
      <div class="modes" role="group" aria-label="Image compare mode">
        <button type="button" class:active={mode === "side"} onclick={() => (mode = "side")}>Side by side</button>
        <button type="button" class:active={mode === "swipe"} onclick={() => (mode = "swipe")}>Swipe</button>
        <button type="button" class:active={mode === "onion"} onclick={() => (mode = "onion")}>Onion</button>
      </div>
    {/if}
    {#if effectiveMode === "onion"}
      <label class="slider" title="Blend old ↔ new">
        <span>old</span>
        <input type="range" min="0" max="1" step="0.01" bind:value={blend} />
        <span>new</span>
      </label>
    {/if}
    <div class="zoom" title="Scroll to zoom · drag to pan">
      <button type="button" onclick={() => zoomBy(1 / 1.25)} aria-label="Zoom out">−</button>
      <button type="button" class="zlevel" onclick={resetView} title="Reset (fit)">
        {Math.round(zoom * 100)}%
      </button>
      <button type="button" onclick={() => zoomBy(1.25)} aria-label="Zoom in">+</button>
    </div>
    <span class="sizes">{fmt(oldSize)} → {fmt(newSize)}</span>
  </div>

  {#if effectiveMode === "side"}
    <div class="side">
      <div class="pane">
        <span class="lbl old">{oldUrl ? "Old" : "Added — no old"}</span>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="canvas"
          class:grab={zoom > 1}
          onwheel={onWheel}
          onpointerdown={onPanDown}
          onpointermove={onPanMove}
          onpointerup={onPanUp}
        >
          {#if oldUrl}<img src={oldUrl} alt="old" style={imgStyle} draggable="false" />{/if}
        </div>
      </div>
      <div class="pane">
        <span class="lbl new">{newUrl ? "New" : "Removed — no new"}</span>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="canvas"
          class:grab={zoom > 1}
          onwheel={onWheel}
          onpointerdown={onPanDown}
          onpointermove={onPanMove}
          onpointerup={onPanUp}
        >
          {#if newUrl}<img src={newUrl} alt="new" style={imgStyle} draggable="false" />{/if}
        </div>
      </div>
    </div>
  {:else if effectiveMode === "swipe"}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="overlay swipe canvas"
      class:grab={zoom > 1}
      bind:this={overlayEl}
      onwheel={onWheel}
      onpointerdown={onPanDown}
      onpointermove={onPanMove}
      onpointerup={onPanUp}
    >
      <img class="base" src={oldUrl} alt="old" style={imgStyle} draggable="false" />
      <img
        class="top"
        src={newUrl}
        alt="new"
        style="{imgStyle} clip-path: inset(0 0 0 {swipe * 100}%);"
        draggable="false"
      />
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="handle"
        style="left: {swipe * 100}%;"
        onpointerdown={onHandleDown}
        onpointermove={onHandleMove}
      ></div>
    </div>
  {:else}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="overlay canvas"
      class:grab={zoom > 1}
      onwheel={onWheel}
      onpointerdown={onPanDown}
      onpointermove={onPanMove}
      onpointerup={onPanUp}
    >
      <img class="base" src={oldUrl} alt="old" style={imgStyle} draggable="false" />
      <img class="top" src={newUrl} alt="new" style="{imgStyle} opacity: {blend};" draggable="false" />
    </div>
  {/if}
</div>

<style>
  .imgdiff {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 5px 10px;
    border-bottom: 1px solid var(--border);
    background: var(--bar-bg);
    font-size: 0.85em;
  }
  .modes {
    display: inline-flex;
  }
  .modes button {
    border: 1px solid var(--border);
    background: var(--input-bg);
    color: inherit;
    padding: 3px 10px;
    cursor: pointer;
    font-size: 0.95em;
  }
  .modes button + button {
    border-left: none;
  }
  .modes button:first-child {
    border-radius: 4px 0 0 4px;
  }
  .modes button:last-child {
    border-radius: 0 4px 4px 0;
  }
  .modes button.active {
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
  }
  .slider {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--muted);
  }
  .zoom {
    display: inline-flex;
    align-items: center;
  }
  .zoom button {
    border: 1px solid var(--border);
    background: var(--input-bg);
    color: inherit;
    padding: 3px 9px;
    cursor: pointer;
    font-size: 0.95em;
  }
  .zoom button + button {
    border-left: none;
  }
  .zoom button:first-child {
    border-radius: 4px 0 0 4px;
  }
  .zoom button:last-child {
    border-radius: 0 4px 4px 0;
  }
  .zoom .zlevel {
    font-family: var(--mono);
    min-width: 48px;
    color: var(--muted);
  }
  .sizes {
    margin-left: auto;
    color: var(--muted);
    font-family: var(--mono);
  }
  /* Checkerboard so image transparency is visible. */
  .canvas {
    --sq: 10px;
    background-color: #808080;
    background-image:
      linear-gradient(45deg, #00000022 25%, transparent 25%, transparent 75%, #00000022 75%),
      linear-gradient(45deg, #00000022 25%, transparent 25%, transparent 75%, #00000022 75%);
    background-size: calc(var(--sq) * 2) calc(var(--sq) * 2);
    background-position: 0 0, var(--sq) var(--sq);
  }
  .canvas.grab {
    cursor: grab;
  }
  .side {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .pane {
    display: flex;
    flex-direction: column;
    flex: 1 1 0;
    min-width: 0;
    border-right: 1px solid var(--border);
  }
  .pane:last-child {
    border-right: none;
  }
  .lbl {
    padding: 3px 8px;
    font-size: 0.74em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    background: var(--bar-bg);
    border-bottom: 1px solid var(--border);
    color: var(--muted);
  }
  .lbl.old {
    color: #c2596d;
  }
  .lbl.new {
    color: #46b06a;
  }
  .pane .canvas {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  .pane img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
  .overlay {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  .overlay img {
    position: absolute;
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
  .overlay.swipe .handle {
    cursor: ew-resize;
  }
  .overlay .handle {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 10px;
    margin-left: -5px;
    background: transparent;
    border-left: 2px solid var(--accent);
    box-sizing: border-box;
  }
</style>
