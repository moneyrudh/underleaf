---
name: tailor-resume
description: Tailor a resume to a specific job. Use when the user shares a job description or posting link, names a company/role they're applying to, or asks to adapt, target, or customize their resume.
argument-hint: "[job URL, or paste the description]"
---

# Tailor a resume to a job

## 1. Get the job description

- If you have a link, fetch it. If the page is blocked or empty, ask the user to paste the text.
- Pull out the company, role title, and level. Ask only if they're genuinely unclear.

## 2. Set up the folder

- Folder: `<company>-<role>/` in lowercase kebab-case (e.g. `ramp-frontend-engineer/`). If it exists, ask whether to update it or start a new one.
- Save the job description as `<folder>/jd.md`, with the source URL and today's date at the top.
- Base resume: the one the user names, otherwise `master.tex` if it exists, otherwise the most recently edited document. Say which one you picked. Copy it to `<folder>/resume.tex`. Never edit the base.

## 3. Analyze before writing

Read `memory/profile.md`, `memory/experience.yaml`, and the base resume. Then give the user a short read of the fit:

- **Must-haves** from the job description, and the bullets or roles that prove each one.
- **Gaps**: requirements nothing in memory supports. Ask whether they have relevant experience you don't know about. If they do, record it with `update-memory` before using it.
- **Their language**: the job description's key terms. Mirror these where they're truthful. Never keyword-stuff.

For a long job description or a big change, wait for a go-ahead. For a small one, proceed.

## 4. Edit `<folder>/resume.tex`

- Reorder sections and roles so the most relevant evidence comes first.
- Swap in stronger matching bullets from `experience.yaml`, and drop weak or irrelevant ones.
- Rephrase toward the job description's vocabulary. Facts, numbers, dates, and titles never change.
- Lead each bullet with impact and keep metrics. Each bullet should fit on one or two lines.
- Adjust the summary or skills line for the role, if the resume has one.
- Keep the template's macros and formatting intact.

## 5. Check the result

- After saving, re-read `.underleaf/workspace.md`. It must compile, with **1 page** unless told otherwise.
- If it's over a page or has overfull warnings, use the `fit-one-page` skill.

## 6. Wrap up

- Summarize the changes in a few lines: what moved up, what was cut, which terms you mirrored, and any gaps that remain.
- Add a row to `memory/applications.md` (date, company, role, folder, status `drafted`).
- Remind the user to press **Save PDF** (⌘S) when they're happy, to save the PDF wherever they want to keep it.
