// Peak — the coach.
//
// Interprets what the athlete tells us and turns it into concrete changes to
// the plan. Deliberately rule-based: it runs offline, costs nothing, is fully
// deterministic, and can be tested. It understands training situations, not
// open-ended conversation, and it says so when it hasn't understood.
//
// Every response is { reply, actions } — actions are structured and applied by
// the app, never by this module. Keeping interpretation and mutation separate
// is what makes the whole thing testable.

import {
  dateKey, parseDateKey, addDays, weekdayIndex, WEEKDAYS, WEEKDAYS_SHORT,
  formatDuration, formatPace, INJURY_FOCUS_LABELS,
} from "./plan-engine.js?v=15";

// ---------------------------------------------------------------- text utils

function normalise(text) {
  return ` ${String(text || "").toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9'\s:.\-]/g, " ").replace(/\s+/g, " ").trim()} `;
}

function has(t, ...words) {
  return words.some((w) => t.includes(` ${w} `) || t.includes(` ${w}.`) || t.includes(` ${w},`));
}

function hasAny(t, list) {
  return list.some((w) => t.includes(w));
}

// ---------------------------------------------------------------- entities

const ACTIVITY_WORDS = [
  { key: "run", words: ["run", "ran", "running", "jog", "jogged", "jogging"] },
  { key: "bike", words: ["bike", "biked", "cycling", "cycled", "cycle", "spin", "spinning", "peloton"] },
  { key: "swim", words: ["swim", "swam", "swimming"] },
  { key: "row", words: ["row", "rowed", "rowing", "erg"] },
  { key: "walk", words: ["walk", "walked", "walking", "hike", "hiked", "hiking"] },
  { key: "strength", words: ["gym", "lifted", "lifting", "weights", "strength", "squats", "deadlift"] },
  { key: "sport", words: ["football", "soccer", "tennis", "basketball", "climbing", "climbed", "padel", "squash"] },
  { key: "yoga", words: ["yoga", "pilates", "stretching", "mobility"] },
];

const ACTIVITY_LABEL = {
  run: "run", bike: "bike session", swim: "swim", row: "row", walk: "walk",
  strength: "strength session", sport: "sport session", yoga: "mobility session",
};

function detectActivity(t) {
  for (const a of ACTIVITY_WORDS) if (hasAny(t, a.words.map((w) => ` ${w}`))) return a.key;
  return null;
}

// "40 min", "40min", "1h", "1.5 hours", "90 minutes"
function detectMinutes(t) {
  let m = t.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/);
  if (m) return Math.round(parseFloat(m[1]) * 60);
  m = t.match(/(\d+)\s*(?:m|min|mins|minute|minutes)\b/);
  if (m) return parseInt(m[1], 10);
  return null;
}

// "5k", "10 km", "3 miles"
function detectDistanceKm(t) {
  let m = t.match(/(\d+(?:\.\d+)?)\s*(?:k|km|kms|kilometre|kilometres|kilometer|kilometers)\b/);
  if (m) return parseFloat(m[1]);
  m = t.match(/(\d+(?:\.\d+)?)\s*(?:mi|mile|miles)\b/);
  if (m) return parseFloat(m[1]) * 1.60934;
  return null;
}

// The session the athlete names as the one they replaced ("instead of the
// intervals"). Without this we'd look up whatever was scheduled for the date
// and silently attribute the swap to the wrong session.
const PLANNED_TYPE_WORDS = [
  { key: "intervals", words: ["intervals", "interval session", "interval", "reps", "track session", "speed session"] },
  { key: "tempo", words: ["tempo", "threshold"] },
  { key: "long", words: ["long run", "long one", "longrun"] },
  { key: "strength", words: ["strength session", "gym session", "lifting session", "weights session"] },
  { key: "easy", words: ["easy run", "recovery run"] },
  { key: "test", words: ["time trial", "test session", "the test"] },
];

const SUBSTITUTION_CUES = [" instead", " rather than", " supposed to", " meant to",
  " should have", " was going to", " in place of", " skipped the", " swapped the", " swapped"];

function detectPlannedType(t) {
  if (!hasAny(t, SUBSTITUTION_CUES)) return null;
  for (const p of PLANNED_TYPE_WORDS) if (hasAny(t, p.words.map((w) => ` ${w}`))) return p.key;
  return null;
}

const BODY_PARTS = [
  { key: "knee", words: ["knee", "knees", "it band", "itb"] },
  { key: "hamstring", words: ["hamstring", "hamstrings", "hammy"] },
  { key: "calf", words: ["calf", "calves", "achilles", "shin", "shins"] },
  { key: "ankle", words: ["ankle", "ankles", "foot", "feet", "plantar"] },
  { key: "groin", words: ["groin", "adductor", "adductors"] },
  { key: "hipFlexor", words: ["hip", "hips", "hip flexor"] },
  { key: "lowerBack", words: ["back", "lower back", "lumbar"] },
  { key: "shoulder", words: ["shoulder", "shoulders"] },
];

function detectBodyPart(t) {
  for (const b of BODY_PARTS) if (hasAny(t, b.words.map((w) => ` ${w}`))) return b.key;
  return null;
}

// ---------------------------------------------------------------- dates

// Resolves day references to concrete dates, relative to `today`.
function detectDates(t, today) {
  const found = [];
  const push = (d) => { const k = dateKey(d); if (!found.includes(k)) found.push(k); };

  if (has(t, "today", "tonight") || t.includes(" this morning") || t.includes(" this evening")) push(today);
  if (has(t, "yesterday")) push(addDays(today, -1));
  if (has(t, "tomorrow")) push(addDays(today, 1));

  // Named weekdays, including simple ranges like "tuesday to thursday".
  const names = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  const shorts = ["mon", "tue", "tues", "wed", "weds", "thu", "thur", "thurs", "fri", "sat", "sun"];
  const shortToIndex = { mon: 0, tue: 1, tues: 1, wed: 2, weds: 2, thu: 3, thur: 3, thurs: 3, fri: 4, sat: 5, sun: 6 };

  const hits = [];
  names.forEach((n, i) => { if (t.includes(` ${n}`)) hits.push({ index: i, at: t.indexOf(` ${n}`) }); });
  shorts.forEach((sname) => {
    const re = new RegExp(`\\s${sname}\\b`);
    const m = t.match(re);
    if (m && !hits.some((h) => h.index === shortToIndex[sname])) {
      hits.push({ index: shortToIndex[sname], at: m.index });
    }
  });
  hits.sort((a, b) => a.at - b.at);

  const isRange = /\b(to|until|till|through|thru)\b|-/.test(t) && hits.length === 2;
  const resolve = (targetIdx) => {
    const base = weekdayIndex(today);
    let delta = targetIdx - base;
    // Past-tense phrasing points backwards, otherwise assume the coming one.
    const pastTense = /\b(was|did|ran|missed|skipped|couldn't|could not|didn't|did not)\b/.test(t);
    if (pastTense && delta > 0) delta -= 7;
    if (!pastTense && delta < 0) delta += 7;
    return addDays(today, delta);
  };

  if (isRange) {
    const a = resolve(hits[0].index);
    const b = resolve(hits[1].index);
    const span = Math.max(0, Math.round((b - a) / 86400000));
    for (let i = 0; i <= Math.min(span, 13); i++) push(addDays(a, i));
  } else {
    hits.forEach((h) => push(resolve(h.index)));
  }

  if (has(t, "weekend") && !hits.length) {
    const base = weekdayIndex(today);
    push(addDays(today, (5 - base + 7) % 7));
    push(addDays(today, (6 - base + 7) % 7));
  }

  return found;
}

// ---------------------------------------------------------------- feel words

const BAD_FEEL = [" wrecked", " exhausted", " shattered", " knackered", " dead legs", " destroyed",
  " flat", " heavy legs", " struggled", " struggling", " brutal", " too hard", " really hard",
  " couldn't finish", " could not finish", " blew up", " bonked", " rough", " awful", " terrible",
  " drained", " fatigued", " burnt out", " burned out", " wiped"];

const GOOD_FEEL = [" felt great", " feeling great", " felt good", " feeling good", " too easy",
  " easy", " comfortable", " strong", " flying", " smashed", " crushed", " no problem",
  " felt amazing", " great shape", " feeling strong", " felt easy"];

const PAIN_WORDS = [" hurt", " hurts", " hurting", " sore", " soreness", " pain", " painful",
  " niggle", " niggling", " tight", " tightness", " strain", " strained", " pulled", " injured",
  " injury", " ache", " aching", " swollen", " twinge"];

const MISS_WORDS = [" missed", " skipped", " skip", " didn't do", " did not do", " didn't train",
  " did not train", " couldn't train", " could not train", " no time", " bailed", " gave up",
  " didn't manage", " did not manage", " never got", " didn't get out", " nothing today"];

const UNAVAILABLE_WORDS = [" can't train", " cannot train", " can't make", " cannot make",
  " won't be able", " will not be able", " away", " travelling", " traveling", " on a trip",
  " out of town", " busy", " work dinner", " no time on", " unavailable", " can't do"];

const MORE_WORDS = [" too easy", " want more", " more volume", " harder", " push harder",
  " ramp up", " increase", " add more", " not enough", " under-training", " undertrained",
  " step it up", " bump it up"];

const LESS_WORDS = [" too much", " too many", " cut back", " cut it back", " ease off",
  " ease up", " back off", " reduce", " less volume", " overwhelmed", " can't keep up",
  " cannot keep up", " dial it back", " scale back", " too intense"];

// ---------------------------------------------------------------- helpers

function sessionOn(plan, key) {
  for (const w of plan.weeks) {
    const d = w.days.find((x) => x.dateKey === key);
    if (d) return { week: w, day: d };
  }
  return null;
}

function prettyDate(key) {
  return parseDateKey(key).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

function prettyShort(key) {
  return parseDateKey(key).toLocaleDateString(undefined, { weekday: "long" });
}

// Free days in the same week that could take a displaced session.
function freeDaysInWeek(plan, week, user, exclude = []) {
  const blocked = new Set([...(user.coachOverrides?.blockedDates || []), ...exclude]);
  return week.days.filter((d) => d.isRest && !d.commitment && !blocked.has(d.dateKey));
}

// ---------------------------------------------------------------- intents

// Ordered by priority: pain is checked before anything else, because a plan
// change is never the right first response to someone reporting an injury.
export function coachRespond(message, ctx) {
  const { user, plan, adaptation } = ctx;
  const today = ctx.today || new Date();
  const t = normalise(message);
  const todayKey = dateKey(today);

  if (!t.trim()) return { intent: "empty", reply: "Tell me what happened and I'll sort the plan out.", actions: [] };

  const dates = detectDates(t, today);
  const minutes = detectMinutes(t);
  const km = detectDistanceKm(t);
  const activity = detectActivity(t);
  const part = detectBodyPart(t);

  // ---- 1. Pain or injury. Safety first, plan second.
  if (hasAny(t, PAIN_WORDS)) {
    return painResponse({ t, part, user, plan, adaptation, today, todayKey });
  }

  // ---- 2. Goal changes are out of scope by design.
  if (hasAny(t, [" new goal", " change my goal", " different goal", " instead of the 5k",
                 " instead of the 10k", " switch to a marathon", " switch to a half",
                 " run a marathon instead", " change the deadline", " move the deadline",
                 " push the deadline", " race date"])) {
    return {
      intent: "goalChange",
      reply: "Changing your goal reshapes the whole plan, so I won't do it from a chat message — it needs the feasibility check that runs in the goal editor. Open Profile → Your goal → Edit and I'll tell you straight away whether the new target is reachable.",
      actions: [{ type: "openGoalEditor" }],
    };
  }

  // ---- 3. Did something other than what was prescribed.
  const didSomething = (activity || minutes || km) &&
    (hasAny(t, [" instead", " rather than", " swapped", " ended up", " only did", " only managed",
                " just did", " did ", " ran ", " went ", " i did", " i ran", " managed"]) ||
     /\bi (ran|did|went|swam|cycled|biked|rowed|walked|lifted)\b/.test(t));

  if (didSomething && !hasAny(t, UNAVAILABLE_WORDS)) {
    return loggedDifferently({ t, dates, minutes, km, activity, plan, user, today, todayKey });
  }

  // ---- 4. Missed a session.
  if (hasAny(t, MISS_WORDS)) {
    return missedResponse({ t, dates, plan, user, today, todayKey });
  }

  // ---- 5. Not available on specific days.
  if (hasAny(t, UNAVAILABLE_WORDS) || (dates.length && hasAny(t, [" can't", " cannot", " won't", " no "]))) {
    return unavailableResponse({ t, dates, plan, user, today, todayKey });
  }

  // ---- 6. Feeling wrecked / everything too hard.
  if (hasAny(t, BAD_FEEL) || hasAny(t, LESS_WORDS)) {
    return easeResponse({ t, user, plan, adaptation, todayKey });
  }

  // ---- 7. Feeling strong / wants more.
  if (hasAny(t, GOOD_FEEL) || hasAny(t, MORE_WORDS)) {
    return pushResponse({ t, user, plan, adaptation, todayKey });
  }

  // ---- 8. Informational questions.
  const info = informational({ t, plan, adaptation, user, today, todayKey });
  if (info) return info;

  // ---- 9. Understood nothing. Say so rather than guessing.
  return {
    intent: "unknown",
    reply: "I didn't follow that one. I'm good with things like:\n• \"ran 30 easy instead of the intervals\"\n• \"can't train Thursday, work dinner\"\n• \"legs are wrecked this week\"\n• \"my knee hurts\"\n• \"that felt way too easy\"\n• \"what am I doing today?\"",
    actions: [],
  };
}

// ---------------------------------------------------------------- responses

function painResponse({ t, part, user, plan, adaptation, today, todayKey }) {
  const severe = hasAny(t, [" sharp", " stabbing", " can't walk", " cannot walk", " can't put weight",
    " swollen", " swelling", " popped", " heard a pop", " worse every", " getting worse", " weeks"]);
  const label = part ? INJURY_FOCUS_LABELS[part] : null;
  const actions = [];

  // Add the area to injury focus so prehab starts appearing on easy days.
  const already = (user.profile.injuryFocus || []).includes(part);
  if (part && !already) actions.push({ type: "addInjuryFocus", part });

  // Take impact out of the next few days.
  actions.push({ type: "softenDays", days: 3, reason: label ? `${label} pain` : "pain" });

  let reply = label
    ? `Understood — ${label.toLowerCase()} pain. I've taken the impact out of the next three days: running swaps to bike, row, swim, or a brisk walk at the same effort, and strength moves away from anything that loads it.`
    : `Understood. I've taken the impact out of the next three days — running swaps to bike, row, swim, or a brisk walk at the same effort.`;

  if (part && !already) {
    reply += ` I've also added ${label.toLowerCase()} prehab to your easy days from here on.`;
  }

  reply += `\n\nTraining through pain is how a niggle becomes a season. The rule I'd hold you to: if it changes how you move, don't run on it.`;

  if (severe) {
    reply += `\n\nWhat you've described — sharp pain, swelling, or something that keeps getting worse — is past what a training plan should be adjusting around. Please get it looked at by a physio or doctor. I can reshuffle sessions; I can't tell you what's wrong, and I'm not going to pretend otherwise.`;
  } else {
    reply += ` If it's no better in a few days, or it hurts when you're not training, see a physio rather than asking me to keep shuffling around it.`;
  }

  return { intent: "pain", reply, actions, severity: severe ? "high" : "normal" };
}

function loggedDifferently({ t, dates, minutes, km, activity, plan, user, today, todayKey }) {
  let key = dates[0] || todayKey;

  // If they named the session they replaced, attribute the swap to that
  // session's day rather than to whatever happens to sit on today's date.
  const namedType = detectPlannedType(t);
  if (!dates.length && namedType) {
    const onToday = sessionOn(plan, todayKey);
    if (onToday?.day?.session?.type !== namedType) {
      const wk = plan.weeks.find((w) => w.days.some((d) => d.dateKey === todayKey));
      const match = wk?.days.find((d) => d.session && d.session.type === namedType);
      if (match) key = match.dateKey;
    }
  }

  const found = sessionOn(plan, key);
  const planned = found?.day?.session || null;

  // Effort from how they described it, defaulting to the planned target.
  let rpe = planned?.targetRpe ?? 5;
  if (hasAny(t, BAD_FEEL)) rpe = Math.min(10, rpe + 2);
  else if (hasAny(t, GOOD_FEEL)) rpe = Math.max(1, rpe - 1);
  if (hasAny(t, [" easy", " gentle", " steady"])) rpe = Math.min(rpe, 5);
  if (hasAny(t, [" flat out", " all out", " race pace", " hard"])) rpe = Math.max(rpe, 8);
  const m = t.match(/\brpe\s*(\d{1,2})\b/);
  if (m) rpe = Math.max(1, Math.min(10, parseInt(m[1], 10)));

  // Duration: stated, else estimated from distance, else the planned length.
  let mins = minutes;
  if (!mins && km) mins = Math.round(km * (plan.paces ? plan.paces.easy / 60 : 6));
  if (!mins) mins = planned?.minutes ?? 40;

  const actLabel = ACTIVITY_LABEL[activity] || "session";
  const descBits = [];
  if (km) descBits.push(`${km % 1 === 0 ? km : km.toFixed(1)} km`);
  if (mins) descBits.push(`${mins} min`);
  const desc = `${descBits.join(", ")} ${actLabel}`.trim();

  const actions = [{
    type: "logActual",
    dateKey: key,
    session: {
      type: activity || "other",
      minutes: mins,
      rpe,
      // The effort that WAS prescribed, so adaptation can still see the gap
      // between what the plan asked for and what the session actually cost.
      plannedRpe: planned?.targetRpe ?? rpe,
      note: String(t).trim().slice(0, 200),
      label: desc,
    },
  }];

  let reply = planned
    ? `Logged ${prettyShort(key).toLowerCase()} as ${desc} at RPE ${rpe}, in place of the ${planned.label.toLowerCase()}.`
    : `Logged ${prettyShort(key).toLowerCase()} as ${desc} at RPE ${rpe}.`;

  if (namedType && key !== todayKey) {
    reply += ` (That's the ${prettyShort(key).toLowerCase()} session — it's the one on your plan matching what you described.)`;
  }

  // Say plainly what the substitution costs, if anything.
  if (planned && ["intervals", "tempo"].includes(planned.type) && rpe <= 6) {
    reply += `\n\nWorth knowing: that swaps a quality session for an easy one. One week is nothing, but if it becomes the pattern the plan stops producing speed — it's the hard days that move your fitness. Your next quality session is the one to protect.`;
  } else if (planned && planned.type === "long" && mins < planned.minutes * 0.7) {
    reply += `\n\nThat's well short of the long run, which is the session your ${plan.vdot ? "endurance" : "engine"} is actually built on. If time was the problem, tell me which day has more room and I'll move it.`;
  } else if (activity && activity !== "run" && planned && ["easy", "long", "cardio"].includes(planned.type)) {
    reply += `\n\nCross-training counts for aerobic work, so that's a fair swap — it just doesn't load your legs the way running does. Fine occasionally, worth avoiding for the long run.`;
  } else {
    reply += ` That counts toward this week, and your fitness estimate reflects what you actually did.`;
  }

  return { intent: "logActual", reply, actions };
}

function missedResponse({ t, dates, plan, user, today, todayKey }) {
  const key = dates[0] || todayKey;
  const found = sessionOn(plan, key);
  const wholeWeek = hasAny(t, [" this week", " whole week", " all week", " the week"]);

  if (wholeWeek) {
    return {
      intent: "missedWeek",
      reply: `Right — a written-off week. I'm not going to try to cram it back in; stacking a missed week onto the next one is how people get hurt.\n\nThe plan carries on from where it is. Your adherence figure will show the gap, and if it keeps up, volume comes down on its own so the plan matches the week you actually have rather than the one you hoped for.\n\nIf the next few weeks look equally bad, tell me and I'll cut the sessions-per-week properly instead of leaving you failing a plan you can't fit.`,
      actions: [],
    };
  }

  if (!found || found.day.isRest) {
    return {
      intent: "missed",
      reply: `Nothing was scheduled for ${prettyShort(key).toLowerCase()}, so there's nothing to make up. Rest days are part of the plan, not a failure to train.`,
      actions: [],
    };
  }

  const week = found.week;
  const free = freeDaysInWeek(plan, week, user).filter((d) => parseDateKey(d.dateKey) > today);
  const label = found.day.session.label;

  if (free.length) {
    const target = free[0];
    return {
      intent: "missed",
      reply: `No problem. I've moved ${prettyShort(key).toLowerCase()}'s ${label.toLowerCase()} to ${prettyShort(target.dateKey).toLowerCase()}, which was free.\n\nOne missed session in a week costs you nothing. Don't try to double up to catch up — that's the move that turns a missed session into a missed fortnight.`,
      actions: [{ type: "moveSession", from: key, to: target.dateKey }],
    };
  }

  return {
    intent: "missed",
    reply: `${prettyShort(key)}'s ${label.toLowerCase()} is gone and there's no free day left this week to move it to. Let it go — the week is still worth doing without it, and squeezing it onto a day that already has a session does more harm than good.`,
    actions: [],
  };
}

function unavailableResponse({ t, dates, plan, user, today, todayKey }) {
  const targets = (dates.length ? dates : [todayKey]).filter((k) => parseDateKey(k) >= addDays(today, -1));
  if (!targets.length) {
    return { intent: "unavailable", reply: "Which day can't you train? Give me a day name and I'll work around it.", actions: [] };
  }

  const moved = [];
  const dropped = [];
  const usedTargets = [];

  for (const key of targets) {
    const found = sessionOn(plan, key);
    if (!found || found.day.isRest) continue;
    const free = freeDaysInWeek(plan, found.week, user, [...targets, ...usedTargets])
      .filter((d) => parseDateKey(d.dateKey) >= today);
    if (free.length) {
      const target = free[0];
      usedTargets.push(target.dateKey);
      moved.push({ from: key, to: target.dateKey, label: found.day.session.label });
    } else {
      dropped.push({ key, label: found.day.session.label });
    }
  }

  const actions = [
    { type: "blockDates", dates: targets, reason: "unavailable" },
    ...moved.map((mv) => ({ type: "moveSession", from: mv.from, to: mv.to })),
  ];

  let reply = `Blocked ${targets.map(prettyShort).map((s) => s.toLowerCase()).join(" and ")} off.`;
  if (moved.length) {
    reply += ` ${moved.map((mv) => `The ${mv.label.toLowerCase()} moves to ${prettyShort(mv.to).toLowerCase()}`).join("; ")}.`;
  }
  if (dropped.length) {
    reply += ` There was no free day left for ${dropped.map((d) => d.label.toLowerCase()).join(" and ")}, so ${dropped.length === 1 ? "it's" : "they're"} dropped this week rather than doubled up on a day that already has work.`;
  }
  if (!moved.length && !dropped.length) {
    reply += ` Nothing was scheduled then anyway, so the week is unchanged.`;
  }
  reply += `\n\nSay "free again on Thursday" if it opens back up.`;

  return { intent: "unavailable", reply, actions };
}

function easeResponse({ t, user, plan, adaptation, todayKey }) {
  const current = user.coachOverrides?.loadFactor ?? 1;
  const next = Math.max(0.7, Math.round((current - 0.12) * 100) / 100);
  const persistent = hasAny(t, [" every session", " all the time", " for weeks", " every week", " constantly"]);

  let reply = `Cut back — volume is now ${Math.round(next * 100)}% of what it was, starting today. Intensity targets stay where they are: when you're tired, the answer is less work, not the same work done worse.`;

  if (persistent) {
    reply += `\n\nIf it's been like this for weeks, that's not a bad patch, it's a plan that's too big for your life right now. Fewer sessions you actually complete beat more that you don't — Profile → Your schedule → Edit, and drop a session. I'd rather you did three properly than five badly.`;
  } else {
    reply += `\n\nHold your easy days genuinely easy this week — that's usually where fatigue comes from, not the hard sessions. If you feel better in a week, tell me and I'll put it back.`;
  }

  return {
    intent: "ease",
    reply,
    actions: [{ type: "setLoad", factor: next, reason: "reported fatigue" }],
  };
}

function pushResponse({ t, user, plan, adaptation, todayKey }) {
  const current = user.coachOverrides?.loadFactor ?? 1;
  const next = Math.min(1.15, Math.round((current + 0.08) * 100) / 100);
  const capped = next === current;

  if (capped) {
    return {
      intent: "push",
      reply: `You're already at the ceiling I'll push you to from a chat message — 115% of your baseline. Beyond that the honest move is more time, not more density: Profile → Your schedule → Edit and add a session or lengthen them.\n\nIf sessions genuinely feel easy at this volume, your next test week will show it, and every pace in the plan will step up off a measured number rather than a feeling.`,
      actions: [],
    };
  }

  return {
    intent: "push",
    reply: `Good — volume up to ${Math.round(next * 100)}% from today.\n\nOne thing I won't do is make your easy days harder. Feeling strong is the signal to push the hard sessions, and the reason you can push them is that the easy ones stayed easy. If the intervals still feel comfortable next week, tell me again and I'll add more.`,
    actions: [{ type: "setLoad", factor: next, reason: "feeling strong" }],
  };
}

function informational({ t, plan, adaptation, user, today, todayKey }) {
  const asking = /\?/.test(t) || hasAny(t, [" what ", " when ", " why ", " how ", " which "]);
  if (!asking) return null;

  if (hasAny(t, [" today", " doing today", " workout today", " session today"])) {
    const found = sessionOn(plan, todayKey);
    if (!found) return { intent: "info", reply: "Today falls outside your plan window.", actions: [] };
    if (found.day.isRest) {
      return { intent: "info", reply: `Today's a rest day${found.day.commitment ? ` — you've got ${found.day.commitment.label} on` : ""}. Nothing from me.`, actions: [] };
    }
    const s = found.day.session;
    return {
      intent: "info",
      reply: `Today is ${s.label} — ${s.minutes} min at RPE ${s.targetRpe}.\n\n${s.lines.slice(0, 3).map((l) => `• ${l}`).join("\n")}\n\nFull detail is on the Today tab.`,
      actions: [],
    };
  }

  if (hasAny(t, [" pace", " paces", " how fast", " how quick"])) {
    if (!plan.paces) {
      return { intent: "info", reply: "You're on a general fitness plan, so there are no running paces — everything is prescribed by effort (RPE) instead.", actions: [] };
    }
    const p = plan.paces;
    return {
      intent: "info",
      reply: `From your current fitness (${plan.vdot.toFixed(1)}):\n\n• Easy — ${formatPace(p.easy)}\n• Tempo — ${formatPace(p.threshold)}\n• Interval — ${formatPace(p.interval)}\n\n${adaptation.fitness.confidence === "measured" ? "These come off your last test, so they're real." : "These are estimated — your next test week will replace them with measured numbers."}`,
      actions: [],
    };
  }

  if (hasAny(t, [" test", " time trial", " next test"])) {
    const next = plan.testWeeks.find((n) => n >= adaptation.currentWeek);
    if (!next) return { intent: "info", reply: "No test weeks left — the next hard measurement is your goal itself.", actions: [] };
    const w = plan.weeks.find((x) => x.num === next);
    return {
      intent: "info",
      reply: `Next test is week ${next}, starting ${w.startDate.toLocaleDateString(undefined, { month: "long", day: "numeric" })}${next === adaptation.currentWeek ? " — that's this week" : ""}. It resets every pace in your plan, so treat it as the most important session of the block.`,
      actions: [],
    };
  }

  if (hasAny(t, [" on track", " going to make", " will i hit", " am i going"])) {
    return { intent: "info", reply: "The honest read on your target is on the Plan tab — it compares what your fitness predicts now against what the weeks remaining can realistically deliver. I keep it updated as you log.", actions: [] };
  }

  return null;
}
