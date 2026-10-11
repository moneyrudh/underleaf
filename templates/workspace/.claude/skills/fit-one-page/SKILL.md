---
name: fit-one-page
description: Shrink a LaTeX resume to exactly one page, or fix text overflowing the margins. Use when a resume compiles to 2+ pages, the user says it's too long, or underleaf reports overfull hbox warnings.
---

# Fit a resume on one page

The page count and warnings come from `.underleaf/workspace.md`. Re-read it about 1–2 seconds after each save. Work in small steps and re-check after each one. Stop as soon as it's one page with no overfull warnings.

## Cut content first, in this order

1. **Widows:** bullets whose last line holds only one to three words. Tighten the wording so the bullet loses a line. This is usually the biggest win for the least loss.
2. **Weakest bullets:** the ones least relevant to the target role (check `jd.md` in the same folder, if present). Remove those under older or less relevant roles first.
3. **Redundant bullets:** if two bullets prove the same skill, merge them or keep the stronger one.
4. **Old or minor entries:** shorten early roles to one or two bullets. Drop coursework and minor projects before anything recent.
5. **Summary or skills:** shorten them. Never remove contact information.

## Then layout, within limits

Only if content cuts aren't enough, and say what you changed:

- Section spacing (`\vspace` tweaks): at most -2pt to -4pt each.
- Margins: no smaller than 0.5in.
- Font size: no smaller than 10pt body text. Never use `\small` or `\footnotesize` on whole sections to cheat.

## Overfull warnings

`Overfull \hbox` means a line runs into the margin. It's usually a long URL, a long unbroken word, or a tabular row. Rephrase, shorten the link text, or let the row wrap. Don't silence the warning.

## Finish

Report the final page count and list what you cut, so the user can bring anything back. Never cut facts that only exist in the resume and not in `memory/experience.yaml`: record them there first.
