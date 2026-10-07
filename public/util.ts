export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** localStorage that never throws (private windows, blocked storage). */
export function storage(key: string, value?: string): string | null {
  try {
    if (value !== undefined) localStorage.setItem(`underleaf:${key}`, value);
    return localStorage.getItem(`underleaf:${key}`);
  } catch {
    return null;
  }
}

let toastTimer: ReturnType<typeof setTimeout>;
export function toast(text: string) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3000);
}

export function formatBytes(n: number) {
  return n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;
}
