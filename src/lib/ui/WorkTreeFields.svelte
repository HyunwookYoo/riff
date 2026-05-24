<script lang="ts">
  // Working tree mode has no ref inputs — the comparison is implicit:
  // HEAD ↔ working tree. We render a static label as a visual placeholder.
</script>

<span class="label" title="Uncommitted changes vs HEAD">HEAD (working tree)</span>

<style>
  .label {
    font-family: var(--mono);
    font-size: 0.85em;
    padding: 4px 8px;
    border-radius: 4px;
    background: var(--hover);
    color: var(--muted);
  }
</style>
