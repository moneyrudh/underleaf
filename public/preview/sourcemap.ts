import { diffArrays } from "diff";
import type { Word } from "../compare/diffcore";

/**
 * Where the words on the PDF page come from in the LaTeX source, so text can be edited on the page.
 *
 * The source is read the way a reader would see it: commands, braces, comments, labels, URLs and
 * the preamble produce nothing; escaped characters (\%) produce the character; ``quotes'', -- and ~
 * produce what TeX prints. Every visible word remembers the source range it came from. \input and
 * \include are read in place, so a chapter's words map into the chapter's file.
 *
 * The page's words (pdf.js, joined across kerns, hyphenation undone) and the source's words are
 * then lined up in order (a word diff), so repeated phrases map to the right occurrence. Words the
 * source doesn't spell out (bullets, icons, page numbers, text a macro generates, math) stay unmapped,
 * and can't be edited on the page.
 */

/**
 * `component`: what the word is part of, the unit edited on the page: a macro's argument (each of
 * \resumeSubheading{Title}{Place}, a whole \resumeItem{…}, a \section{…}), or else a stretch of text
 * between blank lines, \items, \\ and environment boundaries. Inline formatting (\textbf, \emph,
 * \href, sizes) stays part of the surrounding component.
 */
export type SourceWord = { key: string; file: string; from: number; to: number; component: string };
/** A source file as it was when the map was made: edits are worked out against this text. */
export type SourceFile = { path: string; text: string };
export type SourceMap = { files: Map<string, SourceFile>; source: SourceWord[]; at: (pageWord: number) => SourceWord | null };

/** How a word is compared: the same text, whichever way TeX and the source spell its quotes, dashes and ligatures. */
export const keyOf = (s: string) =>
  s
    .normalize("NFKC")
    .replace(/[“”„]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-");

/** Commands whose first argument doesn't print (or isn't text). */
const HIDDEN_ARG = new Set([
  "label", "ref", "eqref", "pageref", "autoref", "cref", "Cref", "cite", "citep", "citet", "citeauthor", "citeyear", "parencite", "textcite", "nocite",
  "begin", "end", "vspace", "hspace", "href", "includegraphics", "documentclass", "usepackage", "setlength", "addtolength", "setcounter",
  "newcommand", "renewcommand", "providecommand", "newenvironment", "renewenvironment", "def", "color", "textcolor", "colorbox", "pagestyle",
  "thispagestyle", "bibliographystyle", "bibliography", "addbibresource", "graphicspath", "hypersetup", "titleformat", "titlespacing",
  "fontsize", "linespread", "geometry", "newlength", "input", "include", "raisebox", "rule", "phantom",
]);
/** Commands that print a word. */
const WORDS: Record<string, string> = { LaTeX: "LaTeX", TeX: "TeX", LaTeXe: "LaTeX2ε", ldots: "…", dots: "…", textendash: "–", textemdash: "—", textbar: "|", textbackslash: "\\" };
const MATH_ENVS = /^(equation|align|gather|multline|displaymath|math)\*?$/;
/** Commands whose argument is formatting inside a sentence, not a component of its own. */
const INLINE = new Set([
  "textbf", "textit", "emph", "underline", "ul", "texttt", "textsc", "textrm", "textsf", "textsl", "textup", "textmd", "textnormal", "mbox", "hbox",
  "href", "url", "textcolor", "colorbox", "tiny", "scriptsize", "footnotesize", "small", "normalsize", "large", "Large", "LARGE", "huge", "Huge",
  "bf", "it", "sc", "rm", "sf", "tt", "bfseries", "itshape", "scshape", "normalfont",
]);
/** Commands after which a new stretch of text (component) starts. */
const BREAKS = new Set(["item", "par", "newline", "linebreak", "begin", "end", "section", "subsection", "subsubsection", "chapter", "paragraph", "part"]);

type Char = { ch: string; from: number; to: number; comp: string };

/** Read one file's visible text. `include(name, at)` reads an \input / \include file in place. */
async function project(file: string, text: string, out: SourceWord[], include: (name: string) => Promise<void>, isMain: boolean) {
  let chars: Char[] = [];
  const flush = () => {
    let word: Char[] = [];
    const end = () => {
      if (word.length) out.push({ key: keyOf(word.map((c) => c.ch).join("")), file, from: word[0]!.from, to: word.at(-1)!.to, component: word[0]!.comp });
      word = [];
    };
    for (const c of chars) (/\s/.test(c.ch) ? end() : word.push(c));
    end();
    chars = [];
  };
  const space = (at: number) => chars.push({ ch: " ", from: at, to: at, comp: "" });

  // Components: brace groups that are a command's argument (and not inline formatting) are their own;
  // other text belongs to the stretch that started at `seg`.
  const groups: { start: number; owner: string | null; component: boolean }[] = [];
  const owners = new Map<number, string>(); // "{" offset → the command it's an argument of
  let seg = 0;
  const comp = () => {
    for (let k = groups.length - 1; k >= 0; k--) if (groups[k]!.component) return `${file}#g${groups[k]!.start}`;
    return `${file}#s${seg}`;
  };
  const emit = (ch: string, from: number, to: number) => chars.push({ ch, from, to, comp: comp() });
  const breakAt = (at: number) => {
    if (!groups.some((g) => g.component)) seg = at;
  };

  let i = 0;
  if (isMain) {
    // The preamble prints nothing, except what \maketitle shows: read \title, \author and \date in place.
    const body = text.search(/^[^%\n]*\\begin\{document\}/m);
    if (body >= 0) {
      for (const m of text.slice(0, body).matchAll(/\\(title|author|date)\s*\{/g)) {
        const open = m.index! + m[0].length - 1;
        const close = matchBrace(text, open);
        if (close > 0) {
          seg = open; // the title, the author, the date: each its own
          await readRange(open + 1, close - 1);
          space(close);
        }
      }
      i = body;
    }
  }
  await readRange(i, text.length);
  flush();

  async function readRange(start: number, stop: number) {
    let i = start;
    while (i < stop) {
      const c = text[i]!;
      if (c === "%") {
        const nl = text.indexOf("\n", i);
        i = nl < 0 || nl > stop ? stop : nl + 1; // a comment swallows its line break too
        continue;
      }
      if (c === "$") {
        const display = text[i + 1] === "$";
        const close = text.indexOf(display ? "$$" : "$", i + (display ? 2 : 1));
        space(i);
        i = close < 0 ? stop : close + (display ? 2 : 1); // math isn't edited on the page
        space(i);
        continue;
      }
      if (c === "{") {
        const owner = owners.get(i) ?? null;
        groups.push({ start: i, owner, component: !!owner && !INLINE.has(owner) });
        i++;
        continue;
      }
      if (c === "}") {
        // Braces print nothing, but one argument ends where the next begins: \resumeSubheading{Title}{Place}.
        const closed = groups.pop();
        const nextArg = argAfter(text, i + 1);
        if (nextArg >= 0) {
          space(i);
          if (closed?.owner) owners.set(nextArg, closed.owner);
        }
        i++;
        continue;
      }
      if (c === "\n" && /^\n[ \t]*\n/.test(text.slice(i, i + 80))) breakAt(i); // a blank line: a new paragraph
      if (c === "~") {
        space(i);
        i++;
        continue;
      }
      if (c === "-" && text[i + 1] === "-") {
        const em = text[i + 2] === "-";
        emit(em ? "—" : "–", i, i + (em ? 3 : 2));
        i += em ? 3 : 2;
        continue;
      }
      if ((c === "`" || c === "'") && text[i + 1] === c) {
        emit(c === "`" ? "“" : "”", i, i + 2);
        i += 2;
        continue;
      }
      if (c === "`") {
        emit("‘", i, i + 1);
        i++;
        continue;
      }
      if (c !== "\\") {
        emit(c, i, i + 1);
        i++;
        continue;
      }

      // A backslash: an escaped character, a spacing command, or a command name.
      const next = text[i + 1] ?? "";
      if ("%&#_${}".includes(next) && next) {
        emit(next, i, i + 2);
        i += 2;
        continue;
      }
      if (next === "\\" || next === " " || next === "," || next === ";" || next === ":" || next === "!") {
        if (next === "\\") breakAt(i + 2); // a forced line break ends a stretch
        space(i);
        i += 2;
        continue;
      }
      if (next === "(" || next === "[") {
        const close = text.indexOf(next === "(" ? "\\)" : "\\]", i + 2);
        space(i);
        i = close < 0 ? stop : close + 2;
        space(i);
        continue;
      }
      const name = /^[a-zA-Z@]+/.exec(text.slice(i + 1, i + 60))?.[0];
      if (!name) {
        i += 2;
        continue;
      }
      let j = i + 1 + name.length;
      if (text[j] === "*") j++;
      if (name === "begin") {
        const env = /^\{([^}]+)\}/.exec(text.slice(j, j + 40))?.[1];
        if (env && MATH_ENVS.test(env)) {
          const endTag = `\\end{${env}}`;
          const close = text.indexOf(endTag, j);
          space(i);
          i = close < 0 ? stop : close + endTag.length;
          space(i);
          continue;
        }
      }
      if (name === "input" || name === "include") {
        const arg = /^\{([^}]+)\}/.exec(text.slice(j, j + 200));
        if (arg) {
          flush();
          await include(arg[1]!.trim());
          i = j + arg[0].length;
          continue;
        }
      }
      if (name in WORDS) {
        for (const ch of WORDS[name]!) emit(ch, i, j);
        if (text.startsWith("{}", j)) j += 2;
        i = j;
        continue;
      }
      if (name === "item") space(i);
      if (BREAKS.has(name)) breakAt(i);
      // Optional arguments ([…]) never print here; a hidden argument is skipped whole.
      while (text[j] === "[") {
        const close = text.indexOf("]", j);
        if (close < 0) break;
        j = close + 1;
      }
      if (HIDDEN_ARG.has(name) && text[j] === "{") {
        const close = matchBrace(text, j);
        if (close > 0) j = close;
      }
      const arg = argAfter(text, j);
      if (arg >= 0) owners.set(arg, name); // the brace group that follows is this command's argument
      if (/\s/.test(text[j] ?? "")) space(j); // a word boundary, whatever TeX makes of the space itself
      i = j;
    }
  }
}

/**
 * Where a command's next argument starts, if one follows `at`: TeX allows spaces and one line break
 * before it (\resumeSubheading⏎  {Title}{Place}), not a blank line.
 */
function argAfter(text: string, at: number): number {
  const m = /^[ \t]*(?:\n[ \t]*)?\{/.exec(text.slice(at, at + 200));
  return m ? at + m[0].length - 1 : -1;
}

/** Offset just past the `}` matching the `{` at `open`, or -1. */
function matchBrace(text: string, open: number): number {
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

/**
 * Build the map for a document: read `mainPath` and what it includes (`load` fetches a file's text,
 * or null), then line its words up with the page's words.
 */
export async function buildSourceMap(mainPath: string, load: (path: string) => Promise<string | null>, pageWords: Word[]): Promise<SourceMap | null> {
  const files = new Map<string, SourceFile>();
  const source: SourceWord[] = [];
  const dir = mainPath.replace(/\/[^/]*$/, "");
  const read = async (path: string, isMain: boolean, depth: number) => {
    const text = await load(path);
    if (text === null || depth > 8) return;
    files.set(path, { path, text });
    await project(path, text, source, (name) => {
      const candidates = [`${dir}/${name}.tex`, `${dir}/${name}`].map((p) => p.replace(/\/\.\//g, "/"));
      return (async () => {
        for (const p of candidates) {
          if (files.has(p)) return;
          if ((await load(p)) !== null) return read(p, false, depth + 1);
        }
      })();
    }, isMain);
  };
  await read(mainPath, true, 0);
  if (!source.length) return null;

  const pageKeys = pageWords.map((w) => keyOf(w.key));
  const sourceKeys = source.map((w) => w.key);
  const parts = diffArrays(pageKeys, sourceKeys, { maxEditLength: 20_000 } as never) as ReturnType<typeof diffArrays> | undefined;
  if (!parts) return null;
  const toSource = new Map<number, number>();
  let p = 0;
  let s = 0;
  for (const part of parts) {
    const n = part.count ?? part.value.length;
    if (part.added) s += n;
    else if (part.removed) p += n;
    else for (let k = 0; k < n; k++) toSource.set(p++, s++);
  }
  return { files, source, at: (pageWord) => source[toSource.get(pageWord) ?? -1] ?? null };
}

/** Text typed on the page, written so LaTeX prints it as typed. */
export const escapeTyped = (text: string) =>
  text.replace(/[\\{}%&#_$^~]/g, (c) => ({ "\\": "\\textbackslash{}", "^": "\\^{}", "~": "\\textasciitilde{}" })[c] ?? `\\${c}`);
