# Personalized School Record Management System

A local-first dashboard for managing your school schedule. `Subject_Scheduler.xlsx`
lives in this GitHub repo and acts as the database — the dashboard loads it
automatically over the GitHub API, no file picker required, and (once you
enable editing) writes changes straight back to it as commits.

## Structure

```
index.html                         Landing page / module hub
subject_scheduler_dashboard.html   Module 01 — Subject Scheduler
Subject_Scheduler.xlsx             Your schedule data (the "database")
```

Keep all three files in the same repo — the hub links to the scheduler by
relative path, and the scheduler is hardcoded to read/write
`fielalbert2026/school_record_management_system` on branch `main`.

## How it works

- **Reading is automatic.** On page load, the dashboard fetches
  `Subject_Scheduler.xlsx` from this repo via the GitHub Contents API and
  parses it — works in any modern browser, no setup needed to just view your
  schedule.
- **Editing needs a token.** Add/edit/delete are disabled until you click
  **"Enable editing"** and paste a GitHub Personal Access Token. Every save
  from then on is a real commit to this repo.

### Sharing this publicly vs. editing it yourself

The **Add class**, **Edit**, and **Delete** controls only appear when the
page is opened with `?admin=1` on the end of the URL, e.g.:

```
https://fielalbert2026.github.io/school_record_management_system/subject_scheduler_dashboard.html?admin=1
```

- Share the **plain URL** (no `?admin=1`) with anyone — they get a clean,
  fully read-only view of the schedule with no edit controls visible at all,
  even if editing happens to be "on" in that same browser from a previous
  visit.
- Keep the **`?admin=1` URL** for yourself (bookmark it) — that's where
  "Enable editing" / "Lock editing" and the per-class Edit/Delete buttons
  show up.
- **"Lock editing"** clears your token from that browser entirely (including
  from `localStorage` if you'd saved it) — use it if you're done editing on a
  shared or public computer.

Two things worth knowing about this: the `?admin=1` link is just a UI
convenience, not real security — anyone who guesses or is shown that exact
URL sees the same edit buttons you do. The actual protection is still the
GitHub token itself: without a valid one scoped to this repo, clicking
"Enable editing" and submitting a wrong/blank token won't let anyone actually
save changes, even from the admin URL. So the admin link controls who *sees*
the editing UI; the token controls who can *actually* write to the repo.

### Creating a token

1. On GitHub: **Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → Generate new token.**
2. **Repository access:** select only this repository (`school_record_management_system`) — not all repos.
3. **Permissions:** under Repository permissions, set **Contents** to
   **Read and write**. Leave everything else as No access.
4. Set an expiration (90 days is reasonable — you'll just generate a new one
   when it lapses).
5. Copy the token and paste it into the dashboard's "Enable editing" prompt.

**If you already had a token from before:** if this repo moved from a
different account (e.g. an older `Santino67-67` repo), a token scoped to that
old repo won't work here — fine-grained tokens are locked to the specific
repo(s) you picked when creating them. Generate a fresh one scoped to
`fielalbert2026/school_record_management_system` instead.

**Keep this in mind:** the token is never written into the site's code or
committed to the repo — it only lives in your browser (in memory, or in
`localStorage` on that device if you check "Remember on this device"). Because
this repo is public, anyone could otherwise read a hardcoded token straight
out of the page source, which is exactly why it's entered per-browser instead.
Scoping the token to just this one repo with only Contents access limits what
someone could do with it even if it ever leaked.

### Multiple devices

Since the schedule now lives on GitHub instead of a local file, you can open
the dashboard from any device and see the same data. If you edit from two
tabs/devices at nearly the same time, the second save will detect the
conflict, reload the latest version automatically, and ask you to redo your
last change — this avoids silently overwriting someone else's edit (even if
that "someone else" is just your other tab).

## Running it locally

Just open `index.html` in a browser — reading works immediately since it
talks to the public GitHub API directly; no server or local setup needed.

## Publishing / updating this repo

```bash
git add .
git commit -m "Update dashboard"
git push
```

With GitHub Pages enabled (**Settings → Pages → Deploy from branch → main,
root**), the live site updates automatically after each push:
`https://fielalbert2026.github.io/school_record_management_system/`

## Modules

- **Subject Scheduler** (live) — weekly class schedule with professors,
  rooms, Google Classroom and Google Meet links, School Year (SY) and Term,
  a live "Today" view with Now/Next/Later/Done status, and a live countdown
  to your next class.
- **Flashcard Reviewer** (coming soon) — spaced-repetition decks for quiz
  review.

