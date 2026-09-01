# Peak — Adaptive Personal Training Plan

A static web app that turns three short onboarding steps into a full training plan, tells
you honestly whether your goal is reachable, and reshapes the plan as you log sessions and
run test weeks.

Plain HTML/CSS/JS with **Firebase Auth** for accounts and **Firebase Firestore** for
storage. No build step, no framework, no npm.

---

## What it does

**Onboarding (3 steps)**

1. **Where you are now** — strength frequency, cardio frequency, how long you can run
   comfortably, your 5K time (optional), and any muscle groups you want to keep injury-free.
2. **The time you actually have** — sessions per week, minutes per session, and a
   day-by-day map of existing commitments (soccer Tuesday and Thursday evenings, say).
3. **What you're chasing** — a running time/distance goal or general fitness, plus a deadline.

Before anything is built, the goal is checked against your starting point, your schedule,
and the calendar. If it doesn't add up you're told why, with a concrete alternative, and
nothing is saved until you choose to change the goal or proceed anyway.

**Then four tabs**

- **Today** — the session in full, with a one-tap RPE log
- **Week** — all seven days, navigable across the whole plan
- **Plan** — every week at a glance, phases, test weeks, gear list, feasibility warnings,
  and a running projection of your goal
- **Coach** — tell it what actually happened and it changes the plan around you
- **Profile** — current fitness, training paces, editable goal / schedule / injury focus,
  every adjustment the plan has made, and your account

## How the plan is generated

There is no lookup table of pre-written weeks. `plan-engine.js` generates every session:

- **Fitness score (VDOT)** — from your 5K time via Jack Daniels' formula, or estimated from
  your comfortable run duration and cardio frequency. Every training pace comes from it.
- **Weeks available** — counted back from your deadline, setting the phase structure:
  Base → Build → Peak → Taper, with a deload every 4th week.
- **Session scheduling** — commitments are subtracted first, then sessions are spread across
  what's left to maximise spacing. Long runs land on a weekend where possible; hard sessions
  are pushed as far apart as the week allows.
- **Minimum gear** — bodyweight first. Every exercise lists an easier and a harder variation.
  The Plan tab aggregates the full gear list.

## Intensity philosophy: ambitious, and polarised

The plan is deliberately aggressive about **quality**, and equally strict about keeping easy
days easy. Running everything at a moderate RPE 6 is the least productive way to train.

- Start at 70–90% of your stated capacity (not 55%) and reach full volume by ~70% of the build
- Two quality sessions a week from Build onward — intervals **and** tempo
- Intervals at **RPE 9** with a repetition-pace finisher; tempo at **RPE 8**
- Long runs carry a **fast finish** in Build and Peak — the final quarter at threshold effort
- Strength sets taken to within 1–2 reps of failure, short rest, with a finisher
- Easy days pinned at **RPE 4**, with the session text explaining why that's the point

**Two limits deliberately override ambition**, because they're where ambition backfires:

1. **Session length never exceeds what you said you have.** Ambition is expressed through
   intensity, not by quietly stealing your time.
2. **A beginner with no current cardio gets two weeks at 82% before the ramp.** Your heart
   adapts in weeks; tendons and bone take months. This is disclosed in the plan, not hidden.

Hard running days are capped at two per week. More than that doesn't produce more fitness —
it produces interrupted training.

## Feasibility warnings

`feasibilityReport()` runs before the plan is built and again on every Plan tab render.

| Check | Example |
|---|---|
| Enough calendar for the distance | Marathon in 6 weeks → **blocker** (needs 16) |
| Starting base vs the distance | Marathon from under-10-min runs → **blocker** |
| Target time vs achievable gain | 30:00 → 18:00 in 8 weeks → **blocker**, suggests a real target |
| Sessions per week vs the goal | 2/week for a half → **warning** |
| Long run vs session limit | Half on 45-min sessions → **note** |
| Volume ramp risk | No cardio → 6 sessions/week → **warning** |

Blockers say what to do instead, with a specific date or time. They never stop you — you can
always build it anyway, and the warnings follow you onto the Plan tab.

## Design

Black ground, one electric accent, heavy condensed display type, oversized numerals,
generous air. Built to be read at arm's length, mid-session, out of breath — so the things
you need while training (what, how long, how hard) are the largest things on screen.

- **Type** — [Anton](https://fonts.google.com/specimen/Anton) for headings and numerals,
  system stack for body text so it renders instantly and offline. One external font, one
  request, with a real fallback stack (`Haettenschweiler`, `Arial Narrow`).
- **Colour** — `#D8FF00` volt, used only where it means something: the active tab, a logged
  session, your fitness number, the primary action. Never decoration.
- **Structure** — near-square cards, pill buttons, uppercase micro-labels at 0.14em tracking.
  Workout steps are numbered `01`–`05` so you can find your place at a glance.
- **Voice** — imperative and short. *Log it. Rate it first. Build it. Rest.*

This deliberately borrows the visual language of athletic brands — bold condensed caps, high
contrast, big numbers. It does **not** use any brand's trademarks: no swoosh, no wordmark,
no borrowed slogan. The style is the point, not the badge.

The CSP allows `fonts.googleapis.com` (stylesheet) and `fonts.gstatic.com` (font files) for
exactly this one face. Nothing else external loads.

## The coach

A chat tab that turns what you tell it into real changes. It is **rule-based, not an LLM** —
it runs offline, costs nothing, needs no backend or API key, and is fully deterministic,
which is why all of it is covered by tests.

| You say | What happens |
|---|---|
| "ran 30 easy instead of the intervals" | Logs the real session at the real effort, on the interval day — not just today |
| "missed today, no time" | Moves it to a free day this week, or tells you to let it go |
| "can't train Thursday, work dinner" | Blocks the day, moves the session, reshuffles the week |
| "I'm away tuesday to thursday" | Handles the whole range |
| "legs are wrecked" | Cuts volume, holds intensity, explains why that way round |
| "felt great, too easy" | Raises volume, refuses to make your easy days harder |
| "my knee hurts" | Removes impact for three days, adds knee prehab, tells you to see a physio |
| "played tennis for an hour and did a 50 min run at 5:41/km" | Logs both sessions with their own durations, reads the pace, compares it to your easy pace |
| "add 2 upper body sessions on Tuesdays and Thursdays" | Adds standing sessions every week, alongside existing work where that makes sense |
| "remove the Tuesday session" | Takes it back out |
| "move my long run to Sunday" / "swap Tuesday and Thursday" | Rearranges the week |
| "I want to train 5 times a week" / "make my sessions 45 minutes" | Changes the schedule itself |
| "replace pull-ups with dips" / "I don't have a pull-up bar" | Exercise-level rules that persist across every session |
| "remove burpees" / "I want more core work" | Excludes a movement or shifts the emphasis |
| "did the intervals" / "nailed it today" | Logs the prescribed session as done |
| "reduce the volume by 20%" | Honours the number you gave |
| "I ran a 5k PB today, 23:40" | Treats a measured max effort like a test — recalculates every pace |
| "why is my easy pace so slow" / "what's a deload" | Explains the reasoning, changes nothing |
| "undo that" / "I logged that wrong" | Reverses the last change. Every coach action is snapshotted first |
| "that was Tuesday not Monday" / "delete yesterday's log" | Corrects or removes a log |
| "I'm sick, fever since yesterday" | Stops training. The neck check, explained |
| "I've got a cold" | Keeps the session, strips the intensity |
| "I've got a parkrun on Saturday" | Adds the race, protects the days either side |
| "I'm on holiday for two weeks" | Blocks the span; adherence isn't punished |
| "just got back after 3 weeks off" | Returns you at reduced volume, not where the plan left off |
| "I only have a treadmill" / "it's 35 degrees" | Switches to effort only, pace targets off |
| "I only slept 4 hours" / "big night out" | Cuts load, explains why |
| "am I getting fitter?" | Measured vs estimated progress, honestly separated |
| "what am I doing today?" | Answers from your actual plan |

Coverage is measured, not assumed: `probe.html` runs 37 realistic phrasings across
logging, load, plan changes and exercise changes, and reports what each one resolves to.
All 37 are understood. `audit.html` is separate and more important: it tests the
*interactions* — what happens when illness, a race, a block, a move and an added session all
land on the same week. Feature-by-feature tests passed while several of those combinations
were broken. `probe-gaps.html` covers a further 35 (illness, races, absence, environment, corrections, safety) — all 35 handled. Run it whenever you change the parsing.

### Typos and messy input

Real messages are misspelt, abbreviated and rambling. Matching is fuzzy, using bounded
Damerau-Levenshtein so transpositions ("delaod", "thurdsay") cost one edit rather than two —
they're the commonest typo and plain edit distance handles them badly.

Naive fuzzy matching is dangerous, so three guards apply:

1. **Words under 5 characters must match exactly.** At that length everything is one edit
   from everything.
2. **The first letter must match.** Typos overwhelmingly preserve it, and this is what stops
   *face* → *race*, *rain* → *pain*, *gold* → *cold*.
3. **Real English words are never treated as typos.** This shipped as a bug: "add some gym
   **stuff**" matched *stuffy* and reported the athlete as ill.

Apostrophe-less contractions ("dont", "cant", "im", "didnt") are expanded first —
deliberately excluding "ill", "its" and "well", where expansion would break more than it
fixes.

**Rambling messages** carrying several signals get acted on by priority, and the coach names
what else it saw rather than silently ignoring half the message. Safety replies are never
diluted this way.

`probe-messy.html` measures this: 26 misspelt, abbreviated and rambling inputs, all handled.

**Where this runs out.** This is pattern matching, not comprehension. It handles messy
phrasings of things it knows about; it cannot handle a genuinely novel request, and it will
never infer intent from context the way a language model would. When it doesn't understand,
it says so rather than guessing — which is the honest failure mode for a system that changes
your training plan.

**It says when it hasn't understood**, and offers examples instead of guessing. A coach that
silently misinterprets you is worse than one that admits the gap.

**Where it stops.** Some things are not training problems and the coach refuses to treat
them as such — it makes no plan change at all, rather than quietly softening next week:

| Disclosure | Response |
|---|---|
| Chest tightness, fainting, palpitations, numbness | Stop training, seek care today. Nothing in the plan is touched. |
| Skipping meals, restricting, purging | No plan change, no numbers, and a route to a GP, dietitian or helpline |
| Calories, supplements, diet questions | Declined, with a pointer to someone who can actually see you |

Each of these was originally mishandled: chest tightness was treated as a niggle, and
*"I've been skipping meals to lose weight"* was parsed as a missed session and **rescheduled a
workout**. Silently doing the wrong thing is worse than admitting the gap, so all three are
now checked before anything else and covered by tests.

**What it won't do.** It can't change your goal or deadline — that runs the feasibility gate,
so it hands you to the goal editor instead of quietly retargeting your plan. And it isn't a
physio: it takes the load off and tells you to get it looked at, but it never diagnoses.
Describe something sharp, swollen, or worsening and it says plainly that you're past what a
training plan should be working around.

**Everything is reversible.** Each coach action snapshots the fields it will touch before
mutating them, so "undo that" always works. The coach changes real state, and a change you
can't take back is a change you can't trust.

Everything it changes is stored in `coachOverrides` and applied *on top of* the generated
plan, never baked into it — so every change is reversible by clearing the override, and the
underlying plan stays intact.

Two things it deliberately refuses to do, both from watching it get them wrong in testing:

- **It never converts a test to another modality.** A bike time trial can't calibrate running
  paces, and a time trial run injured gives a slow, unrepresentative number that would then
  reset every pace in your plan. It postpones the test and says why.
- **It never puts anything on a test day.** Lifting around a max-effort time trial
  corrupts the result, and that result recalibrates every pace in the plan.
- **It never stacks two sessions on one day** when reshuffling. If there's no free day, the
  session is dropped and you're told, because doubling up is how a missed session becomes a
  missed fortnight.

## Changing your mind

Goals move. **Profile** lets you edit:

- **Your goal** — distance, target time, deadline, or switch between running and general
  fitness entirely. Changing it re-runs the same feasibility gate as onboarding, so you
  can't quietly edit your way into an impossible target.
- **Your schedule** — sessions per week, session length, and commitments.
- **Injury focus** — which prehab work rides along on your easy days.

Editing preserves everything you've done. `planStart` never moves, so logged sessions keep
their week numbers and your training history stays intact — the plan simply re-lengthens or
re-shortens around the new deadline. Every edit is recorded in **Changes you've made**.

Changing sessions-per-week writes a `scheduleHistory` entry rather than overwriting the
number, so past weeks are still judged against what was actually scheduled at the time.
Without that, dropping from 5 sessions to 3 would retroactively make every previous week
look like a success.

## Current fitness is derived, never entered

Your fitness level is **not** an editable answer. It is seeded from your onboarding
responses, then moves on its own:

| Week's training | Effect on the estimate |
|---|---|
| 80%+ of sessions logged | +0.12 to +0.35 VDOT, by training age |
| 50–80% logged | Half that |
| Some, but under half | −0.1 |
| Nothing logged | −0.3 (detraining is real) |
| **A test week result** | **Replaces the estimate outright** |

Untested drift is capped at ±4 VDOT, because an estimate that has never been checked
against a clock shouldn't be allowed to wander indefinitely and start prescribing paces you
can't hold. The Profile card is labelled **Measured** or **Estimated** accordingly — a test
counts the moment you record it, not when the week rolls over.

This is derived from your logs and tests on every load, so it is self-healing: a stored
value can never drift away from the history that produced it. The current number is
mirrored into the document as a `fitness` field so it exists in the backend and can be read
without replaying everything, but derivation always wins.

**The four fitness answers** (strength frequency, cardio frequency, comfortable run
duration, 5K time) are **immutable after onboarding**, enforced in the Firestore rules —
not merely hidden in the UI. The only way your fitness level can move is by actually
training or actually testing.

## How it adapts

Adaptation runs silently on every load, recomputed from your logs so it always matches what
you've actually done. Every change is recorded in **Profile → Plan adjustments**.

| Signal | Response |
|---|---|
| Under 60% of sessions over 3 weeks | Volume trimmed 15% |
| Under 50% for two straight weeks | Drop one session per week |
| Full attendance, sessions feeling easy | Volume up 5% |
| Logged RPE running >1.2 above target | Load eased 8% |
| Test week result | Fitness score reset, all paces recalculated |

Volume is clamped to 60–115% of baseline. **Test weeks** land in week 1 and every 4th week
after, always on a deload. Running tests are always 5K or shorter — a 5K predicts every other
distance through VDOT at far less recovery cost than racing the full distance mid-plan.

---

## Try it before setting anything up

Add `?demo=1` and the whole app runs against `localStorage` — no account, no Firebase, nothing
leaves the browser.

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000/index.html?demo=1`. Open `/test.html` to run the engine suite
(345 checks: VDOT math, plan structure, scheduling, volume ramp, intensity, every adaptation
rule, derived fitness, schedule history, feasibility, and coverage of every requirement).

It must be served over HTTP — `file://` breaks ES module imports.

---

## Setup

### 1. Create the Firebase project

1. [console.firebase.google.com](https://console.firebase.google.com) → **Add project**.
2. Click **`</>`** to register a web app.
3. Copy the config into **`firebase-config.js`**, replacing the `REPLACE_ME` placeholders.

### 2. Enable authentication

1. **Build → Authentication → Get started**.
2. Under **Sign-in method**, enable **Email/Password**.
3. Enable **Google** as well if you want one-tap sign-in (recommended — no password to lose).
4. Under **Settings → Authorized domains**, add the domain you'll deploy to
   (`yourname.github.io`). `localhost` is already allowed.
5. Under **Templates → Email address verification**, set the sender name and reply-to so the
   mail doesn't read as spam. The default template works as-is; the link points at a
   Firebase-hosted confirmation page.

**Email/password accounts must confirm their address before they can create a plan.** The
confirmation mail is sent automatically at sign-up. Google sign-in skips this — Google has
already proven the address.

> If you created an account while testing an earlier version, it exists but is unconfirmed.
> Sign in and use **Resend the email**, or delete the user under **Authentication → Users**
> and sign up again.

### 3. Enable Firestore and publish the rules

1. **Build → Firestore Database → Create database → Start in production mode**.
2. Open the **Rules** tab, paste in the contents of **`firestore.rules`** from this repo,
   and **Publish**. Do not skip this — the default production rules deny everything, and
   test-mode rules allow the entire internet to read your data.

### 4. Deploy

Push to a GitHub repo, then **Settings → Pages → Deploy from a branch**, `main`, `/ (root)`.

---

## Security and privacy

**Authentication.** Every document is keyed to the Firebase Auth `uid`. Nothing is derived
from your name, so document IDs can't be guessed, and the rules pin every read and write to
`request.auth.uid`. There is no path to another person's data, authenticated or not.

**Email verification.** The rules require `request.auth.token.email_verified == true` on
every read and write, so an unconfirmed account cannot create, read, or modify anything.
This is enforced in the rules rather than the sign-in screen on purpose: a UI gate stops
nobody, because anyone can call the Firestore REST API directly with an unverified account's
token. Google sign-in arrives already verified.

One subtlety worth knowing if you ever debug this: an ID token is minted at sign-in and
keeps reporting `email_verified: false` even after the user confirms. The client
force-refreshes the token (`getIdToken(true)`) the moment it detects confirmation —
without that, a user who has genuinely just confirmed would keep getting permission
errors until their token happened to expire.

**What the rules enforce** (`firestore.rules`):

- `get` — only your own document
- `list` — **denied outright**, so the collection can't be enumerated
- `create` — only your own uid, with validated shape and size, and empty logs/tests
- `update` — only `logs`, `tests`, `fitness`, `goal`, `schedule`, `scheduleHistory`,
  `profile`, `changeLog`, `chat`, and `coachOverrides`, each validated for shape and
  bounded for size (the coach's load factor is clamped in the rules too, not just the app)
- `planStart` is immutable — if it could move, every logged date would silently re-index
- The four fitness answers inside `profile` are immutable, so editing your goal or schedule
  cannot launder a new fitness level into the plan
- `delete` — only your own document
- Everything else denied by default

### Verify the rules are actually live

Publishing rules is the one step where a silent mistake exposes everything, so check it
rather than assume. With `PROJECT_ID` from your Firebase config, run these **signed out**
(plain curl sends no auth token):

```bash
curl -s "https://firestore.googleapis.com/v1/projects/PROJECT_ID/databases/(default)/documents/users" | head -20
```

You want `PERMISSION_DENIED`. If you get a list of documents, your rules are not live and
every profile in the project is world-readable — republish `firestore.rules` immediately.
Do the same for a single document:

```bash
curl -s "https://firestore.googleapis.com/v1/projects/PROJECT_ID/databases/(default)/documents/users/SOME_UID" | head -20
```

`PERMISSION_DENIED` again is the correct answer. The Firebase console's **Rules → Playground**
does the same check interactively: simulate a `get` on `users/{someoneElsesUid}` while
authenticated as a different uid, and confirm it denies.

Re-run these after every rules edit. A rules file sitting in the repo protects nothing —
only the version published in the console is enforced.

**What's stored.** Your training answers, logged sessions, and test results. No location, no
health-app data, no analytics, no third-party scripts. Free-text input is limited to a 60-char
name and 40-char commitment labels, both length-capped client-side and validated in the rules.

**Robustness.** `stress.html` builds plans from deliberately malformed documents — null
collections, wrong types, an illness with no end date, `NaN` load factors — because Firestore
can hand back a partial or stale document and the app must not blank out. It also covers
numeric extremes (a one-second 5K, a negative time), plan boundaries (2 weeks to 52, six
sessions with two free days), idempotency, and hostile input.

**Performance.** Fuzzy matching costs about **0.3 ms** per message even on a 400-word input,
and a 52-week plan builds in ~1 ms. There is no need for caching or debouncing.

**Error messages.** Exceptions are logged to the console and never rendered verbatim.
Unrecognised failures show a plain message instead of a raw stack or internal string.

**XSS.** All rendering goes through `escapeHtml()` — every user-controlled string
(name, commitment labels) is escaped at every interpolation point. A Content-Security-Policy
meta tag restricts scripts to `self` and the two Google origins Firebase needs.
`'unsafe-inline'` is permitted for **styles only**, never scripts.

**Known limits, honestly:**

- `frame-ancestors` and `X-Frame-Options` can only be sent as HTTP headers, and GitHub Pages
  can't set headers. If clickjacking protection matters, host behind Netlify, Cloudflare, or
  nginx instead.
- The Firebase API key in `firebase-config.js` is public by design — it's a project
  identifier, not a secret. Your data is protected by the rules and by auth, not by that key.
- Password reset relies on Firebase's email flow. Nobody can recover an account whose email
  you no longer control.
- There is no rate limiting beyond Firebase's own. For a personal training app that's fine.
- Consider enabling **Firebase App Check** if you ever make this public — it blocks requests
  from anything that isn't your actual site.

**Deleting your data.** Profile → Start a new plan permanently deletes the document, logged
sessions, and test results. It asks twice and cannot be undone.

---

## Files

| File | What's in it |
|---|---|
| `plan-engine.js` | VDOT math, scheduling, plan generation, adaptation, feasibility, goal assessment |
| `coach.js` | Interprets what you tell the coach and turns it into structured actions |
| `workouts.js` | Exercise library, warm-ups, prehab, strength/conditioning builders |
| `app.js` | Auth, rendering, Firestore I/O, onboarding |
| `index.html` | Shell, CSP, tab structure |
| `style.css` | Everything visual |
| `firebase-config.js` | Your Firebase keys |
| `firestore.rules` | Paste into the Firebase console Rules tab |
| `test.html` | Engine test harness — 305 checks |
| `probe.html` / `probe-gaps.html` | Measured coach coverage, 72 phrasings |
| `probe-messy.html` | Typos, txt-speak and rambling input, 26 cases |
| `audit.html` | Interaction audit — overlapping overrides on one week |
| `stress.html` | Malformed state, numeric extremes, boundaries, performance, hostile input |

## Editing the training content

Exercise pools, prehab, warm-ups, and conditioning formats live in `workouts.js`. Session
structure (interval prescriptions, tempo lengths, volume ramp, phase boundaries, intensity
targets) lives in `plan-engine.js`.

## Cache-busting

`index.html`, `app.js`, `plan-engine.js`, and `coach.js` carry `?v=` on their imports —
currently `v=34`.
Bump them on every deploy that touches CSS or JS, or phones will serve stale copies for days.
