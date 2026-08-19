# Personalized School Record Management System

A local-first, offline dashboard for managing your school schedule — no accounts,
no backend server. Your Excel file *is* the database; the dashboard reads and
writes to it directly using your browser's File System Access API.

## Structure

```
index.html                         Landing page / module hub
subject_scheduler_dashboard.html   Module 01 — Subject Scheduler
Subject_Scheduler.xlsx             Your live schedule data (the "database")
```

Keep all three files in the same folder — the hub links to the scheduler by
relative path, and the scheduler expects to connect to an `.xlsx` file you
pick yourself.

## Running it locally

1. Download/clone this folder to your computer.
2. Open `index.html` in **Chrome or Edge on desktop** (the File System Access
   API these use isn't supported in Firefox/Safari, or on mobile).
3. Click into the Subject Scheduler module, then **"Connect existing .xlsx"**
   and choose `Subject_Scheduler.xlsx` from this same folder.
4. Add/edit/delete classes from the dashboard — every change is written
   straight back to that `.xlsx` file automatically.

## Running it from GitHub Pages

You can host `index.html` and `subject_scheduler_dashboard.html` on GitHub
Pages for a stable link to open anytime — the File System Access API still
works the same way, since it talks to files on *your* computer regardless of
where the page itself is served from.

`Subject_Scheduler.xlsx` in this repo is a **starting copy/backup** of your
data. Because GitHub Pages is static hosting, the live dashboard can't write
back into the repo itself — each time you use it, you'll connect to your own
local copy of the `.xlsx` file (on your Desktop, in a synced folder, wherever
you keep it) exactly like running it locally. Re-download/commit an updated
copy to this repo occasionally if you want a backup checked in.

## Publishing this to GitHub

From a terminal, inside this folder:

```bash
git init
git add .
git commit -m "Initial commit: school record management system"
git branch -M main
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

Then, to serve it with GitHub Pages:

1. On GitHub, go to the repo's **Settings → Pages**.
2. Under "Build and deployment", set Source to **Deploy from a branch**,
   branch `main`, folder `/ (root)`.
3. Save — your dashboard will be live at
   `https://<your-username>.github.io/<repo-name>/` within a minute or two.

## Modules

- **Subject Scheduler** (live) — weekly class schedule with professors,
  rooms, Google Classroom and Google Meet links, School Year (SY) and Term,
  a live "Today" view with Now/Next/Later/Done status, and a live countdown
  to your next class.
- **Flashcard Reviewer** (coming soon) — spaced-repetition decks for quiz
  review.
