# &#x20;Personalized School Record Management System

A local-first dashboard for managing your school schedule. `Subject\_Scheduler.xlsx`
lives in this GitHub repo and acts as the database — the dashboard loads it
automatically over the GitHub API, no file picker required, and (once you
enable editing) writes changes straight back to it as commits.

## Structure

```
index.html                         Landing page / module hub
subject\_scheduler\_dashboard.html   Module 01 — Subject Scheduler
Subject\_Scheduler.xlsx             Your schedule data (the "database")
```

Keep all three files in the same repo — the hub links to the scheduler by
relative path, and the scheduler is hardcoded to read/write
`Santino67-67/school\_record\_management\_system` on branch `main`.

## How it works

* **Reading is automatic.** On page load, the dashboard fetches
`Subject\_Scheduler.xlsx` from this repo via the GitHub Contents API and
parses it — works in any modern browser, no setup needed to just view your
schedule.
* **Editing needs a token.** Add/edit/delete are disabled until you click
**"Enable editing"** and paste a GitHub Personal Access Token. Every save
from then on is a real commit to this repo.

### Creating a token

1. On GitHub: **Settings → Developer settings → Personal access tokens →
Fine-grained tokens → Generate new token.**
2. **Repository access:** select only this repository (`school\_record\_management\_system`) — not all repos.
3. **Permissions:** under Repository permissions, set **Contents** to
**Read and write**. Leave everything else as No access.
4. Set an expiration (90 days is reasonable — you'll just generate a new one
when it lapses).
5. Copy the token and paste it into the dashboard's "Enable editing" prompt.

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
`https://santino67-67.github.io/school\_record\_management\_system/`

## Modules

* **Subject Scheduler** (live) — weekly class schedule with professors,
rooms, Google Classroom and Google Meet links, School Year (SY) and Term,
a live "Today" view with Now/Next/Later/Done status, and a live countdown
to your next class.
* **Flashcard Reviewer** (coming soon) — spaced-repetition decks for quiz
review.

