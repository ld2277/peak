// Peak — plan generation, physiology math, and adaptation.
// Pure logic: no DOM, no Firebase. Everything here is deterministic, so the
// same profile + same logs always produces the same plan.

import {
  WARMUPS, COOLDOWNS, strengthBlock, conditioningBlock, prehabBlock,
  MOBILITY_FLOW, INJURY_FOCUS_LABELS,
} from "./workouts.js?v=15";

export { INJURY_FOCUS_LABELS };

// ---------------------------------------------------------------- form options

export const WORKOUT_FREQ = {
  none: { label: "Not lifting right now", level: 0 },
  low: { label: "1–2 strength sessions a week", level: 1 },
  mid: { label: "3–4 strength sessions a week", level: 2 },
  high: { label: "5+ strength sessions a week", level: 3 },
};

export const CARDIO_FREQ = {
  none: { label: "No cardio right now", level: 0 },
  low: { label: "1–2 cardio sessions a week", level: 1 },
  mid: { label: "3–4 cardio sessions a week", level: 2 },
  high: { label: "5+ cardio sessions a week", level: 3 },
};

export const RUN_DURATION = {
  under10: { label: "Under 10 min", vdot: 28 },
  to20: { label: "10–20 min", vdot: 32 },
  to30: { label: "20–30 min", vdot: 36 },
  to45: { label: "30–45 min", vdot: 40 },
  to60: { label: "45–60 min", vdot: 44 },
  over60: { label: "60+ min", vdot: 47 },
};

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export const WEEKDAYS_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const COMMITMENT_LOADS = {
  none: { label: "Nothing scheduled" },
  light: { label: "Something light (walk, casual sport, yoga)" },
  hard: { label: "Something hard (team practice, a match, a class)" },
};

export const SESSION_COUNTS = [2, 3, 4, 5, 6];
export const SESSION_MINUTES = [30, 45, 60, 75, 90];

export const GOAL_TYPES = {
  endurance: { label: "Hit a running time or distance" },
  fitness: { label: "Get generally fitter and stronger" },
};

export const EVENTS = {
  fiveK: { label: "5K", meters: 5000, peakLongMin: 60 },
  tenK: { label: "10K", meters: 10000, peakLongMin: 80 },
  half: { label: "Half marathon", meters: 21097, peakLongMin: 115 },
  marathon: { label: "Marathon", meters: 42195, peakLongMin: 155 },
};

export const FITNESS_TARGETS = {
  allround: { label: "All-round conditioning" },
  strength: { label: "Mostly strength" },
  endurance: { label: "Mostly engine / stamina" },
};

// ---------------------------------------------------------------- dates

export function dateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function parseDateKey(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// 0 = Monday ... 6 = Sunday
export function weekdayIndex(d) {
  return (d.getDay() + 6) % 7;
}

export function mondayOnOrBefore(d) {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  out.setDate(out.getDate() - weekdayIndex(out));
  return out;
}

export function addDays(d, n) {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  out.setDate(out.getDate() + n);
  return out;
}

export function daysBetween(a, b) {
  return Math.round((b - a) / 86400000);
}

export function weekNumberFor(date, planStart) {
  return Math.floor(daysBetween(planStart, date) / 7) + 1;
}

// ---------------------------------------------------------------- formatting

export function formatDuration(seconds) {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function formatPace(secPerKm) {
  return `${formatDuration(secPerKm)}/km`;
}

export function paceToMile(secPerKm) {
  return formatDuration(secPerKm * 1.60934) + "/mi";
}

// Accepts "24:30", "24.5", "1:45:00"
export function parseTimeToSeconds(str) {
  if (!str) return null;
  const parts = String(str).trim().split(":").map((p) => p.trim());
  if (parts.some((p) => p === "" || isNaN(Number(p)))) return null;
  const nums = parts.map(Number);
  if (nums.length === 1) return Math.round(nums[0] * 60);
  if (nums.length === 2) return Math.round(nums[0] * 60 + nums[1]);
  if (nums.length === 3) return Math.round(nums[0] * 3600 + nums[1] * 60 + nums[2]);
  return null;
}

// ---------------------------------------------------------------- VDOT physiology
// Jack Daniels' running formula. Given a race result we can derive an aerobic
// fitness number, and from that number a full set of training paces.

function pctVo2max(tMin) {
  return 0.8 + 0.1894393 * Math.exp(-0.012778 * tMin) + 0.2989558 * Math.exp(-0.1932605 * tMin);
}

function vo2FromVelocity(v) {
  return -4.6 + 0.182258 * v + 0.000104 * v * v;
}

function velocityFromVo2(vo2) {
  const a = 0.000104, b = 0.182258, c = -4.6 - vo2;
  return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
}

export function vdotFromRace(seconds, meters) {
  const tMin = seconds / 60;
  if (tMin <= 0) return null;
  return vo2FromVelocity(meters / tMin) / pctVo2max(tMin);
}

export function predictRaceSeconds(vdot, meters) {
  let lo = 1, hi = 600;
  for (let i = 0; i < 90; i++) {
    const mid = (lo + hi) / 2;
    const est = vo2FromVelocity(meters / mid) / pctVo2max(mid);
    if (est > vdot) lo = mid; else hi = mid;
  }
  return ((lo + hi) / 2) * 60;
}

const INTENSITY = {
  easy: 0.70,
  steady: 0.79,
  marathon: 0.84,
  threshold: 0.88,
  interval: 0.975,
  repetition: 1.05,
};

export function pacesFor(vdot) {
  const out = {};
  for (const [k, pct] of Object.entries(INTENSITY)) {
    out[k] = (1000 / velocityFromVo2(pct * vdot)) * 60;
  }
  return out;
}

// ---------------------------------------------------------------- fitness assessment

export function baselineVdot(profile) {
  if (profile.fiveKSeconds) {
    const v = vdotFromRace(profile.fiveKSeconds, 5000);
    if (v && isFinite(v)) return Math.max(20, Math.min(75, v));
  }
  let v = RUN_DURATION[profile.runDuration]?.vdot ?? 32;
  const cardio = CARDIO_FREQ[profile.cardioPerWeek]?.level ?? 0;
  v += [-3, -1, 1, 2][cardio];
  return Math.max(20, Math.min(75, v));
}

export function tierFor(profile, goalType) {
  if (goalType === "fitness") {
    const w = WORKOUT_FREQ[profile.workoutsPerWeek]?.level ?? 0;
    const c = CARDIO_FREQ[profile.cardioPerWeek]?.level ?? 0;
    const combined = w + c;
    if (combined <= 1) return "beginner";
    if (combined <= 4) return "intermediate";
    return "advanced";
  }
  const v = baselineVdot(profile);
  const cardio = CARDIO_FREQ[profile.cardioPerWeek]?.level ?? 0;
  if (cardio === 0 || v < 34) return "beginner";
  if (v < 45) return "intermediate";
  return "advanced";
}

// Ambitious by design: start close to your stated capacity rather than easing
// in, and reach full volume early so most of the plan is spent doing real work.
// The one guard that stays is RAMP_GUARD_WEEKS below — a genuine beginner with
// no current cardio still gets two weeks of tissue adaptation before the ramp,
// because bone and tendon adapt slower than the cardiovascular system and this
// is exactly where running injuries come from.
const START_FRACTION = { beginner: 0.7, intermediate: 0.82, advanced: 0.9 };
const RAMP_GUARD_WEEKS = 2;
const RAMP_GUARD_FACTOR = 0.82;

// ---------------------------------------------------------------- day scheduling

function circDist(a, b) {
  const raw = Math.abs(a - b);
  return Math.min(raw, 7 - raw);
}

function minPairwise(days) {
  let min = 7;
  for (let i = 0; i < days.length; i++)
    for (let j = i + 1; j < days.length; j++)
      min = Math.min(min, circDist(days[i], days[j]));
  return min;
}

// Spread n sessions across the available weekdays as evenly as possible.
function chooseDays(available, n) {
  if (n >= available.length) return [...available].sort((a, b) => a - b);
  let best = null, bestScore = -1;
  for (const start of available) {
    const chosen = [start];
    while (chosen.length < n) {
      let cand = null, candScore = -1;
      for (const d of available) {
        if (chosen.includes(d)) continue;
        const score = Math.min(...chosen.map((c) => circDist(c, d)));
        if (score > candScore) { candScore = score; cand = d; }
      }
      chosen.push(cand);
    }
    const score = minPairwise(chosen);
    if (score > bestScore) { bestScore = score; best = chosen; }
  }
  return best.sort((a, b) => a - b);
}

// Two quality sessions a week from Build onward, and at least one genuinely
// easy day whenever there is room for it. More than two hard running days a
// week does not produce more fitness — it produces interrupted training.
function enduranceTemplate(n, phase) {
  if (phase === "Base") {
    const t = {
      2: ["strides", "long"],
      3: ["strides", "easy", "long"],
      4: ["intervals", "easy", "strength", "long"],
      5: ["intervals", "easy", "strength", "strides", "long"],
      6: ["intervals", "easy", "strength", "strides", "easy", "long"],
    };
    return [...(t[n] || t[3])];
  }
  const t = {
    2: ["intervals", "long"],
    3: ["intervals", "easy", "long"],
    4: ["intervals", "tempo", "strength", "long"],
    5: ["intervals", "easy", "tempo", "strength", "long"],
    6: ["intervals", "easy", "tempo", "strength", "easy", "long"],
  };
  return [...(t[n] || t[3])];
}

function fitnessTemplate(n, target) {
  const table = {
    2: ["full", "conditioning"],
    3: ["lower", "conditioning", "upper"],
    4: ["lower", "conditioning", "upper", "cardio"],
    5: ["lower", "conditioning", "upper", "cardio", "full"],
    6: ["lower", "conditioning", "upper", "cardio", "full", "mobility"],
  };
  let types = [...(table[n] || table[3])];
  if (target === "endurance") {
    types = types.map((t) => (t === "full" ? "cardio" : t));
    if (!types.includes("cardio")) types[types.length - 1] = "cardio";
  } else if (target === "strength") {
    types = types.map((t) => (t === "cardio" ? "full" : t));
  }
  return types;
}

const HARD_TYPES = new Set(["intervals", "tempo", "conditioning", "test"]);

// Place session types onto chosen weekdays: long run on a weekend day where
// possible, hard sessions as far apart as we can get them.
function assignTypes(days, types) {
  const slots = days.map((d) => ({ day: d, type: null }));
  const remaining = [...types];

  const takeType = (t) => {
    const i = remaining.indexOf(t);
    if (i === -1) return null;
    return remaining.splice(i, 1)[0];
  };

  // Long run: prefer Saturday (5), then Sunday (6), then the latest day.
  if (remaining.includes("long")) {
    let target = slots.find((s) => s.day === 5) || slots.find((s) => s.day === 6) || slots[slots.length - 1];
    target.type = takeType("long");
  }

  // Hard sessions next, greedily maximising distance from already-hard days.
  const hardFirst = remaining.filter((t) => HARD_TYPES.has(t));
  for (const t of hardFirst) {
    const used = slots.filter((s) => s.type && (HARD_TYPES.has(s.type) || s.type === "long")).map((s) => s.day);
    let best = null, bestScore = -1;
    for (const s of slots) {
      if (s.type) continue;
      const score = used.length ? Math.min(...used.map((u) => circDist(u, s.day))) : 7;
      if (score > bestScore) { bestScore = score; best = s; }
    }
    if (best) best.type = takeType(t);
  }

  // Everything else fills the gaps in order.
  for (const s of slots) {
    if (!s.type && remaining.length) s.type = remaining.shift();
  }
  return slots.filter((s) => s.type);
}

// ---------------------------------------------------------------- session content

const TYPE_LABELS = {
  easy: "Easy Run",
  strides: "Easy Run + Strides",
  intervals: "Interval Session",
  tempo: "Tempo Run",
  long: "Long Run",
  strength: "Strength",
  lower: "Lower Body Strength",
  upper: "Upper Body Strength",
  full: "Full Body Strength",
  conditioning: "Conditioning",
  cardio: "Steady Cardio",
  mobility: "Mobility & Recovery",
  test: "Test Session",
  rest: "Rest",
};

// Polarised intensity. Quality days are pushed hard; easy days are deliberately
// held down, because that is what makes the hard days repeatable. Running every
// day at RPE 6 is the least productive way to train.
const TARGET_RPE = {
  easy: 4, strides: 4, long: 5, longFast: 6, tempo: 8, intervals: 9,
  strength: 8, lower: 8, upper: 8, full: 8,
  conditioning: 9, cardio: 5, mobility: 2, test: 10,
};

function intervalPrescription(phase, tier, weekInPhase, minutes) {
  const budget = Math.max(12, minutes - 20); // minutes left after warm-up/cool-down
  if (phase === "Base") {
    const reps = Math.min(10, 6 + weekInPhase);
    return { text: `${reps} x 1 min @ RPE 8, 75 sec easy jog between`, extra: "Finisher: 4 x 20 sec flat out, 60 sec walk between" };
  }
  if (phase === "Build") {
    const reps = Math.max(5, Math.min(7, Math.floor(budget / 4.5)));
    return { text: `${reps} x 3 min @ RPE 9, 2 min easy jog between`, extra: "Finisher: 4 x 30 sec at repetition pace, 90 sec walk between" };
  }
  const reps = Math.max(4, Math.min(6, Math.floor(budget / 6)));
  return { text: `${reps} x 4 min @ RPE 9, 2 min easy jog between`, extra: "Finisher: 6 x 30 sec at repetition pace, 60 sec walk between" };
}

function tempoPrescription(phase, minutes) {
  const budget = Math.max(10, minutes - 20);
  if (phase === "Base") return `${Math.min(20, budget)} min continuous @ RPE 7`;
  if (phase === "Build") return `2 x ${Math.min(15, Math.floor(budget / 2))} min @ RPE 8, 2 min easy between`;
  return `${Math.min(35, budget)} min continuous @ RPE 8`;
}

function buildSession({ type, minutes, tier, phase, weekNum, weekInPhase, paces, vdot, injuryFocus, goal, longMinutes }) {
  const gear = new Set(["timer"]);
  const lines = [];
  let label = TYPE_LABELS[type] || type;
  let mins = minutes;

  const paceNote = (key) =>
    paces ? ` (about ${formatPace(paces[key])} — ${paceToMile(paces[key])})` : "";

  if (type === "easy" || type === "strides" || type === "long" || type === "cardio") {
    gear.add("shoes").add("space");
    const isLong = type === "long";
    if (isLong) mins = longMinutes;
    lines.push(`Warm-up: ${WARMUPS.runShort.join(" · ")}`);
    if (type === "cardio") {
      lines.push(`Main: ${mins - 10} min steady @ RPE 5 — run, bike, row, swim, or a brisk hill walk`);
    } else if (isLong) {
      // From Build onward the long run carries quality in its final stretch —
      // running the last portion tired and fast is the most specific work there is.
      const fastFinish = (phase === "Build" || phase === "Peak") ? Math.min(15, Math.round(mins * 0.25)) : 0;
      if (fastFinish) {
        lines.push(`Main: ${mins - 10 - fastFinish} min continuous @ RPE 4–5${paceNote("easy")}`);
        lines.push(`Fast finish: final ${fastFinish} min @ RPE 7–8${paceNote("threshold")} — this is the session, not a bonus`);
      } else {
        lines.push(`Main: ${mins - 10} min continuous @ RPE 4–5${paceNote("easy")}`);
        lines.push("Finish feeling like you could have gone another 10 min. If you can't, go slower next time.");
      }
    } else {
      lines.push(`Main: ${mins - 12} min continuous @ RPE 4${paceNote("easy")}`);
      lines.push("Hold this genuinely easy. Easy days being easy is what lets the hard days be hard — creeping up to RPE 6 here costs you the interval session.");
    }
    if (type === "strides" || type === "easy") {
      lines.push("Strides: 6 x 20 sec relaxed and fast, walking back to full recovery between");
    }
    lines.push(`Cool-down: ${COOLDOWNS.run.join(" · ")}`);
  }

  else if (type === "intervals") {
    gear.add("shoes").add("space");
    const presc = intervalPrescription(phase, tier, weekInPhase, mins);
    lines.push(`Warm-up: ${WARMUPS.run.join(" · ")}`);
    lines.push(`Main set: ${presc.text}${paceNote("interval")}`);
    if (presc.extra) lines.push(presc.extra + paceNote("repetition"));
    lines.push("Hold the same pace on the last rep as the first. Cut a rep before you let the pace fall apart — a faded rep trains nothing.");
    lines.push(`Cool-down: ${COOLDOWNS.run.join(" · ")}`);
  }

  else if (type === "tempo") {
    gear.add("shoes").add("space");
    lines.push(`Warm-up: ${WARMUPS.run.join(" · ")}`);
    lines.push(`Main set: ${tempoPrescription(phase, mins)}${paceNote("threshold")}`);
    lines.push("Threshold effort — right at the edge of sustainable. You should want it to stop and be able to keep going anyway.");
    lines.push(`Cool-down: ${COOLDOWNS.run.join(" · ")}`);
  }

  else if (type === "strength" || type === "lower" || type === "upper" || type === "full") {
    const focus = type === "strength" ? "full" : type;
    const block = strengthBlock({ focus, tier, minutes: mins, seed: weekNum });
    block.gear.forEach((g) => gear.add(g));
    lines.push(`Warm-up: ${WARMUPS.strength.join(" · ")}`);
    lines.push(...block.lines);
    lines.push(`Cool-down: ${COOLDOWNS.strength.join(" · ")}`);
  }

  else if (type === "conditioning") {
    const block = conditioningBlock({ tier, minutes: mins, seed: weekNum });
    block.gear.forEach((g) => gear.add(g));
    label = `Conditioning — ${block.title}`;
    lines.push(`Warm-up: ${WARMUPS.strength.join(" · ")}`);
    lines.push(...block.lines);
    lines.push(`Cool-down: ${COOLDOWNS.strength.join(" · ")}`);
  }

  else if (type === "mobility") {
    gear.add("mat");
    lines.push("Move through the flow twice, breathing slowly. Nothing here should hurt.");
    lines.push(...MOBILITY_FLOW);
  }

  else if (type === "test") {
    gear.add("shoes").add("route").add("space");
    if (goal.type === "endurance") {
      // Always test at 5K or shorter. A 5K predicts every other distance well
      // through VDOT, and it costs far less recovery than time-trialling the
      // full goal distance mid-plan.
      const ev = EVENTS[goal.event];
      const testMeters = Math.min(ev.meters, 5000);
      label = `Test: ${testMeters / 1000}K time trial`;
      // Size the session to the real effort: warm-up + the run + cool-down.
      const est = vdot ? predictRaceSeconds(vdot, testMeters) / 60 : 30;
      mins = Math.round((15 + est + 8) / 5) * 5;
      lines.push(`Warm-up: ${WARMUPS.test.join(" · ")}`);
      lines.push(`Main: run ${testMeters / 1000} km as fast as you can hold, evenly paced. Start conservatively — the first km should feel controlled.`);
      if (ev.meters > testMeters) {
        lines.push(`You're training for ${ev.label}, but the test is 5K on purpose — it predicts your ${ev.label} time without the recovery cost of racing the full distance.`);
      }
      lines.push("Record your time in the app afterwards. Your paces and the rest of the plan recalculate from this number.");
      lines.push(`Cool-down: ${COOLDOWNS.run.join(" · ")}`);
    } else {
      label = "Test: benchmark circuit";
      mins = Math.max(40, mins);
      lines.push(`Warm-up: ${WARMUPS.strength.join(" · ")}`);
      lines.push("Max push-ups in 2 min — stop when form breaks, not when it burns");
      lines.push("Max bodyweight squats in 2 min");
      lines.push("Max plank hold, one attempt");
      lines.push("1 mile (1.6 km) time trial, as fast as you can hold");
      lines.push("Record all four in the app. The plan recalculates from these numbers.");
      lines.push(`Cool-down: ${COOLDOWNS.run.join(" · ")}`);
    }
  }

  // Prehab rides along on the lightest sessions so it actually gets done.
  if (type === "mobility" || type === "easy" || type === "strides") {
    const pre = prehabBlock(injuryFocus);
    if (pre.lines.length) {
      lines.push(...pre.lines);
      pre.gear.forEach((g) => gear.add(g));
    }
  }

  let rpeKey = type;
  if (type === "long" && (phase === "Build" || phase === "Peak")) rpeKey = "longFast";
  return { type, label, minutes: mins, lines, gear: [...gear], targetRpe: TARGET_RPE[rpeKey] ?? 5 };
}

// ---------------------------------------------------------------- plan builder

// ---------------------------------------------------------------- coach overrides
// Changes the coach has made in conversation. Applied after a week is
// generated, so the underlying plan stays intact and every override is
// reversible by clearing it — nothing is baked into the schedule itself.

const RUN_TYPES = new Set(["easy", "strides", "intervals", "tempo", "long", "test"]);

function applyCoachOverrides(dayEntries, user) {
  const co = user.coachOverrides || {};
  const byKey = Object.fromEntries(dayEntries.map((d) => [d.dateKey, d]));

  // 1. Moves first, so a session is rescued off a day before that day is blocked.
  for (const [from, to] of Object.entries(co.moves || {})) {
    const src = byKey[from];
    const dst = byKey[to];
    if (!src || !dst || !src.session) continue;
    if (dst.session) continue; // never stack two sessions on one day
    // A session that has already been moved into this day must not be moved
    // again by a later rule — otherwise chained moves drag it two hops.
    if (src.movedFrom) continue;
    dst.session = src.session;
    dst.isRest = false;
    dst.movedFrom = from;
    src.session = null;
    src.isRest = true;
    src.movedTo = to;
  }

  // 2. Days the athlete told us they can't train.
  const blocked = new Set(co.blockedDates || []);
  for (const d of dayEntries) {
    if (!blocked.has(d.dateKey)) continue;
    d.session = null;
    d.isRest = true;
    d.blocked = true;
  }

  // 3. Impact removed while something hurts. Duration and effort are kept —
  //    the stimulus is preserved, only the loading through the legs changes.
  if (co.softenUntil) {
    const until = parseDateKey(co.softenUntil);
    for (const d of dayEntries) {
      if (!d.session || d.date > until) continue;
      const s = d.session;
      if (s.type === "test") {
        // A test must never be swapped to another modality. A bike time trial
        // cannot calibrate running paces, and a run done hurt gives a slow,
        // unrepresentative result — either way the number would then reset
        // every pace in the plan. Postponing is the only honest option.
        s.lines = [
          `⚕️ Coach note: don't time-trial on something that hurts. Postpone this test until it's settled — a result set while injured would recalibrate every pace in your plan off a number that isn't you, and cross-training can't substitute because it measures a different engine.`,
          ...s.lines,
        ];
        s.postponeAdvised = true;
        continue;
      }
      if (RUN_TYPES.has(s.type)) {
        s.label = `${s.label} — low impact`;
        s.lowImpact = true;
        s.lines = [
          `⚕️ Coach swap: do this on a bike, rower, elliptical, or in the pool — same duration, same effort, no running while this is sore.`,
          `Target: ${s.minutes} min at RPE ${s.targetRpe}.`,
          ...s.lines.filter((l) => !/^Main|^Fast finish|^Strides|^Main set/.test(l)),
        ];
      } else if (["strength", "lower", "full", "conditioning"].includes(s.type)) {
        s.lowImpact = true;
        s.lines = [
          `⚕️ Coach note: skip anything that loads the sore area, and drop jumping or landing work entirely today.`,
          ...s.lines,
        ];
      }
    }
  }

  return dayEntries;
}

function phaseFor(week, buildEnd, totalWeeks) {
  if (week > buildEnd) return "Taper";
  const p = week / buildEnd;
  if (p <= 0.4) return "Base";
  if (p <= 0.8) return "Build";
  return "Peak";
}

export function buildPlan(user, adaptation) {
  const adapt = adaptation || { volumeFactor: 1, sessionsAdjust: 0, vdot: null };
  const profile = user.profile;
  const sched = user.schedule;
  const goal = user.goal;

  const planStart = mondayOnOrBefore(parseDateKey(user.planStart));
  const deadline = parseDateKey(goal.deadline);
  const totalWeeks = Math.max(2, Math.ceil((daysBetween(planStart, deadline) + 1) / 7));

  const tier = tierFor(profile, goal.type);
  const vdot = goal.type === "endurance" ? (adapt.vdot || baselineVdot(profile)) : null;
  const paces = vdot ? pacesFor(vdot) : null;

  const taperWeeks = totalWeeks >= 12 ? 2 : totalWeeks >= 6 ? 1 : 0;
  const buildEnd = totalWeeks - taperWeeks;

  const warnings = [];
  const allGear = new Set();

  // Which weekdays are actually usable.
  const commitments = sched.commitments || {};
  const hardDays = [], lightDays = [];
  for (let i = 0; i < 7; i++) {
    const c = commitments[i];
    if (c && c.load === "hard") hardDays.push(i);
    else if (c && c.load === "light") lightDays.push(i);
  }
  const available = [];
  for (let i = 0; i < 7; i++) if (!hardDays.includes(i)) available.push(i);

  let sessionsPerWeek = Math.max(2, sched.sessionsPerWeek + adapt.sessionsAdjust);
  if (sessionsPerWeek > available.length) {
    warnings.push(
      `You asked for ${sched.sessionsPerWeek} sessions a week but only ${available.length} day${available.length === 1 ? " is" : "s are"} free of hard commitments. The plan schedules ${available.length} and leans on your commitment days for the rest of the load.`
    );
    sessionsPerWeek = available.length;
  }

  if (hardDays.length >= 2) {
    warnings.push(
      `You've got ${hardDays.length} hard commitment days (${hardDays.map((d) => WEEKDAYS_SHORT[d]).join(", ")}) on top of ${sessionsPerWeek} planned sessions — that's ${hardDays.length + sessionsPerWeek} hard-ish days a week. The plan schedules around them, but it can't see how tiring they are. If you're dragging, log your sessions honestly at a high RPE and the volume will come down on its own.`
    );
  }

  // Long-run ceiling check against the goal.
  const peakLongNeeded = goal.type === "endurance" ? EVENTS[goal.event].peakLongMin : 0;
  if (peakLongNeeded > sched.minutesPerSession) {
    warnings.push(
      `A ${EVENTS[goal.event].label} needs long runs of roughly ${peakLongNeeded} min by peak, but you set ${sched.minutesPerSession} min per session. Your long run day will grow past that cap — every other session stays inside it.`
    );
  }

  const startFrac = START_FRACTION[tier];
  const needsRampGuard = tier === "beginner" && (CARDIO_FREQ[profile.cardioPerWeek]?.level ?? 0) === 0;
  if (needsRampGuard) {
    warnings.push(
      `You're starting from no regular cardio, so the first ${RAMP_GUARD_WEEKS} weeks run at ${Math.round(RAMP_GUARD_FACTOR * 100)}% volume before the ramp begins. Your heart adapts in weeks; tendons and bone take months, and rushing this is the single most common way to lose a training block to injury.`
    );
  }
  const testWeeks = new Set([1]);
  for (let w = 4; w <= buildEnd; w += 4) testWeeks.add(w);

  const weeks = [];
  for (let w = 1; w <= totalWeeks; w++) {
    const phase = phaseFor(w, buildEnd, totalWeeks);
    const isDeload = phase !== "Taper" && w % 4 === 0;
    const isTest = testWeeks.has(w);
    const isTaper = phase === "Taper";

    // Volume ramp: start below the user's stated capacity, build toward it.
    const progress = buildEnd > 1 ? (w - 1) / (buildEnd - 1) : 1;
    // Reach full volume by ~70% of the build, not 85% — more of the plan is
    // spent at full load rather than ramping toward it.
    let factor = startFrac + (1 - startFrac) * Math.min(1, progress / 0.7);
    if (isDeload) factor *= 0.68;
    if (isTaper) factor *= w === totalWeeks ? 0.5 : 0.7;
    // Beginners with no current cardio get two weeks for tendons and bone to
    // catch up with the engine. This is the one place ambition is overruled.
    if (needsRampGuard && w <= RAMP_GUARD_WEEKS) factor *= RAMP_GUARD_FACTOR;
    factor *= adapt.volumeFactor;
    // A load change the athlete asked for in chat, from the week they asked.
    const co = user.coachOverrides || {};
    if (co.loadFactor && w >= (co.loadFactorFromWeek || 1)) factor *= co.loadFactor;
    factor = Math.max(0.4, Math.min(1.15, factor));

    // Never exceed the session length the athlete actually said they have.
    // Ambition is expressed through intensity, not by quietly stealing time.
    const sessionMinutes = Math.max(
      20,
      Math.min(sched.minutesPerSession, Math.round((sched.minutesPerSession * factor) / 5) * 5)
    );

    // Long run scales up separately, toward whatever the goal actually needs.
    const longCeiling = Math.max(sched.minutesPerSession, peakLongNeeded);
    const longMinutes = Math.max(
      Math.round((sessionMinutes * 1.2) / 5) * 5,
      Math.round((sched.minutesPerSession * factor * (1 + 0.6 * Math.min(1, progress / 0.85))) / 5) * 5
    );
    const cappedLong = Math.min(longMinutes, longCeiling);

    const weekInPhase = ((w - 1) % 4) + 1;
    const types = goal.type === "endurance"
      ? enduranceTemplate(sessionsPerWeek, phase)
      : fitnessTemplate(sessionsPerWeek, goal.fitnessTarget || "allround");

    if (isTest) {
      // The test replaces the week's hardest session.
      const idx = types.findIndex((t) => HARD_TYPES.has(t));
      if (idx >= 0) types[idx] = "test";
      else types[0] = "test";
    }

    const days = chooseDays(available, sessionsPerWeek);
    const assigned = assignTypes(days, types);

    const dayEntries = [];
    for (let i = 0; i < 7; i++) {
      const date = addDays(planStart, (w - 1) * 7 + i);
      const slot = assigned.find((s) => s.day === i);
      const commitment = commitments[i] && commitments[i].load !== "none" ? commitments[i] : null;
      const entry = {
        weekdayIndex: i,
        date,
        dateKey: dateKey(date),
        weekday: WEEKDAYS[i],
        commitment,
        isRest: !slot,
        session: null,
      };
      if (slot) {
        const s = buildSession({
          type: slot.type,
          minutes: sessionMinutes,
          tier,
          phase,
          weekNum: w,
          weekInPhase,
          paces,
          vdot,
          injuryFocus: profile.injuryFocus || [],
          goal,
          longMinutes: cappedLong,
        });
        s.gear.forEach((g) => allGear.add(g));
        entry.session = s;
      }
      dayEntries.push(entry);
    }

    applyCoachOverrides(dayEntries, user);

    weeks.push({
      num: w,
      phase,
      isDeload,
      isTest,
      isTaper,
      isGoalWeek: w === totalWeeks,
      startDate: addDays(planStart, (w - 1) * 7),
      endDate: addDays(planStart, (w - 1) * 7 + 6),
      sessionMinutes,
      longMinutes: cappedLong,
      days: dayEntries,
      focus: weekFocus({ phase, isDeload, isTest, isTaper, isGoalWeek: w === totalWeeks, goal }),
    });
  }

  return {
    planStart,
    deadline,
    totalWeeks,
    buildEnd,
    tier,
    vdot,
    paces,
    weeks,
    warnings,
    gear: [...allGear],
    testWeeks: [...testWeeks].sort((a, b) => a - b),
    sessionsPerWeek,
  };
}

function weekFocus({ phase, isDeload, isTest, isTaper, isGoalWeek, goal }) {
  if (isGoalWeek) return goal.type === "endurance" ? "Goal week — everything is sharpening for the target." : "Goal week — final benchmark test.";
  if (isTaper) return "Taper — volume drops, intensity stays. You should feel restless, not tired.";
  if (isTest && isDeload) return "Deload + test week — reduced load, then a hard measurement.";
  if (isTest) return "Test week — baseline measurement to calibrate the plan.";
  if (isDeload) return "Deload — cut back on purpose so the next block lands.";
  if (phase === "Base") return "Base — building the aerobic floor and movement quality.";
  if (phase === "Build") return "Build — adding intensity on top of the base.";
  return "Peak — the hardest, most specific work of the plan.";
}

// Blocked days and moves are only ever about a specific past or present week.
// Left unpruned they accumulate for the life of the plan, eventually hitting
// the size caps in the Firestore rules. Returns null when nothing changed.
export function pruneCoachOverrides(co, today = new Date()) {
  if (!co) return null;
  const cutoff = mondayOnOrBefore(today);
  const keep = (k) => parseDateKey(k) >= cutoff;

  const blockedDates = (co.blockedDates || []).filter(keep);
  const moves = Object.fromEntries(Object.entries(co.moves || {}).filter(([from, to]) => keep(from) && keep(to)));

  const changed =
    blockedDates.length !== (co.blockedDates || []).length ||
    Object.keys(moves).length !== Object.keys(co.moves || {}).length;

  if (!changed) return null;
  return { ...co, blockedDates, moves };
}

export function getWeek(plan, n) {
  return plan.weeks.find((w) => w.num === n) || null;
}

export function getDayForDate(plan, date) {
  const key = dateKey(date);
  for (const w of plan.weeks) {
    const d = w.days.find((d) => d.dateKey === key);
    if (d) return { week: w, day: d };
  }
  return null;
}

// ---------------------------------------------------------------- derived fitness
// The athlete's current fitness is never edited by hand. It is seeded from the
// onboarding answers, then moved by what actually gets trained, and reset
// outright whenever a test measures it for real. It is derived from logs and
// tests on every load, so it is self-healing: a stored value can never drift
// away from the training history that produced it.

const TRAINING_GAIN_PER_WEEK = { beginner: 0.35, intermediate: 0.2, advanced: 0.12 };
const DETRAIN_PER_WEEK = 0.3;
// How far an untested estimate is allowed to wander before we stop trusting it.
// Without this, a long stretch of good weeks would inflate the estimate
// indefinitely and start prescribing paces the athlete can't hold.
const MAX_UNTESTED_DRIFT = 4;

// Sessions per week in effect for a given week — schedules can change mid-plan,
// and adherence for past weeks must be judged against what was scheduled then.
export function sessionsScheduledForWeek(user, weekNum) {
  const hist = user.scheduleHistory;
  if (!Array.isArray(hist) || !hist.length) return user.schedule.sessionsPerWeek;
  let val = hist[0].sessionsPerWeek;
  for (const h of hist) if (h.fromWeek <= weekNum) val = h.sessionsPerWeek;
  return val;
}

export function deriveFitness(user) {
  const planStart = mondayOnOrBefore(parseDateKey(user.planStart));
  const currentWeek = weekNumberFor(new Date(), planStart);
  const logs = user.logs || {};
  const tests = user.tests || {};
  const tier = tierFor(user.profile, user.goal.type);
  const rate = TRAINING_GAIN_PER_WEEK[tier] ?? 0.2;

  let vdot = baselineVdot(user.profile);
  let anchor = "onboarding";
  let lastTestWeek = null;
  let driftSinceAnchor = 0;
  const timeline = [{ week: 0, vdot, source: "onboarding" }];

  // Walk every week up to and including the current one. A test is a
  // point-in-time measurement and counts the moment it is recorded — waiting
  // for the week to roll over would leave stale paces on screen for days.
  // Training drift, by contrast, only applies to weeks that have finished.
  for (let w = 1; w <= currentWeek; w++) {
    const t = tests[w];
    if (t && t.seconds && t.meters) {
      const v = vdotFromRace(t.seconds, t.meters);
      if (v && isFinite(v)) {
        vdot = Math.max(20, Math.min(75, v));
        anchor = "test";
        lastTestWeek = w;
        driftSinceAnchor = 0;
        timeline.push({ week: w, vdot, source: "test" });
        continue;
      }
    }

    if (w >= currentWeek) break; // the in-progress week hasn't earned drift yet

    const scheduled = sessionsScheduledForWeek(user, w);
    let done = 0;
    for (let i = 0; i < 7; i++) {
      if (logs[dateKey(addDays(planStart, (w - 1) * 7 + i))]?.done) done++;
    }
    const adherence = scheduled > 0 ? done / scheduled : 0;

    let delta;
    if (adherence >= 0.8) delta = rate;
    else if (adherence >= 0.5) delta = rate * 0.5;
    else if (adherence > 0) delta = -0.1;
    else delta = -DETRAIN_PER_WEEK;

    if (delta > 0) delta = Math.min(delta, Math.max(0, MAX_UNTESTED_DRIFT - driftSinceAnchor));
    driftSinceAnchor += delta;
    vdot = Math.max(20, Math.min(75, vdot + delta));
    timeline.push({ week: w, vdot, source: "training" });
  }

  const weeksSinceTest = lastTestWeek === null ? null : currentWeek - lastTestWeek;
  return {
    vdot,
    anchor,
    lastTestWeek,
    weeksSinceTest,
    driftSinceAnchor,
    // "measured" only while a real test is recent enough to still describe them.
    confidence: lastTestWeek !== null && weeksSinceTest <= 5 ? "measured" : "estimated",
    timeline,
  };
}

// ---------------------------------------------------------------- adaptation
// Runs silently. Every load recomputes it from the logs, so it is always
// consistent with what has actually been done.

export function computeAdaptation(user) {
  const logs = user.logs || {};
  const tests = user.tests || {};
  const planStart = mondayOnOrBefore(parseDateKey(user.planStart));
  const today = new Date();
  const currentWeek = weekNumberFor(today, planStart);
  const notes = [];
  let volumeFactor = 1;
  let sessionsAdjust = 0;

  // --- adherence and effort over the last three completed weeks
  const windowWeeks = [];
  for (let w = Math.max(1, currentWeek - 3); w < currentWeek; w++) windowWeeks.push(w);

  let completed = 0, expected = 0, rpeSum = 0, rpeCount = 0, targetSum = 0;
  const weeklyAdherence = [];
  for (const w of windowWeeks) {
    const scheduled = sessionsScheduledForWeek(user, w);
    let weekDone = 0;
    for (let i = 0; i < 7; i++) {
      const key = dateKey(addDays(planStart, (w - 1) * 7 + i));
      const log = logs[key];
      if (log && log.done) {
        weekDone++;
        if (typeof log.rpe === "number") {
          rpeSum += log.rpe;
          targetSum += typeof log.targetRpe === "number" ? log.targetRpe : 6;
          rpeCount++;
        }
      }
    }
    completed += weekDone;
    expected += scheduled;
    weeklyAdherence.push(scheduled > 0 ? weekDone / scheduled : 0);
  }

  const adherence = expected > 0 ? completed / expected : 1;
  const rpeDelta = rpeCount > 0 ? rpeSum / rpeCount - targetSum / rpeCount : 0;

  if (expected > 0) {
    if (adherence < 0.6) {
      volumeFactor *= 0.85;
      notes.push({
        week: currentWeek,
        text: `Hit ${completed} of ${expected} sessions over the last ${windowWeeks.length} week${windowWeeks.length === 1 ? "" : "s"} — volume trimmed 15% so the plan matches the week you actually have.`,
      });
    } else if (adherence >= 0.9 && rpeDelta < -0.5) {
      volumeFactor *= 1.05;
      notes.push({
        week: currentWeek,
        text: `Full attendance and sessions coming in easier than targeted — volume nudged up 5%.`,
      });
    }

    if (rpeDelta > 1.2) {
      volumeFactor *= 0.92;
      notes.push({
        week: currentWeek,
        text: `Sessions logging about ${rpeDelta.toFixed(1)} RPE above target — load eased 8% to let you absorb the work.`,
      });
    }

    // Two consecutive very poor weeks: drop a session rather than shrinking everything.
    const lastTwo = weeklyAdherence.slice(-2);
    const nowScheduled = user.schedule.sessionsPerWeek;
    if (lastTwo.length === 2 && lastTwo.every((a) => a < 0.5) && nowScheduled > 2) {
      sessionsAdjust = -1;
      notes.push({
        week: currentWeek,
        text: `Two weeks under half your sessions — dropped to ${nowScheduled - 1} a week. Consistency at a lower number beats a plan you keep missing.`,
      });
    }
  }

  volumeFactor = Math.max(0.6, Math.min(1.15, volumeFactor));

  // --- fitness is derived from the whole training history, not just tests
  const fitness = deriveFitness(user);
  const vdot = fitness.vdot;
  const testWeekNums = Object.keys(tests).map(Number).sort((a, b) => a - b);
  const latestTestWeek = testWeekNums[testWeekNums.length - 1];
  if (latestTestWeek != null) {
    const t = tests[latestTestWeek];
    if (t && t.type === "run" && t.seconds && t.meters) {
      const v = vdotFromRace(t.seconds, t.meters);
      if (v && isFinite(v)) {
        const prev = testWeekNums.length > 1 ? tests[testWeekNums[testWeekNums.length - 2]] : null;
        if (prev && prev.seconds && prev.meters === t.meters) {
          const delta = prev.seconds - t.seconds;
          notes.push({
            week: latestTestWeek,
            text: delta > 0
              ? `Week ${latestTestWeek} test: ${formatDuration(delta)} faster than last time. Training paces reset to the new fitness.`
              : `Week ${latestTestWeek} test: ${formatDuration(-delta)} slower than last time. Paces held rather than pushed — this is usually fatigue, not lost fitness.`,
          });
        } else {
          notes.push({ week: latestTestWeek, text: `Baseline test recorded — all training paces now come from this result.` });
        }
      }
    }
  }

  if (fitness.anchor === "training" || (fitness.anchor === "onboarding" && Math.abs(fitness.driftSinceAnchor) >= 1)) {
    notes.push({
      week: currentWeek,
      text: `Fitness estimate now ${fitness.vdot.toFixed(1)}, moved by your logged training since ${fitness.lastTestWeek ? `the week ${fitness.lastTestWeek} test` : "you started"}. A test week will replace this estimate with a measured number.`,
    });
  }

  return { volumeFactor, sessionsAdjust, vdot, fitness, adherence, rpeDelta, notes, currentWeek };
}

// ---------------------------------------------------------------- goal assessment

const VDOT_GAIN_PER_WEEK = { beginner: 0.45, intermediate: 0.28, advanced: 0.16 };
const VDOT_GAIN_CAP = { beginner: 12, intermediate: 8, advanced: 5 };

// How much aerobic fitness a given athlete can plausibly gain in N weeks of
// consistent training. Beginners improve fastest and have the most headroom;
// trained runners are already near their ceiling.
export function achievableVdotGain(tier, weeks) {
  return Math.min(VDOT_GAIN_CAP[tier] ?? 8, Math.max(0, weeks) * (VDOT_GAIN_PER_WEEK[tier] ?? 0.28));
}

const RUN_DURATION_ORDER = ["under10", "to20", "to30", "to45", "to60", "over60"];

// What each distance genuinely requires before it is a sane target.
export const EVENT_REQUIREMENTS = {
  fiveK: { minWeeks: 4, minRunLevel: 0, minSessions: 2 },
  tenK: { minWeeks: 6, minRunLevel: 1, minSessions: 3 },
  half: { minWeeks: 10, minRunLevel: 2, minSessions: 3 },
  marathon: { minWeeks: 16, minRunLevel: 3, minSessions: 4 },
};

// Checks the goal against the calendar, the starting point, and the schedule,
// BEFORE any plan is built — so an impossible target can be caught while it can
// still be changed. Severity: "blocker" means no honest plan reaches it.
export function feasibilityReport(user) {
  const issues = [];
  const { goal, profile, schedule: sched } = user;
  const planStart = mondayOnOrBefore(parseDateKey(user.planStart || dateKey(new Date())));
  const deadline = parseDateKey(goal.deadline);
  const weeks = Math.max(1, Math.ceil((daysBetween(planStart, deadline) + 1) / 7));
  const tier = tierFor(profile, goal.type);

  const add = (severity, title, detail, fix) => issues.push({ severity, title, detail, fix });

  if (goal.type === "endurance") {
    const ev = EVENTS[goal.event];
    const req = EVENT_REQUIREMENTS[goal.event];

    // 1. Is there enough calendar for the distance at all?
    if (weeks < req.minWeeks) {
      add("blocker",
        `${weeks} weeks is not enough to prepare for a ${ev.label}`,
        `A ${ev.label} needs at least ${req.minWeeks} weeks of structured build-up for the long run to grow safely. Racing one off ${weeks} weeks is how people end up injured at the start line rather than finishing.`,
        `Move the deadline out to at least ${dateKey(addDays(planStart, req.minWeeks * 7))}, or pick a shorter distance for this cycle.`);
    }

    // 2. Is the starting point anywhere near the distance?
    const runLevel = RUN_DURATION_ORDER.indexOf(profile.runDuration);
    const gap = req.minRunLevel - (runLevel < 0 ? 0 : runLevel);
    if (gap >= 2) {
      add("blocker",
        `A ${ev.label} is a long way from where you're starting`,
        `You can currently run ${RUN_DURATION[profile.runDuration]?.label.toLowerCase()} continuously. A ${ev.label} asks for a great deal more than that, and closing a gap this size safely takes longer than a single training block.`,
        `Target a ${EVENTS[goal.event === "marathon" ? "half" : "tenK"].label} for this cycle and come back to the ${ev.label} after it.`);
    } else if (gap === 1) {
      add("warning",
        `You're starting below the usual base for a ${ev.label}`,
        `Most people going into a ${ev.label} block can already run longer than ${RUN_DURATION[profile.runDuration]?.label.toLowerCase()} continuously. It's doable, but expect the long runs to be the hardest part of this plan by a distance.`,
        `Protect the long run above every other session — if something has to be missed in a week, miss anything but that.`);
    }

    // 3. Enough sessions a week to support it?
    if (sched.sessionsPerWeek < req.minSessions) {
      add("warning",
        `${sched.sessionsPerWeek} sessions a week is thin for a ${ev.label}`,
        `A ${ev.label} normally needs ${req.minSessions}+ sessions a week to build the aerobic base and still fit in quality work. At ${sched.sessionsPerWeek}, nearly every session has to count and there's no room for a missed week.`,
        `Add a session if you can find one, even a short easy run.`);
    }

    // 4. Is the target TIME reachable in the weeks available?
    if (goal.targetSeconds) {
      const currentVdot = baselineVdot(profile);
      const neededVdot = vdotFromRace(goal.targetSeconds, ev.meters);
      const gainNeeded = neededVdot - currentVdot;
      const gainPossible = achievableVdotGain(tier, weeks);
      const currentPredicted = predictRaceSeconds(currentVdot, ev.meters);
      const fair = predictRaceSeconds(currentVdot + gainPossible, ev.meters);

      if (gainNeeded > gainPossible * 1.6) {
        add("blocker",
          `${formatDuration(goal.targetSeconds)} is beyond what ${weeks} weeks can deliver`,
          `Your current fitness predicts about ${formatDuration(currentPredicted)} for a ${ev.label}. Reaching ${formatDuration(goal.targetSeconds)} would need roughly ${gainNeeded.toFixed(1)} points of aerobic improvement; ${weeks} weeks of consistent training realistically buys about ${gainPossible.toFixed(1)}. No honest plan closes that gap in the time available.`,
          `A hard but reachable target from here is ${formatDuration(fair)}. Set that, or push the deadline out.`);
      } else if (gainNeeded > gainPossible * 1.15) {
        add("warning",
          `${formatDuration(goal.targetSeconds)} is at the very edge of possible`,
          `You'd need almost every week to go perfectly — no missed blocks, no illness, no setbacks. It's the kind of target that works out maybe one time in four.`,
          `${formatDuration(fair)} is the confident version of this goal. Keep your target if you want the stretch, but know what it's asking.`);
      }
    }

    // 5. Does the long run fit the stated session length?
    if (ev.peakLongMin > sched.minutesPerSession) {
      add("note",
        `Your long run will outgrow your session limit`,
        `A ${ev.label} needs long runs of roughly ${ev.peakLongMin} min by peak, against the ${sched.minutesPerSession} min you set. The long run day will run past that; every other session stays inside it.`,
        `Make sure one day a week can stretch to about ${ev.peakLongMin} min.`);
    }
  }

  // 6. Volume ramp risk — applies to both goal types.
  const cardioLevel = CARDIO_FREQ[profile.cardioPerWeek]?.level ?? 0;
  if (cardioLevel === 0 && sched.sessionsPerWeek >= 5) {
    add("warning",
      `Going from no cardio to ${sched.sessionsPerWeek} sessions a week is a steep jump`,
      `This is the classic pattern behind early-block injuries — the engine copes long before the tendons do. The plan holds the first two weeks back, but the risk is real.`,
      `Consider starting at 3–4 sessions and adding more once a few weeks are behind you.`);
  }

  return issues;
}

export function goalAssessment(user, plan, adaptation) {
  const goal = user.goal;
  if (goal.type !== "endurance" || !goal.targetSeconds) return null;

  const ev = EVENTS[goal.event];
  const currentVdot = plan.vdot;
  const currentPredicted = predictRaceSeconds(currentVdot, ev.meters);
  const neededVdot = vdotFromRace(goal.targetSeconds, ev.meters);

  const weeksLeft = Math.max(0, plan.totalWeeks - (adaptation.currentWeek - 1));
  const plausibleGain = achievableVdotGain(plan.tier, weeksLeft);
  const projectedVdot = currentVdot + plausibleGain;
  const projectedSeconds = predictRaceSeconds(projectedVdot, ev.meters);

  const gapVdot = neededVdot - currentVdot;
  let verdict, detail;
  if (gapVdot <= 0) {
    verdict = "ahead";
    detail = "Your current fitness already predicts this time. The plan will build margin.";
  } else if (gapVdot <= plausibleGain * 0.75) {
    verdict = "onTrack";
    detail = "Comfortably inside what this many weeks of consistent training can deliver.";
  } else if (gapVdot <= plausibleGain * 1.15) {
    verdict = "ambitious";
    detail = "Achievable, but it needs most weeks to go well. Missing sessions will cost you this one.";
  } else {
    verdict = "unrealistic";
    const fairSeconds = projectedSeconds;
    detail = `This is a bigger jump than ${weeksLeft} weeks usually delivers. A realistic target from where you are now is around ${formatDuration(fairSeconds)}.`;
  }

  return {
    event: ev,
    currentVdot,
    currentPredicted,
    neededVdot,
    projectedSeconds,
    targetSeconds: goal.targetSeconds,
    weeksLeft,
    verdict,
    detail,
  };
}
