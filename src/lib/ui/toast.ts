/// A short-lived toast at the bottom right. Styled by the global
/// `.blame-toast` rules in BlameView.svelte (always bundled: +page imports it).
export function showToast(msg: string): void {
  const t = document.createElement("div");
  t.className = "blame-toast";
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 250);
  }, 1500);
}
