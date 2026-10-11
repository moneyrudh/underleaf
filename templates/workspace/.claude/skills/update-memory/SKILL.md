---
name: update-memory
description: Record durable facts about the user in memory/ (profile, experience bank, application log), or build the experience bank from existing resumes. Use whenever the user shares a new job, project, metric, skill, preference, or application outcome, or when memory/experience.yaml has no roles yet.
---

# Keep memory current

| File | Holds |
|---|---|
| `memory/profile.md` | Who they are, target roles and level, location and work-authorization notes they choose to share, writing preferences, words and phrases to avoid. Keep it short, because it's loaded every session. |
| `memory/experience.yaml` | The experience bank: every role, project, education entry, and skill, with as many true bullets as they have. More than fits on one page is the point. |
| `memory/applications.md` | One row per tailored version: date, company, role, folder, status. |

## Rules

- **Facts only, from the user or their documents.** Don't infer metrics or skills. If a bullet lacks a number and one would help, ask for it rather than estimating.
- **Add and refine freely, but ask before deleting** anything already recorded.
- When a fact changes (a title, an end date, a role going from current to past), update it in place and don't duplicate it.
- Keep `experience.yaml` valid YAML. Quote any bullet containing `:` or `#`. Preserve the user's own edits and comments.
- After writing, say what you recorded in one line. Don't announce memory updates at length.
- Never store passwords, government ID numbers, or anything the user asks you to forget. If asked to forget something, remove it and confirm.

## Building the experience bank from existing resumes

When `experience.yaml` has no roles:

1. Read every document in the workspace (`master.tex` first, since it's usually the most complete).
2. Merge roles across files by company, title, and dates. Keep every distinct bullet once, preferring the strongest wording. Tag each bullet with skills and topics (`tags`). Mark `source` with the file it came from.
3. Write the result, then show the user a short summary (roles, bullet counts) and ask them to fill gaps: missing dates, metrics, or anything not on any resume.

## experience.yaml shape

```yaml
roles:
  - id: acme-swe-2024              # stable, kebab-case
    title: Software Engineer
    org: Acme Corp
    location: Chicago, IL
    start: 2024-06                 # YYYY-MM
    end: present
    bullets:
      - text: Cut p95 API latency from 800ms to 120ms by adding a read-through cache
        tags: [backend, performance, redis]
        source: master.tex
projects:
  - id: tiny-compiler
    name: tiny-compiler
    stack: [C]
    link: https://example.com
    bullets: [...]
education:
  - school: ...
    degree: ...
    start: ...
    end: ...
skills:
  languages: [...]
  frameworks: [...]
  tools: [...]
```
