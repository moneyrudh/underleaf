## This workspace: a thesis

`main.tex` is the only document that compiles. It pulls in one file per chapter from `chapters/` with `\include`, and the bibliography from `references.bib`. Your skills here: `check-citations` and `consistent-terminology`.

- **Edit the chapter files, not `main.tex`**, unless the change is to the preamble or the order of chapters. Saving a chapter rebuilds `main.tex` if the user has it open; otherwise ask them to open it to see the result.
- New chapter: create `chapters/<name>.tex` starting with `\chapter{…}` and `\label{chap:<name>}`, and add an `\include` line to `main.tex` in the right place.
- Figures go in `figures/` (create it if it's missing); `\includegraphics{name}` finds them there.
- **Cite only what's in `references.bib`.** Never invent a reference, page number, or DOI. If a claim needs a source that isn't there, say so and ask the user for the BibTeX entry (from Google Scholar, the publisher, or their reference manager): you can't look it up.
- Use the preferred terms in `notes/terminology.md` and add new ones there when the user settles on a term.
- Refer to chapters, figures, tables, and equations with `\ref` and labels, never by hard-coded numbers.
- This is a long document: before a change that spans chapters, say which files you'll touch.
