# Personalized School Record Management System

A shared dashboard for managing your school schedule. `Subject_Scheduler.xlsx`
lives in this GitHub repo and acts as the database — the dashboard loads it
automatically over the GitHub API, no file picker required, and (once
editing is enabled) writes changes straight back to it as commits. Anyone
with the site link and a valid school ID can sign in and view it, from any
device.

## Structure

```
index.html                         Landing page / module hub
subject\_scheduler\_dashboard.html   Module 01 — Subject Scheduler
Subject\_Scheduler.xlsx             Your schedule data (the "database")
```

Keep all three files in the same repo — the hub links to the scheduler by
relative path, and the scheduler is hardcoded to read/write
`fielalbert2026/school\_record\_management\_system` on branch `main`.

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

### Master accounts need a second factor now

Because a school ID is only ~8 digits, it's brute-forceable offline in
minutes even when hashed with a single fast SHA-256 pass — anyone with the
public repo could crack every ID, Master's included, without ever touching
the sign-in form. To close that, **any row marked `Master` also requires an
Owner Passphrase**, verified with **PBKDF2-HMAC-SHA256 at 300,000
iterations** (a deliberately slow hash — the standard mitigation for
password-like secrets) instead of a single fast hash. Two design choices
that matter here, not just decoration:

* **The ID and passphrase fields submit together, in one step.** If entering
  a valid Master ID alone triggered a separate "now enter your passphrase"
  screen, that response *itself* would confirm to an attacker they'd found a
  real Master ID. A wrong passphrase now returns the exact same generic
  "ID not recognized" message as an unrecognized ID — there's no way to
  distinguish "wrong ID" from "right ID, wrong passphrase" from the
  outside.
* **Timing is equalized.** A Guest login and a failed Master check now cost
  roughly the same wall-clock time (the code runs a matching PBKDF2 pass on
  both paths, even when it's thrown away), so response speed alone can't be
  used to tell them apart either.

Guest accounts are unchanged — fast ID-hash lookup, no passphrase — since
they're view-only and the extra cost isn't proportionate there.

**A basic form-level lockout** (5 failed attempts → 30s cooldown) also
exists, but be clear-eyed about what it does and doesn't do: it only slows
down someone typing guesses into the live page. It does nothing against
someone who downloads `Subject_Scheduler.xlsx` and brute-forces the hashes
in their own script, completely offline — the PBKDF2 cost above is the
actual defense against that, since it makes each offline guess expensive
too, not just each guess through the form.

**Your Master passphrase was generated once, during setup, and shown only
in that session** — it is not stored anywhere retrievable (only its PBKDF2
verifier is saved, the same way a password manager or login system would
never store your actual password). If it's lost, regenerate it by re-running
the row's derivation with a new passphrase and pushing the updated sheet —
the passphrase itself never needs to touch the repo.

### Managing Valid_Users

Adding or removing someone now needs a small script rather than typing
straight into the sheet, since the Name column is ciphertext (and Master
rows also carry a PBKDF2 salt/verifier). The salts, iteration counts, and
the AES/PBKDF2 scheme are defined at the top of `index.html`'s script and in
the generation logic used to build this sheet; reuse that same logic (in
Python via `hashlib.pbkdf2_hmac` and the `cryptography` package's `AESGCM`,
or equivalent) to add new rows so the in-browser verification keeps
matching. For a new Master account specifically, generate a fresh random
passphrase, hand it to that person once, and store only its verifier.

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

## Opening it directly (without a host)

Just open `index.html` in a browser — reading works immediately since it
talks to the public GitHub API directly; no server or local setup needed.
This is mainly useful for testing changes before pushing them; day to day,
share the hosted URL (GitHub Pages or Vercel) so everyone signs in from the
same place instead of a local copy.

## Publishing / updating this repo

```bash
git add .
git commit -m "Update dashboard"
git push
```

With GitHub Pages enabled (**Settings → Pages → Deploy from branch → main,
root**), the live site updates automatically after each push:
`https://fielalbert2026.github.io/school\_record\_management\_system/`

(If you're deploying via Vercel instead of GitHub Pages, this URL doesn't apply — use your Vercel project's URL instead. Vercel only hosts the static files; it has no bearing on the GitHub owner/repo the dashboard reads and writes to, which is the `GH` config above.)

## Announcements

The hub now has an Announcements section, above the module grid. Anyone
signed in can read it; only Master accounts can post, edit, or delete.

* Stored as its own sheet (`Announcements`) inside `Subject_Scheduler.xlsx`,
  alongside the schedule and `Valid_Users` — same file, same GitHub PAT flow
  the Scheduler module already uses. Entering the token in either page
  ("Remember on this device") makes it available in both, since they share
  the same `localStorage` key.
* Each entry stores `ID, Title, Message, Author, Date`. `Author`/`Date` are
  overwritten with whoever (and whenever) last saved that entry — this is
  what the "Updated by …" line at the bottom of each card reflects. It's a
  last-editor record, not necessarily the original poster.
* Same conflict handling as the Scheduler: a 409 on save means someone else
  wrote first, so the page reloads the latest version and asks you to redo
  the change rather than silently overwriting it.

## Master editing — what changed

Two bugs are now fixed on the Scheduler module:

1. `persistToFile()` used to fail **silently** if editing wasn't enabled —
   the form would close as if the save worked, but nothing reached GitHub,
   and the change vanished on next reload with zero explanation. It now
   alerts you immediately and reopens the token prompt.
2. The row-level **Edit**/**Delete** buttons were gated only on being a
   Master, not on editing actually being enabled — so a Master without an
   active token could open the edit form, "save," and lose the change with
   no warning. They now check for an active token first and prompt for one
   if it's missing, and a failed save rolls the in-memory change back
   instead of leaving the UI out of sync with what's actually on GitHub.

None of this touches the actual security boundary — a Master still needs a
valid GitHub PAT to write anything, same as before. What changed is that
Master actions no longer fail quietly.

## Adding a new Master user

`generate_master.html` is an owner-only credential tool — everything happens
in your browser, nothing is sent anywhere, but it's meant to be run whenever
you need it (not shipped to end users). It supports two ways to bring on a
new Master:

* **Auto-generate (recommended default).** The tool generates a random
  20-character passphrase for you.
* **Set it yourself.** Type your own passphrase and hand it off however you
  like. It must be **at least 12 characters** and use **at least 2 character
  types** (lowercase, uppercase, digits, symbols) — the tool won't let you
  generate a row until both are met, since a short or single-class
  passphrase is the one thing standing between an offline attacker and a
  Master account once they have the public sheet. There's a live strength
  meter and a "Show" toggle on both fields so you can check what you typed
  before generating.

Either way:

1. Enter the new person's School ID and name.
2. It derives `Master_Salt`, `Master_Verifier`, and the AES-GCM-encrypted
   `Name_IV`/`Name_Enc` from the passphrase — using the exact same
   PBKDF2-HMAC-SHA256 (300,000 iterations) scheme as `index.html`'s sign-in
   check, so the row it produces verifies correctly regardless of which mode
   you used.
3. Copy the generated row into `Valid_Users`, commit, and hand the
   passphrase to that person through a separate channel from their ID.

The passphrase — generated or typed — is shown once, in your browser only,
and is never written anywhere; the tool doesn't remember it after you leave
or refresh the page.
anywhere — if you lose it before saving it, generate a fresh one.

## Modules

* **Subject Scheduler** (live) — weekly class schedule with professors,
rooms, Google Classroom and Google Meet links, School Year (SY) and Term,
a live "Today" view with Now/Next/Later/Done status, and a live countdown
to your next class.
* **Flashcard Reviewer** (coming soon) — spaced-repetition decks for quiz
review.

