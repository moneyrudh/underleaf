import { label, LEADER } from "../core/keys";

const keyLabel = (key: string) => label(key.replace(/\bLEADER\b/, LEADER));

/**
 * Every control that has a keyboard shortcut shows it.
 *  • `data-key="H"` on a text button adds a key chip inside it ("History H").
 *  • `data-tip="Zoom in"` gives a styled tooltip (with the key, if any). Icon-only buttons
 *    use the tooltip instead of a chip, so the toolbar doesn't fill up with chips.
 */
export function installHints() {
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.hidden = true;
  document.body.append(tip);

  for (const el of document.querySelectorAll<HTMLElement>("[data-key]:not(kbd)")) {
    if (el.dataset.tip !== undefined) continue; // the tooltip shows the key
    const chip = document.createElement("kbd");
    chip.className = "k";
    chip.textContent = keyLabel(el.dataset.key!);
    el.append(chip);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: HTMLElement | null = null;
  const show = (el: HTMLElement) => {
    current = el;
    tip.replaceChildren(el.dataset.tip || el.getAttribute("aria-label") || "");
    if (el.dataset.key) {
      for (const step of keyLabel(el.dataset.key).split(" ")) {
        const k = document.createElement("kbd");
        k.textContent = step;
        tip.append(k);
      }
    }
    tip.hidden = false;
    // Below the control, kept inside the window.
    const box = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    tip.style.left = `${Math.max(6, Math.min(window.innerWidth - w - 6, box.left + box.width / 2 - w / 2))}px`;
    const below = box.bottom + 6;
    tip.style.top = `${below + tip.offsetHeight > window.innerHeight - 6 ? box.top - tip.offsetHeight - 6 : below}px`;
  };
  const hide = () => {
    clearTimeout(timer);
    current = null;
    tip.hidden = true;
  };

  document.addEventListener("pointerover", (e) => {
    const el = (e.target as Element).closest<HTMLElement>("[data-tip]");
    if (el === current) return;
    hide();
    if (el) timer = setTimeout(() => el.isConnected && !el.hidden && show(el), 350);
  });
  document.addEventListener("focusin", (e) => {
    const el = (e.target as Element).closest<HTMLElement>("[data-tip]");
    if (el?.matches(":focus-visible")) show(el);
  });
  document.addEventListener("focusout", hide);
  document.addEventListener("pointerdown", hide);
  window.addEventListener("blur", hide);
}
