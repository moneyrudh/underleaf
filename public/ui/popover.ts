import { $ } from "../core/util";

/**
 * Toolbar menus (Fit ▾, ⋯). A button with aria-controls="<id>" opens the popover with that id.
 * Items are [role=menuitem]; one with data-command="<id>" runs that command from the registry,
 * and is hidden while the command isn't available. ↑/↓ move, Enter picks, Esc closes.
 */

type Hooks = {
  /** Run a registry command by id. */
  run: (id: string) => void;
  /** Whether a registry command is available right now. */
  available: (id: string) => boolean;
};

let openMenu: { button: HTMLElement; menu: HTMLElement } | null = null;

export const popoverOpen = () => openMenu !== null;

export function closePopover({ focusButton = false } = {}) {
  if (!openMenu) return;
  const { button, menu } = openMenu;
  openMenu = null;
  menu.hidden = true;
  button.setAttribute("aria-expanded", "false");
  if (focusButton) button.focus({ preventScroll: true });
}

export function installPopovers(hooks: Hooks) {
  for (const button of document.querySelectorAll<HTMLElement>("[aria-haspopup='menu'][aria-controls]")) {
    const menu = $(button.getAttribute("aria-controls")!);
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      if (openMenu?.menu === menu) return closePopover();
      open(button, menu, hooks);
    });
    menu.addEventListener("click", (e) => {
      const item = (e.target as Element).closest<HTMLElement>("[role='menuitem']");
      if (!item) return;
      e.stopPropagation();
      closePopover({ focusButton: true });
      if (item.dataset.command) hooks.run(item.dataset.command);
      // Other items (zoom presets, Download) do their own thing through their own handlers.
    });
    menu.addEventListener("keydown", (e) => {
      const items = visibleItems(menu);
      const at = items.indexOf(document.activeElement as HTMLElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      } else if (e.key === "Escape" || e.key === "Tab") {
        e.preventDefault();
        closePopover({ focusButton: true });
      }
    });
  }
  document.addEventListener("click", (e) => {
    if (openMenu && !openMenu.menu.contains(e.target as Node)) closePopover();
  });
  window.addEventListener("blur", () => closePopover());
}

function open(button: HTMLElement, menu: HTMLElement, hooks: Hooks) {
  closePopover();
  for (const item of menu.querySelectorAll<HTMLElement>("[data-command]")) item.hidden = !hooks.available(item.dataset.command!);
  tidySeparators(menu);
  menu.hidden = false;
  button.setAttribute("aria-expanded", "true");
  openMenu = { button, menu };
  visibleItems(menu)[0]?.focus({ preventScroll: true });
}

/** A divider only between two visible groups: none at the edges, never two in a row. */
function tidySeparators(menu: HTMLElement) {
  let seenItem = false;
  let pending: HTMLElement | null = null;
  for (const el of menu.children as HTMLCollectionOf<HTMLElement>) {
    if (el.tagName === "HR") {
      el.hidden = true;
      if (seenItem) pending = el;
    } else if (!el.hidden) {
      if (pending) pending.hidden = false;
      pending = null;
      seenItem = true;
    }
  }
}

const visibleItems = (menu: HTMLElement) => [...menu.querySelectorAll<HTMLElement>("[role='menuitem']")].filter((i) => !i.hidden);
