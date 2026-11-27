import { $ } from "../core/util";

/**
 * Ask for one line of text (a project's name): a small dialog in the style of the palette.
 * Resolves to the trimmed text, or null when cancelled (Esc, Cancel, clicking outside).
 */

const overlay = $("ask");
const form = $<HTMLFormElement>("ask-form");
const title = $("ask-title");
const input = $<HTMLInputElement>("ask-input");
const ok = $<HTMLButtonElement>("ask-ok");

let settle: ((value: string | null) => void) | null = null;

export const askOpen = () => !overlay.hidden;

export function askText({ heading, value = "", confirm }: { heading: string; value?: string; confirm: string }): Promise<string | null> {
  settle?.(null);
  title.textContent = heading;
  ok.textContent = confirm;
  input.value = value;
  overlay.hidden = false;
  input.focus();
  input.select();
  return new Promise((resolve) => (settle = resolve));
}

function done(value: string | null) {
  overlay.hidden = true;
  const resolve = settle;
  settle = null;
  resolve?.(value?.trim() || null);
}

export function initAsk() {
  form.onsubmit = (e) => {
    e.preventDefault();
    done(input.value);
  };
  $("ask-cancel").onclick = () => done(null);
  overlay.onmousedown = (e) => {
    if (e.target === overlay) done(null);
  };
  input.onkeydown = (e) => {
    if (e.key !== "Escape" && e.key !== "Enter") return;
    e.preventDefault();
    e.stopPropagation();
    done(e.key === "Enter" ? input.value : null);
  };
}
