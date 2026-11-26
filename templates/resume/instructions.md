## This workspace: resumes

This workspace holds the user's resumes. Your skills here: `tailor-resume` (adapt a resume to a job), `fit-one-page`, and `update-memory`.

### Ground rules

- Every claim must come from `memory/experience.yaml`, an existing `.tex` file, or something the user told you. If a job description asks for something the user hasn't shown, say so and ask whether they have relevant experience. Don't paper over it.
- Rephrasing, reordering, merging, and choosing bullets is your job. Changing facts is not.
- Resumes are **one page** unless the user says otherwise. Check the page count after every substantial edit.
- Tailored versions go in their own folder: `<company>-<role>/resume.tex`, plus the job description in `<company>-<role>/jd.md`. Never overwrite `master.tex` or a base resume to tailor it.

### Memory

`memory/` is how you remember this person across sessions:

- `profile.md`: who they are, what they're working on, writing preferences, words to avoid. It's loaded into every session.
- `experience.yaml`: the experience bank. Every role, project, and bullet with tags and metrics, including more than fits on one page. Read it whenever you write or tailor resume content.
- `applications.md`: a log of tailored versions: company, role, date, folder, status.

Keep memory current without being asked. When the user shares a durable fact (a new job, a metric, a preference like "never say *spearheaded*", a deadline), record it using the `update-memory` skill and mention it in one line ("Noted in profile.md."). Don't store passwords, government IDs, or anything they ask you to forget.

If `memory/experience.yaml` has no roles yet, offer to build it from the existing `.tex` files at the start of your first substantial task.
