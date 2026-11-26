---
name: consistent-terminology
description: Make terms, spellings, abbreviations, and capitalization consistent across all chapters, using notes/terminology.md as the reference. Use when the user asks for consistency, a terminology or style pass, or before they send a draft.
---

# Consistent terminology

## 1. The reference list

Read `notes/terminology.md`. If it's empty, build a first version: scan the chapters for terms that appear in more than one form and ask the user which to prefer. Write the decisions there (preferred term, variants to avoid, abbreviations).

## 2. Scan

Across every `.tex` file in `chapters/` (and `main.tex`), skipping comments, math, labels, citation keys, and `\url`/`\href` targets:

- variants of a preferred term (`data set` / `dataset`, `e-mail` / `email`, `modelling` / `modeling`)
- abbreviations used before they're spelled out in a chapter, or spelled out again after
- inconsistent capitalization of the same term
- mixed British and American spelling, if the user has chosen one (check CLAUDE.md)

## 3. Report, then fix

List each finding with file and line, grouped by term, with a count. Ask before changing anything; a term can be deliberately different in a quote or a citation. Then make the agreed changes and add any new decisions to `notes/terminology.md`.
