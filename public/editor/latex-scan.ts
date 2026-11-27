/**
 * Finds the parts of a LaTeX source the visual view knows how to show: headings, text styles, math,
 * lists, citations, figures, included files, comments, escaped characters, and the preamble.
 * Everything else is left alone (and shown as written). Positions are offsets into the text.
 *
 * Not a LaTeX parser: it reads the common, standard commands as they're usually written, which is
 * what a document mostly consists of. Anything unusual stays raw, never misread as something else.
 */

export type Span =
  | { type: "preamble"; from: number; to: number }
  | { type: "heading"; from: number; to: number; level: number; textFrom: number; textTo: number }
  | { type: "style"; from: number; to: number; style: Style; textFrom: number; textTo: number }
  | { type: "math"; from: number; to: number; display: boolean; tex: string }
  | { type: "ref"; from: number; to: number; kind: RefKind; key: string }
  | { type: "figure"; from: number; to: number; file: string }
  | { type: "include"; from: number; to: number; file: string }
  | { type: "marker"; from: number; to: number; label: string }
  | { type: "env"; from: number; to: number; env: string; label?: string } // a \begin{…} / \end{…} a reader doesn't see (or sees as a label)
  | { type: "word"; from: number; to: number; text: string } // a command, ligature or space shown as its text ("" = nothing)
  | { type: "item"; from: number; to: number; bullet: string }
  | { type: "comment"; from: number; to: number }
  | { type: "escape"; from: number; to: number; char: string };

export type Style = "bold" | "italic" | "underline" | "mono" | "smallcaps" | "caption";
export type RefKind = "cite" | "ref" | "label";

const HEADINGS: Record<string, number> = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5 };
const STYLES: Record<string, Style> = { textbf: "bold", textit: "italic", emph: "italic", underline: "underline", texttt: "mono", textsc: "smallcaps", caption: "caption" };
/** Commands that are just a word, or nothing a reader sees (spacing, alignment). An empty `{}` after them goes too. */
const WORDS: Record<string, string> = {
  LaTeX: "LaTeX", TeX: "TeX", LaTeXe: "LaTeX2ε", ldots: "…", dots: "…", textendash: "–", textemdash: "—",
  centering: "", noindent: "", hfill: "", vfill: "", par: "", medskip: "", bigskip: "", smallskip: "", bibliographystyle: "",
};
/** Environments shown by their content alone; `abstract` keeps a label. */
const QUIET_ENVS: Record<string, string> = { abstract: "Abstract", figure: "", "figure*": "", table: "", "table*": "", center: "", quote: "", quotation: "" };
const REFS: Record<string, RefKind> = {
  cite: "cite", citep: "cite", citet: "cite", citeauthor: "cite", citeyear: "cite", parencite: "cite", textcite: "cite",
  ref: "ref", eqref: "ref", autoref: "ref", cref: "ref", Cref: "ref", pageref: "ref",
  label: "label",
};
const MARKERS: Record<string, string> = { bibliography: "Bibliography", printbibliography: "Bibliography", maketitle: "Title", tableofcontents: "Table of contents", listoffigures: "List of figures", listoftables: "List of tables", newpage: "Page break", clearpage: "Page break" };
const MATH_ENVS = new Set(["equation", "equation*", "align", "align*", "gather", "gather*", "multline", "multline*", "displaymath"]);
const LIST_ENVS = new Set(["itemize", "enumerate", "description"]);
const ESCAPES = new Set(["%", "&", "#", "_", "$", "{", "}"]);

/** Offset just past the `}` matching the `{` at `open`, or -1. Skips escaped braces. */
export function matchBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

/** Skip an optional `[…]` argument (and a `*`) after a command name. */
function skipOptional(text: string, i: number): number {
  if (text[i] === "*") i++;
  while (text[i] === "[") {
    const close = text.indexOf("]", i);
    if (close < 0) return i;
    i = close + 1;
  }
  return i;
}

export function scan(text: string): Span[] {
  const spans: Span[] = [];
  const begin = text.search(/^[^%\n]*\\begin\{document\}/m);
  let i = 0;
  if (begin >= 0) {
    const lineEnd = text.indexOf("\n", begin);
    const end = lineEnd < 0 ? text.length : lineEnd;
    spans.push({ type: "preamble", from: 0, to: end });
    i = end;
  }
  const lists: { env: string; n: number }[] = [];

  while (i < text.length) {
    const c = text[i]!;
    if (c === "%") {
      const end = text.indexOf("\n", i);
      const to = end < 0 ? text.length : end;
      spans.push({ type: "comment", from: i, to });
      i = to;
      continue;
    }
    if (c === "$") {
      const display = text[i + 1] === "$";
      const open = display ? 2 : 1;
      const close = findClose(text, i + open, display ? "$$" : "$");
      if (close < 0) {
        i += open;
        continue;
      }
      spans.push({ type: "math", from: i, to: close + open, display, tex: text.slice(i + open, close) });
      i = close + open;
      continue;
    }
    if (c === "~") {
      spans.push({ type: "word", from: i, to: i + 1, text: "\u00a0" });
      i++;
      continue;
    }
    if (c === "-" && text[i + 1] === "-") {
      const em = text[i + 2] === "-";
      spans.push({ type: "word", from: i, to: i + (em ? 3 : 2), text: em ? "—" : "–" });
      i += em ? 3 : 2;
      continue;
    }
    if ((c === "`" && text[i + 1] === "`") || (c === "'" && text[i + 1] === "'")) {
      spans.push({ type: "word", from: i, to: i + 2, text: c === "`" ? "“" : "”" });
      i += 2;
      continue;
    }
    if (c !== "\\") {
      i++;
      continue;
    }

    const next = text[i + 1] ?? "";
    if (ESCAPES.has(next)) {
      spans.push({ type: "escape", from: i, to: i + 2, char: next });
      i += 2;
      continue;
    }
    if (next === "(" || next === "[") {
      const closer = next === "(" ? "\\)" : "\\]";
      const close = text.indexOf(closer, i + 2);
      if (close >= 0) {
        spans.push({ type: "math", from: i, to: close + 2, display: next === "[", tex: text.slice(i + 2, close) });
        i = close + 2;
        continue;
      }
    }
    const name = /^[a-zA-Z]+/.exec(text.slice(i + 1, i + 40))?.[0];
    if (!name) {
      i += 2;
      continue;
    }
    const after = i + 1 + name.length;

    if (name === "begin" || name === "end") {
      const env = /^\{([a-zA-Z*]+)\}/.exec(text.slice(after, after + 40))?.[1];
      if (!env) {
        i = after;
        continue;
      }
      const envEnd = after + env.length + 2;
      if (name === "begin" && MATH_ENVS.has(env)) {
        const endTag = `\\end{${env}}`;
        const close = text.indexOf(endTag, envEnd);
        if (close >= 0) {
          const inner = text.slice(envEnd, close);
          const tex = env.startsWith("align") ? `\\begin{aligned}${inner}\\end{aligned}` : env.startsWith("gather") ? `\\begin{gathered}${inner}\\end{gathered}` : inner;
          spans.push({ type: "math", from: i, to: close + endTag.length, display: true, tex });
          i = close + endTag.length;
          continue;
        }
      }
      if (env in QUIET_ENVS) {
        spans.push({ type: "env", from: i, to: skipOptional(text, envEnd), env, label: name === "begin" ? QUIET_ENVS[env] || undefined : undefined });
        i = envEnd;
        continue;
      }
      if (LIST_ENVS.has(env) || env === "document") {
        if (LIST_ENVS.has(env)) {
          if (name === "begin") lists.push({ env, n: 0 });
          else lists.pop();
        }
        spans.push({ type: "env", from: i, to: skipOptional(text, envEnd), env });
      }
      i = envEnd;
      continue;
    }

    if (name === "item") {
      const list = lists[lists.length - 1];
      let to = skipOptional(text, after);
      if (text[to] === " ") to++;
      const bullet = list?.env === "enumerate" ? `${++list.n}.` : "•";
      spans.push({ type: "item", from: i, to, bullet });
      i = to;
      continue;
    }
    if (name in WORDS) {
      const to = text.startsWith("{}", after) ? after + 2 : name === "bibliographystyle" && text[after] === "{" ? matchBrace(text, after) : after;
      spans.push({ type: "word", from: i, to: to < 0 ? after : to, text: WORDS[name]! });
      i = to < 0 ? after : to;
      continue;
    }
    if (name === "bibliography" && text[after] === "{") {
      const to = matchBrace(text, after);
      if (to > 0) {
        spans.push({ type: "marker", from: i, to, label: MARKERS.bibliography! });
        i = to;
        continue;
      }
    }
    if (name in MARKERS && !/[a-zA-Z]/.test(text[after] ?? "")) {
      spans.push({ type: "marker", from: i, to: after, label: MARKERS[name]! });
      i = after;
      continue;
    }

    const argStart = skipOptional(text, after);
    if (text[argStart] !== "{") {
      i = after;
      continue;
    }
    const argEnd = matchBrace(text, argStart);
    if (argEnd < 0) {
      i = after;
      continue;
    }
    const arg = text.slice(argStart + 1, argEnd - 1);
    if (name in HEADINGS) {
      spans.push({ type: "heading", from: i, to: argEnd, level: HEADINGS[name]!, textFrom: argStart + 1, textTo: argEnd - 1 });
      i = argStart + 1; // headings can contain styles and math
    } else if (name in STYLES) {
      spans.push({ type: "style", from: i, to: argEnd, style: STYLES[name]!, textFrom: argStart + 1, textTo: argEnd - 1 });
      i = argStart + 1;
    } else if (name in REFS) {
      spans.push({ type: "ref", from: i, to: argEnd, kind: REFS[name]!, key: arg });
      i = argEnd;
    } else if (name === "includegraphics") {
      spans.push({ type: "figure", from: i, to: argEnd, file: arg.trim() });
      i = argEnd;
    } else if (name === "include" || name === "input") {
      spans.push({ type: "include", from: i, to: argEnd, file: arg.trim() });
      i = argEnd;
    } else {
      i = after; // unknown command: leave it (and its argument) as written
    }
  }
  return spans;
}

/** The next unescaped `closer` at or after `from`, not crossing a blank line (a stray `$` shouldn't swallow paragraphs). */
function findClose(text: string, from: number, closer: string): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === "\n" && text[i + 1] === "\n") return -1;
    if (text.startsWith(closer, i)) return i;
  }
  return -1;
}
