import { COMMANDS, keyLabel, scopesOf, type Command, type Scope } from "./commands";
import { $ } from "./util";

/** The ? overlay, generated from the command registry so it always matches the real bindings. */

const sheet = $("cheatsheet");
const SECTIONS: [string, Scope[]][] = [
  ["Anywhere", ["global", "leader"]],
  ["Files", ["tree"]],
  ["Preview", ["preview"]],
];

let returnFocus: HTMLElement | null = null;

export const cheatsheetOpen = () => !sheet.hidden;

export function initCheatsheet() {
  sheet.onkeydown = (e) => {
    if (e.key === "Escape" || e.key === "?") {
      e.preventDefault();
      toggleCheatsheet();
    }
  };
  sheet.onmousedown = (e) => {
    if (e.target === sheet) toggleCheatsheet();
  };
  $("help").onclick = toggleCheatsheet;
}

export function toggleCheatsheet() {
  sheet.hidden = !sheet.hidden;
  if (sheet.hidden) return returnFocus?.focus();
  // Take focus so Esc closes the sheet instead of reaching Claude.
  returnFocus = document.activeElement as HTMLElement | null;
  render();
  sheet.focus();
}

function render() {
  const listed = new Set<Command>();
  $("cheatsheet-body").replaceChildren(
    ...SECTIONS.map(([name, scopes]) => {
      // One row per `sheet` text, in registry order; commands sharing it share the row.
      // Each command is listed once, in its first section, with every form of its key.
      const rows = new Map<string, string[][]>();
      for (const c of COMMANDS) {
        if (listed.has(c) || !c.keys || c.sheet === false || !scopesOf(c).some((sc) => scopes.includes(sc))) continue;
        listed.add(c);
        const text = c.sheet ?? c.title;
        const forms = [...new Set(scopesOf(c).map((sc) => keyLabel(c, sc)))].map((k) => k.split(" "));
        rows.set(text, [...(rows.get(text) ?? []), ...forms]);
      }
      const section = document.createElement("section");
      const h = document.createElement("h3");
      h.textContent = name;
      const dl = document.createElement("dl");
      for (const [text, keys] of rows) {
        const dd = document.createElement("dd");
        dd.textContent = text;
        dl.append(renderKeys(keys), dd);
      }
      section.append(h, dl);
      return section;
    }),
  );
}

/** Keys of one row, e.g. [["⌃Space","1"],["⌃Space","2"]] → ⌃Space 1 / 2 (a shared prefix is shown once). */
function renderKeys(keys: string[][]): HTMLElement {
  const dt = document.createElement("dt");
  const kbd = (text: string) => dt.append(Object.assign(document.createElement("kbd"), { textContent: text }));
  const or = () => dt.append(Object.assign(document.createElement("span"), { className: "or", textContent: "/" }));
  const prefix = keys.length > 1 && keys.every((k) => k.length === 2 && k[0] === keys[0]![0]) ? keys[0]![0]! : null;
  if (prefix) kbd(prefix);
  keys.forEach((steps, i) => {
    if (i > 0) or();
    for (const step of prefix ? steps.slice(1) : steps) kbd(step);
  });
  return dt;
}
