# 100-persona × 100-day simulation — findings

**Not yet fixed.** This is the collected result of `simulate.html`.

## Method

100 generated personas, each simulated across 100 days: 10,000 simulated days.

Personas vary across every input dimension — goal type and event, fitness level, 5K time
present or absent, injury focus, 2–6 sessions a week, 30–90 min sessions, 0–3 commitments,
deadlines from 3 to 52 weeks — crossed with 10 behavioural archetypes (consistent, erratic,
injury-prone, over-eager, traveller, tinkerer, silent, messy-typer, comeback, racer). Each
archetype has its own adherence, chattiness, and rates of illness, injury, travel and racing.

Each day a persona may train or not, may hit a test week, and may send coach messages drawn
from a pool of ~60 realistic phrasings including deliberate typos. Coach actions are applied
exactly as `app.js` applies them. After every day, 20 invariants are checked.

Plan start dates are staggered (0, 7, 21, 45, 80, 120 days ago) so different phases of a
plan are exercised. **Constraint worth knowing:** `computeAdaptation` and `deriveFitness`
read the real system clock internally, so simulated time cannot be moved forward. Staggering
the start date is the workaround; it means adaptation is always evaluated as of the real
today rather than the simulated day.

## Result

**260 invariant violations, in 2 distinct kinds — both tracing to one root cause.**

| Kind | Count | Personas | Archetypes |
|---|---|---|---|
| `extraSession` without a main session | 177 | 9, 13, 48, 67, 85 | racer, over-eager, comeback, messy-typer, tinkerer |
| adherence out of range (>1) | 83 | 33, 58, 93 | over-eager, comeback |

## Root cause

**Windowed coach overrides have an upper bound but no lower bound, so they apply
retroactively to the entire plan history.**

Every windowed override is applied with a test of the form:

```js
if (d.date > until || !d.session) continue;
```

That skips days *after* the window ends and does nothing about days *before* it began. A
plan spans weeks of history, so an override created today reaches back across all of it.
Races are the exception and are correctly scoped, because they match an exact `dateKey`
rather than a range.

### Four manifestations, three confirmed by direct reproduction

**1. Systemic illness deletes the whole training history from the plan** — and leaves the
coach-added session behind, which is the 177 orphan errors. Declaring a fever today clears
`d.session` on every past day in the plan; `d.extraSession` is not cleared alongside it.

Reproduced: illness window of 6 days produced orphaned sessions on 11 separate dates
spanning 2026-06-24 to 2026-09-02.

**2. The same unbounded test in `sessionsScheduledForWeek` skews adherence above 100%** —
the 83 errors. Illness days are subtracted from the scheduled count with the same
`d <= illUntil` test, so every past week's denominator collapses while its logged sessions
remain.

Reproduced precisely: a week **two months before** the illness went from 5 scheduled
sessions to 0. Adherence moved from a correct 0.67 to 1.0, and observed values reached 1.17.

**3. `softenUntil` (injury) rewrites past sessions as low-impact** — 29 past sessions
rewritten in reproduction, earliest 2026-06-22.

**4. `effortOnly` (treadmill, trails, heat) rewrites past sessions** — 24 past sessions
rewritten, earliest 2026-06-22.

Manifestations 3 and 4 produced **no invariant violations at all**. Rewriting a past session
leaves it structurally valid, so nothing detected it. They are silently wrong.

### Why no existing test caught this

Every test to date builds a plan starting today or a few weeks back and asserts on the
current or next week. None asserts that a change made today leaves *earlier* weeks
untouched. The simulation found it because personas had plans running up to 120 days before
"today", and because it checked every week rather than the one in focus.

### Severity

User-visible and significant, but **not data loss**. Logs and test results are untouched;
what is wrong is the derived plan view and the adaptation maths computed from it. An athlete
who reports illness would see past weeks empty out in the Week tab, adherence read above
100%, and their fitness estimate shift. Clearing the override reverses all of it.

## What did not break

Across 10,000 simulated days, with the above as the only failures:

- No crashes. `buildPlan`, `computeAdaptation`, `deriveFitness`, `goalAssessment`,
  `feasibilityReport` and `pruneCoachOverrides` never threw.
- `coachRespond` never threw, never returned an empty reply, and never emitted `undefined`,
  `NaN` or `[object Object]` into user-facing copy.
- No `NaN` or `Infinity` in fitness scores, paces, session minutes or volume factors.
- No malformed sessions: every non-rest day had a label, positive duration, an RPE in 1–10,
  a gear array and non-empty content.
- No day was both rest and scheduled.
- Session length never exceeded the athlete's stated cap.
- No collection exceeded its Firestore rules cap (`logs`, `tests`, `chat`, `coachHistory`,
  `changeLog`, `scheduleHistory`, `extraSessions`, `blockedDates`, `races`, `swaps`).
- No duplicate `extraSessions` weekday.

## Suggested fix (not applied)

Give each windowed override a start date at creation — `from` alongside `until` — and test
the range at both ends in `applyCoachOverrides` and `sessionsScheduledForWeek`. Clearing
`d.extraSession` wherever `d.session` is cleared closes the orphan case, but is a symptom
fix on its own: the retroactive scope is the actual defect.
