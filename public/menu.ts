/**
 * A dropdown list anchored to a button, in the app's own style (native <select> menus
 * look like OS context menus). Type to filter, ↑/↓ to move, Enter to pick, Esc to close.
 */

export type MenuItem = { value: string; label: string; meta?: string; icon?: string; kind?: string };

let close: (() => void) | null = null;

export function menuOpen() {
  return close !== null;
}

export function openMenu(anchor: HTMLElement, items: MenuItem[], selected: string, onPick: (value: string) => void) {
  close?.();
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.setAttribute("role", "dialog");
  const input = document.createElement("input");
  input.placeholder = "Filter…";
  input.spellcheck = false;
  input.autocomplete = "off";
  const list = document.createElement("ul");
  list.setAttribute("role", "listbox");
  menu.append(input, list);
  document.body.append(menu);

  let shown: MenuItem[] = items;
  let active = Math.max(0, items.findIndex((i) => i.value === selected));

  const render = () => {
    list.replaceChildren(
      ...shown.map((item, i) => {
        const li = document.createElement("li");
        li.setAttribute("role", "option");
        li.className = item.kind ? `kind-${item.kind}` : "";
        li.classList.toggle("active", i === active);
        li.setAttribute("aria-selected", String(item.value === selected));
        const icon = document.createElement("span");
        icon.className = "icon";
        icon.textContent = item.icon ?? "";
        const what = document.createElement("span");
        what.className = "what";
        const label = document.createElement("span");
        label.className = "label";
        label.textContent = item.label; // labels can contain Claude prompts: text only
        what.append(label);
        if (item.meta) {
          const meta = document.createElement("span");
          meta.className = "meta";
          meta.textContent = item.meta;
          what.append(meta);
        }
        const check = document.createElement("span");
        check.className = "check";
        check.textContent = item.value === selected ? "✓" : "";
        li.append(icon, what, check);
        li.onpointermove = () => {
          if (active === i) return;
          active = i;
          render();
        };
        li.onclick = () => pick(item);
        return li;
      }),
    );
    if (shown.length === 0) {
      const empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = "No matches";
      list.append(empty);
    }
    list.children[active]?.scrollIntoView({ block: "nearest" });
  };

  const place = () => {
    const box = anchor.getBoundingClientRect();
    const width = Math.max(box.width, 300);
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(6, Math.min(window.innerWidth - width - 6, box.left))}px`;
    menu.style.top = `${box.bottom + 4}px`;
    menu.style.maxHeight = `${Math.max(160, window.innerHeight - box.bottom - 16)}px`;
  };

  const pick = (item: MenuItem) => {
    close?.();
    if (item.value !== selected) onPick(item.value);
  };

  input.oninput = () => {
    const q = input.value.trim().toLowerCase();
    shown = q ? items.filter((i) => `${i.label} ${i.meta ?? ""}`.toLowerCase().includes(q)) : items;
    active = 0;
    render();
  };
  input.onkeydown = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (shown.length) active = (active + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
      render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = shown[active];
      if (item) pick(item);
    } else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      close?.();
    }
  };

  // Clicks on the button itself are left to its own handler (a second click closes the menu).
  const outside = (e: PointerEvent) => {
    if (!menu.contains(e.target as Node) && !anchor.contains(e.target as Node)) close?.();
  };
  const dismiss = () => close?.();
  close = () => {
    close = null;
    menu.remove();
    anchor.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    window.removeEventListener("resize", dismiss);
    window.removeEventListener("blur", dismiss);
    anchor.focus({ preventScroll: true });
  };
  document.addEventListener("pointerdown", outside, true);
  window.addEventListener("resize", dismiss);
  window.addEventListener("blur", dismiss);
  anchor.setAttribute("aria-expanded", "true");

  place();
  render();
  input.focus();
}

/** Toggle: a second click on the same button closes its menu. */
export function toggleMenu(anchor: HTMLElement, ...rest: [MenuItem[], string, (value: string) => void]) {
  if (anchor.getAttribute("aria-expanded") === "true") close?.();
  else openMenu(anchor, ...rest);
}
