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

## Signing in

The hub (`index.html`) now asks for a school ID before showing the modules.

* **What it checks against:** the `Valid_Users` sheet in `Subject_Scheduler.xlsx`,
  which now stores `Unique_Identifier, Name_IV, Name_Enc, Designation` — no
  plain IDs and no plain names.
  * `Unique_Identifier` is SHA-256(ID + a fixed salt) — a one-way hash used
    only to check "does this ID match a row?"
  * `Name_IV` / `Name_Enc` is the person's name encrypted with AES-256-GCM,
    using a key derived from *that person's own ID* (a different salt than
    the one above). Nobody — not the code, not the salt, not the sheet — can
    turn `Name_Enc` back into a name without already knowing the ID it
    belongs to. Logging in with your own ID is what derives your own key.
* **What it's *not*:** unbreakable. This is a static site with no server, so
  the hashing/decryption code has to be public for the browser to run it.
  School IDs look like an 8-digit space, so someone willing to brute-force
  all ~10⁸ combinations offline could still recover any single name given
  enough compute time — this raises that bar from "readable at a glance" to
  "requires targeted computation," it doesn't make the data theoretically
  secret. The Designation column (`Guest`/`Master`) is left in plain text
  since it's low-sensitivity — it's genuinely just two possible values.
* **The actual security boundary** is unchanged: writing to the file still
  requires a GitHub Personal Access Token, entered separately, kept only in
  that browser, and never touched by the sign-in step.
* Sign-in state lives in `sessionStorage` (cleared when the tab closes) — it
  isn't a cookie or a token sent to any server, so there's nothing here that
  functions like a session token that could be intercepted or replayed
  against a backend. `subject_scheduler_dashboard.html` also checks for it
  directly, so opening that file without signing in on the hub first shows a
  locked screen instead of the schedule.

### Managing Valid_Users

Adding or removing someone now needs a small script rather than typing
straight into the sheet, since the Name column is ciphertext. The salts and
the AES scheme (SHA-256(ID + salt) → 32-byte key, random 12-byte IV,
AES-256-GCM, tag appended to ciphertext — same convention Web Crypto uses)
are defined at the top of `index.html`'s script and in the generation logic
used to build this sheet; reuse that same logic (in Python via the
`cryptography` package's `AESGCM`, or equivalent) to add new rows so the
in-browser decryption keeps matching.

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

