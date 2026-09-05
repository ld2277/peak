# 100-persona × 100-day simulation — findings

**Not yet fixed.** Collected results of `simulate.html`, two passes.

## Method

100 generated personas, each simulated across 100 days: 10,000 simulated days.

Personas vary across every input dimension — goal type and event, fitness level, 5K time
present or absent, injury focus, 2–6 sessions a week, 30–90 min sessions, 0–3 commitments,
deadlines from 3 to 52 weeks — crossed with 10 behavioural archetypes (consistent, erratic,
injury-prone, over-eager, traveller, tinkerer, silent, messy-typer, comeback, racer), each
with its own adherence, chattiness, and rates of illness, injury, travel and racing.

Each day a persona may train or not, may hit a test week, and may send coach messages from a
pool of 64 realistic phrasings including deliberate typos. Coach actions are applied exactly
as `app.js` applies them (verified: the mirror handles every action type `app.js` handles,
bar the UI-only `openGoalEditor`). After every day, ~30 invariants are checked.

**Pass 1** checked structural invariants with a 40-error cap per persona. **Pass 2** removed
the cap (so a noisy failure could not mask a second kind), added invariants for
`goalAssessment`, `feasibilityReport`, fitness timeline, extra-session shape, plan warnings
and Monday races, and added an **intent census** — recording which intent every message
resolved to across all 100 personas — to catch semantic misroutes that structural checks
cannot see.

Constraints worth knowing:

- `computeAdaptation` and `deriveFitness` read the real system clock, so simulated time
  cannot be moved forward. Start dates are staggered (0–120 days ago) as the workaround.
- The sim resets the coach's `pending` payload each day and only carries it between messages
  within a day. The real app persists it on the last coach message across days. The sim
  therefore *under*-tests the pending path.

## Result

Pass 2, uncapped: **496 structural violations in 2 kinds, one root cause** — plus **one
semantic defect found by the census** that produced no structural violation at all.

| Kind | Count | Personas | Root cause |
|---|---|---|---|
| `extraSession` without a main session | 367 | 9, 13, 48, 67 | #1 |
| adherence out of range (>1, up to 1.17) | 129 | 33, 58, 93 | #1 |
| message misrouted by keyword prefix | 1 of 85 in census; reproduced at will | — | #2 |
| "a easy run" in generated copy | 5 | 14, 25, 39, 53 | #3 (minor) |

The grammar category first reported **1,117** hits. **1,112 of those were a harness false
positive**: the check collapsed `\n\n` paragraph breaks into two spaces. Direct inspection of
the flagged replies found no real double space; the check is corrected in `simulate.html`.
The re-run with the corrected check reproduced the structural results exactly (367 + 129,
deterministic) and left **5 genuine hits**, all one slip — see root cause #3.

---

## Root cause #1 — windowed overrides have no lower bound

Every windowed coach override is applied with a test of the form

```js
if (d.date > until || !d.session) continue;
```

which skips days *after* the window and does nothing about days *before* it. A plan spans
weeks of history, so an override created today reaches back across all of it. Races are
correctly scoped because they match an exact `dateKey`, not a range.

Four manifestations, all reproduced directly:

1. **Systemic illness deletes the entire training history from the plan view** and leaves
   coach-added sessions orphaned — the 367 errors. A 6-day window orphaned sessions on 11
   dates from 2026-06-24 to 2026-09-02.
2. **The same unbounded test in `sessionsScheduledForWeek` pushes adherence above 100%** —
   the 129 errors. A week **two months before** the illness went from 5 scheduled sessions
   to 0; adherence moved from a correct 0.67 to 1.0.
3. `softenUntil` (injury) rewrote **29 past sessions** as low-impact.
4. `effortOnly` (treadmill/heat) rewrote **24 past sessions**.

Manifestations 3 and 4 raised **no invariant violation** — a rewritten past session is still
structurally valid. They are silently wrong.

**Severity:** significant and user-visible, not data loss. Logs and tests are intact; the
derived plan view and the adaptation maths are wrong. Clearing the override reverses it.

---

## Root cause #2 — keyword matching has no trailing word boundary

Keyword lists are matched with `t.includes(" keyword")`: a leading space, no trailing
boundary. So every keyword also matches as the **prefix of any longer word**. This predates
the fuzzy-matching work, which is token-bounded and safe; the exact fast-path is the defect.

The census caught it as a single anomaly: `"did my long run yestrday, felt gd"` resolved to
`move` once in 85 sends. Dropping tokens one at a time isolated **"yestrday"** as the
trigger; `" yes"` is a prefix of `" yesterday"`. Reproduction with correct spelling confirmed
it, then a sweep of other short keywords found more:

| Ordinary sentence | Resolved to | Because |
|---|---|---|
| *"I ran 40 min yesterday"* — after any coach refusal | **executes the refused action** | `" yes"` → yes**terday** |
| *"yesterday was a rest day for me"* — same | **executes the refused action** | same |
| *"it took roughly 40 minutes"* | **ease — cuts volume 12%** | `" rough"` → rough**ly** |
| *"I flattened my time by a minute"* | **ease — cuts volume** | `" flat"` → flat**tened** |
| *"the route was straining but fine"* | **pain — 3 days softened** | `" strain"` → strain**ing** |
| *"I tightened up my schedule"* | **pain — 3 days softened** | `" tight"` → tight**ened** |
| *"I skipped ahead to the next block"* | missed session | `" skip"` → skip**ped** |

One predicted collision did **not** occur: `" ache"` vs *achieve* differ at the fourth letter.
Noted because the hypothesis was rejected by the test rather than assumed.

**Severity: high, and higher than #1 in one respect.** These fire on correctly-spelled,
ordinary English with no typo and no unusual phrasing, and they *change the plan* — cutting
volume for someone reporting an improvement, or running the injury protocol on someone
describing a route. The "yesterday" case is the worst: after any refusal, an athlete
reporting what they did yesterday silently gets the refused action carried out. This is the
class of failure previously identified as the most damaging — silently doing the wrong
thing — and no structural check can see it, because the resulting state is perfectly
well-formed.

**Why nothing caught it:** every probe suite asserts on what a message *should* resolve to.
None sends ordinary sentences that happen to contain a keyword as a prefix. The census found
it only because one persona happened to have a pending refusal in the same day as a
"yesterday" message — 1 in 85.

---

## Root cause #3 — one copy slip in engine text (minor)

`plan-engine.js`, in the note attached when a **race falls inside an injury window**:

> "Sit this one out, or treat it as **a easy** run and ignore the clock."

It surfaces when the athlete asks *"what am I doing today"* on a day that is both a race and
injured — the coach quotes the session's opening lines. Four personas hit it. It is the only
real grammar artefact in 10,000 simulated days, and a useful check that the corrected harness
finds what it should: hand-written engine copy, not coach copy, and only in a rare
conjunction of two overrides.

## Census — what else it showed

Of 64 messages, four resolved to `unknown` in some or all sends. All four are explained by
the harness or by design, not by a defect — but two point at a UX gap:

- *"do it anyway"* (39/39 unknown) and *"no please add those sessions"* (30/30 unknown): the
  sim resets `pending` daily and sends these standalone, so nothing was pending. In the app,
  `pending` persists across days. **Harness limitation.**
- *"feeling better now"* (23 unknown / 9 recovered) and *"back to normal, all clear"*
  (20 / 8): by design, recovery requires an illness on record; the sim sends these out of
  context. But the fallback reply is *"I didn't follow that one. I'm good with things like…"*
  — cold for someone saying they feel better. **UX gap, minor:** a warm acknowledgement that
  nothing was blocking their plan would be better than the generic list.

Every other message resolved to a single, correct intent in 100% of sends.

## What did not break

Across 10,000 simulated days, with the above as the only failures:

- No crashes: `buildPlan`, `computeAdaptation`, `deriveFitness`, `goalAssessment`,
  `feasibilityReport`, `pruneCoachOverrides` never threw.
- `coachRespond` never threw, never returned an empty reply, never emitted `undefined`,
  `NaN`, `null` or `[object Object]` into copy.
- No `NaN`/`Infinity` in fitness scores, paces, session or long-run minutes, volume factors.
- Every non-rest day had a label, positive duration, RPE 1–10, a gear array, content lines.
- No day both rest and scheduled; session length never exceeded the stated cap.
- `goalAssessment` always returned a valid verdict and finite numbers; `feasibilityReport`
  always returned well-formed issues.
- No collection exceeded its Firestore rules cap; no duplicate `extraSessions`.
- No Monday race left the previous Sunday unprotected (no Monday races arose in this seed —
  the invariant exists but was not exercised).

## Suggested fixes (not applied)

- **#1:** store `from` alongside `until` on every windowed override and test both ends in
  `applyCoachOverrides` and `sessionsScheduledForWeek`. Clearing `extraSession` alongside
  `session` closes the orphan but is a symptom fix alone.
- **#2:** make the exact fast-path token-bounded like the fuzzy path — match ` keyword ` /
  ` keyword.` / ` keyword,` or, better, route all matching through `fuzzyHas`, which already
  compares whole tokens. Then add a probe of ordinary sentences containing keywords as
  prefixes, so this class can't come back.
- **#3:** "an easy run". One word.
- Harness: persist `pending` across days to match the app.
