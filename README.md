# Personalized School Record Management System

> **Verbiage note (standing instruction):** wording/phrasing edits made
> directly to this file or the HTML files, by hand, take priority — future
> doc updates should preserve them rather than silently reverting to
> whatever this file previously said, even if that edit happens without a
> heads-up first.

A shared dashboard for managing your school schedule. `Subject_Scheduler.xlsx`
lives in this GitHub repo and acts as the database — the dashboard loads it
automatically over the GitHub API, no file picker required, and (once
editing is enabled) writes changes straight back to it as commits. Anyone
with the site link and a valid school ID can sign in and view it, from any
device.

## Structure

```
index.html                         Landing page / module hub
subject_scheduler_dashboard.html   Module 01 — Subject Scheduler
flashcards.html                    Module 02 — Flashcards
audit_log.html                     Module 03 — Audit Log (owner only)
Subject_Scheduler.xlsx             All app data (the "database")
api/verify-master.js               Server-side ID+passphrase check → signed edit session
api/save.js                        Server-side commit to GitHub, using the signed session
api/draft-cards.js                 Server-side proxy to Claude for card_drafter.html (keeps the Anthropic key off the browser)
package.json                       Declares the xlsx dependency the functions above need
```

Keep everything in the same repo — the hub links to the other pages by
relative path, every page is hardcoded to read/write
`fielalbert2026/school_record_management_system` on branch `main`, and the
two `api/*.js` files are what make editing work (see "How this actually
works" below) — this repo needs to be deployed on Vercel, not just GitHub
Pages, for saving to function.

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
* **The actual security boundary changed for the better here:** writing to
  the file now requires re-confirming your passphrase through
  `/api/verify-master`, which independently re-derives your identity
  server-side — it doesn't just trust whatever the sign-in step already
  decided. See "How this actually works" further down for the full picture.
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
`Subject\_Scheduler.xlsx` from this repo via the public GitHub Contents API
and parses it — works in any modern browser, no setup needed to just view
your schedule.
* **Editing needs your passphrase, not a GitHub token.** Click **"Enable
editing"** and confirm your school ID + passphrase — the same credentials
you already sign in with. There is no GitHub account, token, or repo
collaborator step for any Master, ever. Every save is still a real commit
to this repo; it just happens through a small server-side proxy instead of
the browser talking to GitHub directly.

### How this actually works (and why it changed)

Earlier versions of this app had each Master paste their own GitHub
Personal Access Token, and every browser committed to GitHub directly. That
turned out to have a real gap: being a `Master` in the app and having
**write access to this GitHub repo** are two completely different things —
a Master could see every editing button and still have every save silently
rejected by GitHub, because they'd never been added as a repo collaborator.

Now, **one single GitHub credential lives server-side** (as a Vercel
environment variable, never shipped to any browser), and two small
serverless functions stand between the app and GitHub:

* **`/api/verify-master`** — re-checks a submitted ID + passphrase against
  `Valid_Users` using the *exact same* lookup-hash, PBKDF2, and AES-GCM
  scheme `index.html` already used client-side (ported to Node's built-in
  `crypto` module, not a separate re-implementation prone to drifting out
  of sync). On success, it issues a short-lived **signed edit session**
  (12 hours) — a token this app invented and controls, not a GitHub
  credential, so it's useless anywhere except this app's own `/api/save`.
* **`/api/save`** — checks that signed session is valid and not expired,
  then commits to GitHub using the one server-held credential. No browser
  ever sees that credential.

**What this means in practice:**
* Any Master can edit — the moment they're added to `Valid_Users`, that's
  the whole setup. No GitHub account, no collaborator invite, no per-person
  token.
* GitHub's own commit history and the Audit Log both correctly attribute
  each save to the real person who made it, decrypted server-side from
  their passphrase the same way the browser already does.
* **Vercel is required for editing to work** — the two `/api/*` functions
  only run on a platform that executes serverless functions. If you (or
  anyone) opens this app via GitHub Pages or straight from a local file,
  *reading* still works fine (that's a direct, unauthenticated call to
  GitHub's public API), but "Enable editing" will fail, since GitHub Pages
  serves static files only and has nowhere to run `/api/verify-master`.
  Card Drafter's "Draft cards from this file" button is in the same boat —
  it calls `/api/draft-cards`, so it also needs Vercel (and the
  `ANTHROPIC_API_KEY` env var below) to work; everything else on that page
  (upload, export to Anki/.xlsx/CSV) works anywhere.

### One-time server setup (only the repo owner needs to do this)

In the Vercel project → **Settings → Environment Variables**, add:

| Name | Value |
|---|---|
| `GITHUB_TOKEN` | A GitHub fine-grained Personal Access Token — **your own account only**, scoped to just this repo, permission `Contents: Read and write`. This is the one and only GitHub credential the whole system uses. |
| `SESSION_SECRET` | Any long random string (e.g. generate one with `openssl rand -hex 32`, or any password generator producing 40+ random characters). Used to sign edit sessions — treat it like a password; if it ever leaks, rotate it and every active edit session is instantly invalidated. |
| `ANTHROPIC_API_KEY` | An Anthropic API key (from console.anthropic.com), used only by `/api/draft-cards` to power Card Drafter's question drafting. Without this set, reading/reviewing/managing flashcards still works fine — only the Card Drafter's "Draft cards from this file" button needs it. |

Redeploy after adding these (Vercel prompts for this automatically, or
trigger it with an empty commit). That's the entire setup — no other Master
needs to touch this section, ever.

**Keeping `GITHUB_TOKEN` fresh:** fine-grained tokens expire (90 days is
typical). When it does, generate a new one the same way and update the
Vercel environment variable — nothing else needs to change.

### Multiple devices

Since the schedule lives on GitHub, you can open the dashboard from any
device and see the same data. If two people (or two tabs) save at nearly
the same moment, the second save detects the conflict, reloads the latest
version automatically, and asks that person to redo their change — this
avoids silently overwriting someone else's edit.

## Opening it directly (without a host)

Opening `index.html` straight from a local file still works for **reading**
— it talks to the public GitHub API directly, no server needed to just view
the schedule. **Editing won't work this way**, since "Enable editing" needs
the `/api/*` functions, which only run when the site is actually deployed
on Vercel. For day-to-day use (and for editing to work at all), share the
Vercel-hosted URL.

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
  alongside the schedule and `Valid_Users` — same file, same editing flow
  the Scheduler module already uses. Enabling editing on either page
  ("Remember on this device") makes it available in both, since they share
  the same `localStorage` key.
* **Only the 3 most relevant announcements show by default** (pinned and
  active ones sort first) — a **"Show N more"** button expands the rest,
  and collapses back down with "Show less." This is purely a display
  preference, kept in memory only; it resets each time the page loads.
* Each entry stores `ID, Title, Message, Author, CreatedAt, UpdatedAt,
  ExpiresAt, Pinned`.
  * `CreatedAt` is set once and never changes. `Author`/`UpdatedAt` reflect
    whoever last saved that entry — that's what the "updated by …" line
    on a card means when it appears.
  * `ExpiresAt` now stores a **date and time**, not just a date — the
    add/edit form uses a datetime picker, so an announcement can expire at
    an exact moment instead of always at midnight.
  * Past that moment the card gets an "Expired" badge and sorts to the
    bottom of the list, but stays visible for a **2-day grace period**
    after expiring — long enough that people who check the dashboard every
    few days don't miss something that just expired. After those 2 days,
    the card stops appearing on the dashboard entirely. This is a *display*
    filter only — the row isn't automatically deleted from the sheet, so a
    Master can still find it and delete it manually if they want it gone
    from the data too, and nothing is lost if the 2-day window was wrong
    for a given case.
  * `Pinned` puts an entry at the top of the list (above other active
    entries, but still below anything expired — an expired pin doesn't
    outrank a live announcement). Pinned cards get a highlighted border
    and a 📌 badge.
* Same conflict handling as the Scheduler: a 409 on save means someone else
  wrote first, so the page reloads the latest version and asks you to redo
  the change rather than silently overwriting it.
* The parser reads columns by header name, not fixed position — so if this
  sheet ever gets columns reordered or extra columns added by hand, sign-in
  and rendering still work as long as the header names above are intact.

## Reminders

Also on the hub, right below Announcements. Same visibility rule as
everything else here: anyone signed in can see them, only Masters can add,
edit, or delete.

* Each reminder is `Subject, DateAdded, ExpiresAt, Importance` — `DateAdded`
  is set automatically when a Master creates it (not user-editable);
  `ExpiresAt` is a required date+time; `Importance` is one of
  **Low / Medium / High**.
* **Color-coded by importance**, not by anything else: Low is gray, Medium
  is yellow, High is red — the same badge appears on every reminder card so
  it's scannable at a glance without reading the text.
* Sorted by importance first (High, then Medium, then Low), and within the
  same importance, by soonest expiration first — so the thing that's both
  most urgent and soonest-due always floats to the top.
* Unlike Announcements, reminders **don't auto-hide after expiring** — an
  expired reminder just shows "Expired [date]" instead of "Expires [date]"
  and stays in the list until a Master deletes it. This was a deliberate
  choice: a reminder past its date is often still worth acting on or at
  least noticing, where an announcement past its date usually isn't.
* The Subject field suggests existing subject names from the Scheduler's
  own sheet as you type (via the browser's native autocomplete), but it's
  free text — nothing stops you from typing something that isn't an actual
  scheduled subject.
* Stored as its own sheet (`Reminders`) in `Subject_Scheduler.xlsx`, saved
  in the **same commit** as any Announcement change (and vice versa) — both
  live on the hub and share one save function, so editing either one writes
  both sheets in a single GitHub commit rather than two separate ones.
* Every add/edit/delete logs to the Audit Log, same as everywhere else.

## Master editing — what changed


Two bugs are now fixed on the Scheduler module:

1. `persistToFile()` used to fail **silently** if editing wasn't enabled —
   the form would close as if the save worked, but nothing reached GitHub,
   and the change vanished on next reload with zero explanation. It now
   alerts you immediately and reopens the "Enable editing" prompt.
2. The row-level **Edit**/**Delete** buttons were gated only on being a
   Master, not on editing actually being enabled — so a Master without an
   active edit session could open the edit form, "save," and lose the
   change with no warning. They now check for an active session first and
   prompt for one if it's missing, and a failed save rolls the in-memory
   change back instead of leaving the UI out of sync with what's actually
   on GitHub.

None of this touches the actual security boundary — a Master still needs a
valid, unexpired edit session (from re-confirming their passphrase) to write
anything. What changed is that Master actions no longer fail quietly.

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

## Audit Log

`audit_log.html` is a read-only history of sign-ins and changes, restricted
to a single account — not "Masters in general."

* **Owner-only, by school ID.** A constant (`OWNER_SCHOOL_ID`, currently
  `24050009`) is compared against the raw ID typed at sign-in, *before* it's
  hashed — every other Master, however many exist, sees the module hidden
  on the hub and gets a "Restricted" screen if they open `audit_log.html`
  directly. To hand this off to a different ID later, update
  `OWNER_SCHOOL_ID` in `index.html` — it's the single source of truth,
  copied into the session object at login and read by every other page.
* **Stored as its own sheet** (`Audit_Log`) in `Subject_Scheduler.xlsx`,
  alongside everything else — columns `Timestamp, Actor, Role, Action,
  Details`.
* **Timestamps are in Philippines time (UTC+8),** regardless of the visitor's
  own timezone — generated by a shared `phTimestamp()` helper (present in
  `index.html`, `subject_scheduler_dashboard.html`, and `flashcards.html`,
  the three pages that ever write a log entry) as a zero-padded
  `YYYY-MM-DDTHH:mm:ss+08:00` string, so it still sorts correctly as plain
  text in the viewer.
* **No edit or delete controls exist for it, anywhere.** That's deliberate:
  a log that can be edited from the app isn't trustworthy as a log. (The
  underlying xlsx sheet could still be hand-edited by anyone with repo write
  access, same caveat as everything else in this file — see the sign-in
  section above for why this system is upfront about that instead of
  pretending otherwise.)
* **What gets logged:** every Master mutation — Add/Edit/Delete Subject,
  Add/Edit/Delete Announcement, Add/Edit/Delete Flashcard — plus Master
  Login/Logout.
* **How it's written, and why login/logout are still "best-effort":** even
  with a server-side proxy now doing the actual GitHub write, that proxy
  only runs when a Master has an **active edit session** (from confirming
  their passphrase) — signing in alone doesn't create one, by design, so
  that "signed in" and "editing enabled" stay two distinct, intentional
  states rather than editing being silently always-on. So:
  * Every CRUD action rides along in the **same commit** as the save that
    was already happening — no extra requests.
  * Login and logout queue locally (in `sessionStorage`) the instant they
    happen, then get flushed into the log the next time that Master's
    browser makes any real save — either a scheduler/announcement/flashcard
    change, or logout itself if editing is already enabled by then.
  * If a Master signs in, browses, and signs out **without ever clicking
    "Enable editing" that session**, that login/logout simply never gets
    committed — there's no active edit session that could write it. This is
    an intentional trade-off (not forcing every sign-in through the
    passphrase-verify round-trip just to log it), not a technical
    limitation anymore — it could be closed by silently requesting a write
    session at every login instead of waiting for "Enable editing," if that
    trade-off is ever worth making.
  * **Guest activity is never logged, at all.** Guests have no passphrase
    or write session in this system by design (that's what keeps them
    view-only), so there's nothing that could authorize writing a Guest's
    login anywhere.

## Flashcards

`flashcards.html` — Master accounts build decks, anyone signed in can study
them.

* **Stored as its own sheet** (`Flashcards`) in `Subject_Scheduler.xlsx` —
  columns `ID, Deck, Type, Front, Back, CreatedBy, CreatedAt, UpdatedAt`.
  Same commit flow as the Scheduler and Announcements: Masters need the
  same edit session (shared via the same `localStorage` key, so enabling
  editing on one module unlocks it on all of them) and every add/edit/delete
  is logged to the Audit Log in the same commit.
* **Two card types, one schema:**
  * **Front / Back** — the classic case. Front shows first; "Show Answer"
    reveals Back.
  * **Fill in the blank** — a Master types the full sentence and wraps the
    word to hide in double brackets, e.g.
    `The mitochondria is the [[powerhouse]] of the cell.` On save, that's
    split into `Front` (the sentence with the bracketed part replaced by a
    blank marker) and `Back` (just the hidden word) — no separate columns
    needed, and editing a cloze card reconstructs the `[[bracket]]` form
    from those two fields automatically.
* **Decks are a free-text field, not a separate sheet** — but typed names
  are normalized so near-duplicates can't quietly pile up. `"General -
  Test1"`, `"General- Test1"`, and `"General  -  Test1"` are all treated as
  the same deck: trimmed, whitespace-collapsed, hyphen-spacing
  standardized, compared case-insensitively. Two things enforce this:
  * A **datalist** on the Deck field suggests existing deck names as you
    type, so reusing one is usually just a click.
  * On save, whatever you typed gets matched against existing decks by that
    normalized form — if one matches, your card joins the *existing* deck's
    exact spelling rather than creating a new near-duplicate entry. If nothing
    matches, your typing is still lightly cleaned up (trimmed, single-spaced)
    before being stored as the new canonical spelling.
  * On every load, any decks that already differ only by that kind of
    whitespace/hyphen noise are silently merged in memory to the
    first-seen spelling — so even old duplicate data heals itself the next
    time anyone opens the page and saves anything.
* **Reviewing is a repeating drill, not spaced-repetition scheduling.** Pick
  a deck (or "All decks") and optionally shuffle. Each card shows a plain
  **Show Answer** button; once revealed, three buttons replace it:
  * **Again** — the card rejoins the shuffle very soon (within the next
    couple of cards).
  * **Hard** — the card rejoins later in the current pass.
  * **Don't Show (10 min)** — the card leaves rotation entirely and
    automatically rejoins after 10 real minutes (checked every 15 seconds
    in the background, so it reappears on its own without needing a
    manual refresh).

  Every card you grade keeps coming back around — there's no "I know this,
  remove it" option by design, so a review session is just "keep drilling
  until you close the tab or pick a different deck/shuffle." A small counter
  above the card (`N remaining · Again N · Hard N · Snoozed N`) tracks the
  current session's activity; it isn't written anywhere, so it resets the
  moment you reshuffle, switch decks, or reload the page. If everything is
  currently snoozed, the card area shows how many are waiting and roughly
  when the next one is due instead of an empty screen.

## Dark Mode

A small circular toggle (🌙 / ☀️) sits fixed in the top-right corner on every
page.

* Preference is saved to `localStorage` and applies instantly on every page
  — no flash of the wrong theme on load, since a tiny inline script sets it
  before the page even starts rendering.
* The Scheduler's "Today" panel and live countdown are a fixed dark accent
  block in both themes on purpose — it's a deliberate spotlight, not a
  themeable surface, so it doesn't invert to light-on-light in dark mode.
* Everything else — cards, forms, tables, buttons — is built from the same
  CSS variables in both themes, so this needed no page-specific redesign,
  just a second set of values for the same names.

## Modules

* **Subject Scheduler** (live) — weekly class schedule with professors,
  rooms, Google Classroom and Google Meet links, School Year (SY) and Term,
  a live "Today" view with Now/Next/Later/Done status, and a live countdown
  to your next class.
* **Flashcard Reviewer** (live) — Front/Back and fill-in-the-blank decks;
  Masters build them, anyone signed in can study them.
* **Audit Log** (live, owner-only) — read-only history of sign-ins and
  changes across the system.


