---
name: check-citations
description: Check that every citation in the document has a bibliography entry, find unused or duplicate entries, and fix undefined references. Use when the user asks to check citations or references, when the PDF shows [?] or ??, or before they send the document.
---

# Check citations and references

You can't look anything up on the web. Work only from the files here and what the user gives you.

## 1. Collect

- Every citation key used: search the `.tex` files for `\cite`, `\citet`, `\citep`, `\citeauthor`, `\citeyear` (keys can be comma-separated: `\citep{a,b}`). Skip lines commented out with `%`.
- Every entry in the `.bib` file(s) named by `\bibliography{…}` or `\addbibresource{…}`.
- Undefined citations and references: read `.underleaf/workspace.md` for warnings like `Citation 'x' on page 3 undefined` or `Reference 'fig:x' undefined`, and for `BibTeX:` problems.

## 2. Report

One short list per problem, with file and line:

- **Cited but missing from the .bib**: the key, where it's cited. Don't create an entry for it. Ask the user for the BibTeX (from Google Scholar, the publisher's page, or their reference manager), or whether the key is a typo of an existing one.
- **Probably a typo**: a cited key that's one or two characters off an existing key. Suggest the fix.
- **In the .bib but never cited**: list them; don't delete (the user may cite them later).
- **Duplicate entries**: same key twice, or the same work under two keys.
- **Broken entries**: missing `author`/`title`/`year`, or a BibTeX error from the log.
- **Undefined `\ref`s**: labels referenced but never defined, and labels defined twice.

## 3. Fix

For typos and broken cross-references, propose the edits and make them once the user agrees. Then re-read `.underleaf/workspace.md` to confirm the warnings are gone.
