// Peak — exercise library, warm-ups, prehab, and block builders.
// Everything here is deliberately minimum-gear: bodyweight first, with a
// resistance band and a step/bench as the only optional additions.

export const GEAR_LABELS = {
  shoes: "Running shoes",
  timer: "Phone timer or watch",
  space: "A patch of open ground (park, driveway, backyard)",
  mat: "Mat or soft floor",
  band: "Resistance band (optional — substitutions given)",
  step: "A step, curb, bench, or sturdy chair",
  bar: "Anything to hang from (optional — substitutions given)",
  route: "A measured route, or a phone GPS app",
};

// ---------------------------------------------------------------- warm-ups

export const WARMUPS = {
  run: [
    "5 min easy walk building to a jog",
    "Leg swings x10/side (forward, then sideways)",
    "Walking lunges x8/side, high knees x20, butt kicks x20",
    "3 x 20 sec strides — build to about 80% and float back down",
  ],
  runShort: [
    "5 min easy jog",
    "Leg swings x10/side, high knees x20, butt kicks x20",
  ],
  strength: [
    "3 min easy movement — march in place, arm circles, hip circles",
    "Bodyweight squats x12, glute bridges x12, cat-cow x8",
    "World's greatest stretch x5/side",
  ],
  test: [
    "10 min easy jog — genuinely easy, this is not part of the test",
    "Leg swings x10/side, high knees x20, butt kicks x20",
    "4 x 20 sec strides at target effort, full recovery between",
    "3 min walk, then start when you're ready",
  ],
};

export const COOLDOWNS = {
  run: ["5 min easy walk", "Calf, hamstring, quad, hip flexor stretch — 30 sec each"],
  strength: ["3 min easy walk or march", "Child's pose, figure-4 glute stretch, chest opener — 30 sec each"],
};

// ---------------------------------------------------------------- prehab

export const INJURY_FOCUS_LABELS = {
  hamstring: "Hamstring",
  groin: "Groin / Adductor",
  ankle: "Ankle",
  knee: "Knee",
  calf: "Calf",
  hipFlexor: "Hip Flexor",
  lowerBack: "Lower Back",
  shoulder: "Shoulder",
};

export const PREHAB = {
  hamstring: {
    gear: ["mat"],
    lines: [
      "Nordic curl negatives 2 x 5 — anchor your feet under a couch or bed, lower as slowly as you can",
      "Single-leg Romanian deadlift 2 x 8/side — bodyweight, focus on a flat back",
    ],
  },
  groin: {
    gear: ["mat"],
    lines: [
      "Copenhagen plank 2 x 15 sec/side — top leg on a chair or couch",
      "Lateral lunges 2 x 8/side, sitting into the bent hip",
    ],
  },
  ankle: {
    gear: [],
    lines: [
      "Single-leg balance 3 x 30 sec/side — eyes closed to progress",
      "Ankle alphabet x1/side, then calf raises 2 x 15",
    ],
  },
  knee: {
    gear: ["step"],
    lines: [
      "Controlled step-downs 2 x 8/side — 3 seconds down, tap, drive up",
      "Wall sit 2 x 30 sec, knees tracking over the middle toes",
    ],
  },
  calf: {
    gear: ["step"],
    lines: [
      "Eccentric heel drops 3 x 12 off a step — up on two, down on one",
      "Seated and standing calf stretch 2 x 30 sec each",
    ],
  },
  hipFlexor: {
    gear: ["mat"],
    lines: [
      "Couch stretch 2 x 30 sec/side",
      "Glute bridge march 2 x 10/side — ribs down, no hip drop",
    ],
  },
  lowerBack: {
    gear: ["mat"],
    lines: [
      "Bird-dog 2 x 8/side, pausing 2 sec at full extension",
      "Dead bug 2 x 10/side, lower back pressed flat",
    ],
  },
  shoulder: {
    gear: ["band"],
    lines: [
      "Band pull-aparts 2 x 15 (or scapular squeezes if you have no band)",
      "Wall slides 2 x 10, forearms staying in contact",
    ],
  },
};

export function prehabBlock(injuryFocus) {
  const list = (injuryFocus || []).filter((k) => PREHAB[k]);
  if (!list.length) return { lines: [], gear: [] };
  const lines = [];
  const gear = new Set();
  list.slice(0, 3).forEach((k) => {
    PREHAB[k].lines.forEach((l) => lines.push(`🩹 ${INJURY_FOCUS_LABELS[k]}: ${l}`));
    PREHAB[k].gear.forEach((g) => gear.add(g));
  });
  return { lines, gear: [...gear] };
}

// ---------------------------------------------------------------- strength

// Each entry: name, how to scale it down (regress) and up (progress), gear.
const STRENGTH_POOL = {
  lower: [
    { name: "Goblet or bodyweight squat", regress: "Box squat to a chair", progress: "Tempo squat, 3 sec down", gear: [] },
    { name: "Reverse lunge", regress: "Split squat, holding support", progress: "Rear-foot-elevated split squat", gear: [] },
    { name: "Single-leg glute bridge", regress: "Two-leg glute bridge", progress: "Feet elevated on a step", gear: ["mat"] },
    { name: "Step-up", regress: "Low step, hand support", progress: "Slow lower, 3 sec down", gear: ["step"] },
    { name: "Calf raise", regress: "Two-leg, flat ground", progress: "Single-leg off a step", gear: ["step"] },
    { name: "Wall sit", regress: "Shallower knee angle", progress: "Single-leg, or add time", gear: [] },
  ],
  upper: [
    { name: "Push-up", regress: "Hands on a step or wall", progress: "Feet elevated, or 3 sec down", gear: [] },
    { name: "Inverted row", regress: "Feet closer, more upright", progress: "Feet elevated", gear: ["bar"] },
    { name: "Pull-up or chin-up", regress: "Band-assisted, or slow negatives from the top", progress: "Pause 2 sec at the top", gear: ["bar"] },
    { name: "Pike push-up", regress: "Hands elevated", progress: "Feet on a step", gear: [] },
    { name: "Band row or doorway row", regress: "Less band tension", progress: "Pause 2 sec at the squeeze", gear: ["band"] },
    { name: "Dip on a chair or step", regress: "Feet flat, knees bent", progress: "Legs straight, heels out", gear: ["step"] },
    { name: "Superman hold", regress: "Alternate arm/leg only", progress: "Add a 3 sec hold", gear: ["mat"] },
  ],
  core: [
    { name: "Front plank", regress: "Knees down", progress: "Shoulder taps", gear: ["mat"] },
    { name: "Side plank", regress: "Knees bent", progress: "Top leg raised", gear: ["mat"] },
    { name: "Dead bug", regress: "Arms only", progress: "Slow 4 sec extension", gear: ["mat"] },
    { name: "Hollow hold", regress: "Knees tucked", progress: "Arms overhead", gear: ["mat"] },
    { name: "Pallof press or anti-rotation hold", regress: "Shorter lever", progress: "Step further from the anchor", gear: ["band"] },
  ],
};

// Ambitious volume with short rest. Every set is taken close to failure —
// leaving 1-2 reps in reserve, not 6. That proximity to failure is what drives
// adaptation; comfortable sets mostly just pass time.
const SET_SCHEME = {
  beginner: { sets: 3, reps: "10–12", rest: "45 sec", holdSec: 30 },
  intermediate: { sets: 4, reps: "10–12", rest: "40 sec", holdSec: 40 },
  advanced: { sets: 5, reps: "8–12", rest: "35 sec", holdSec: 50 },
};

const FINISHERS = [
  "Finisher: 3 rounds — 20 sec max-effort squat jumps, 40 sec rest",
  "Finisher: max push-ups in one set, rest 60 sec, repeat once",
  "Finisher: 2 rounds — 30 sec hollow hold, 30 sec side plank each side, no rest",
  "Finisher: 4 x 15 sec max-effort mountain climbers, 45 sec rest",
];

function pick(pool, count, seed) {
  // Deterministic rotation so the same week always yields the same session,
  // but consecutive weeks vary the movement selection.
  const out = [];
  for (let i = 0; i < count; i++) out.push(pool[(seed + i * 2) % pool.length]);
  return out;
}

// focus: "lower" | "upper" | "full"
export function strengthBlock({ focus, tier, minutes, seed = 0 }) {
  const scheme = SET_SCHEME[tier] || SET_SCHEME.beginner;
  const slots = minutes >= 55 ? 5 : minutes >= 40 ? 4 : 3;
  let chosen;
  if (focus === "lower") {
    chosen = [...pick(STRENGTH_POOL.lower, slots - 1, seed), ...pick(STRENGTH_POOL.core, 1, seed)];
  } else if (focus === "upper") {
    // Always include a vertical pull. An upper session without one is
    // incomplete, and it's the movement people ask for by name.
    const pull = STRENGTH_POOL.upper.find((e) => /pull-up/i.test(e.name));
    const rest = STRENGTH_POOL.upper.filter((e) => e !== pull);
    chosen = [pull, ...pick(rest, Math.max(1, slots - 2), seed), ...pick(STRENGTH_POOL.core, 1, seed)];
  } else {
    const nLower = Math.ceil((slots - 1) / 2);
    chosen = [
      ...pick(STRENGTH_POOL.lower, nLower, seed),
      ...pick(STRENGTH_POOL.upper, slots - 1 - nLower, seed + 1),
      ...pick(STRENGTH_POOL.core, 1, seed),
    ];
  }
  const gear = new Set();
  const lines = chosen.map((ex) => {
    ex.gear.forEach((g) => gear.add(g));
    const dose = /plank|hold|sit|superman/i.test(ex.name)
      ? `${scheme.sets} x ${scheme.holdSec} sec`
      : `${scheme.sets} x ${scheme.reps}`;
    return `${ex.name} — ${dose} (easier: ${ex.regress} · harder: ${ex.progress})`;
  });
  return {
    lines: [
      `Work through the list, ${scheme.rest} rest between sets. Take every set to within 1–2 reps of failure — if you finish a set fresh, use the harder variation next time.`,
      ...lines,
      FINISHERS[seed % FINISHERS.length],
    ],
    gear: [...gear],
  };
}

// ---------------------------------------------------------------- conditioning

export const CONDITIONING_FORMATS = [
  {
    name: "Circuit",
    build: (tier, minutes) => {
      const rounds = minutes >= 50 ? 6 : minutes >= 35 ? 5 : 4;
      const work = tier === "advanced" ? 45 : tier === "intermediate" ? 40 : 35;
      return [
        `${rounds} rounds, ${work} sec work / ${60 - work} sec rest per station:`,
        "1. Squat jumps (or fast bodyweight squats)",
        "2. Push-ups",
        "3. Reverse lunges, alternating",
        "4. Mountain climbers",
        "5. Plank hold",
        "Take 75 sec between rounds. Target RPE 8–9 — the last round should be genuinely hard to finish.",
      ];
    },
    gear: ["mat", "timer"],
  },
  {
    name: "EMOM",
    build: (tier, minutes) => {
      const total = minutes >= 50 ? 24 : minutes >= 35 ? 20 : 16;
      const reps = tier === "advanced" ? 18 : tier === "intermediate" ? 15 : 12;
      return [
        `Every Minute On the Minute for ${total} min — rest whatever is left of each minute:`,
        `Minute 1: ${reps} squats`,
        `Minute 2: ${Math.round(reps * 0.7)} push-ups`,
        `Minute 3: ${reps} reverse lunges (total)`,
        "Minute 4: 30 sec plank",
        "Repeat the cycle. If you can't finish a minute's work, cut the reps by 2 and carry on.",
      ];
    },
    gear: ["mat", "timer"],
  },
  {
    name: "Intervals",
    build: (tier, minutes) => {
      const reps = minutes >= 50 ? 12 : minutes >= 35 ? 10 : 8;
      const work = tier === "advanced" ? 50 : tier === "intermediate" ? 45 : 35;
      return [
        `${reps} x ${work} sec hard effort @ RPE 9, ${90 - work} sec easy between`,
        "Run, bike, row, or shuttle sprints — whatever you have access to",
        "Hold the same effort on the last rep as the first. If you fade badly, stop a rep early.",
      ];
    },
    gear: ["timer", "space"],
  },
];

export function conditioningBlock({ tier, minutes, seed = 0 }) {
  const fmt = CONDITIONING_FORMATS[seed % CONDITIONING_FORMATS.length];
  return { title: fmt.name, lines: fmt.build(tier, minutes), gear: fmt.gear };
}

// ---------------------------------------------------------------- mobility

export const MOBILITY_FLOW = [
  "Cat-cow x10",
  "World's greatest stretch x5/side",
  "90/90 hip switches x10/side",
  "Deep squat hold 3 x 30 sec",
  "Thoracic rotations x8/side",
  "Couch stretch 2 x 30 sec/side",
  "Calf and hamstring stretch 2 x 30 sec/side",
];

// ---------------------------------------------------------------- RPE

export const RPE_SCALE = [
  { range: "1–2", label: "Very Easy", desc: "Barely moving — could do this all day" },
  { range: "3–4", label: "Easy", desc: "Full conversation, nose breathing possible" },
  { range: "5–6", label: "Moderate", desc: "Comfortably hard — full sentences only" },
  { range: "7–8", label: "Hard", desc: "Breathing heavy — short phrases only" },
  { range: "9", label: "Very Hard", desc: "Near max — one-word answers" },
  { range: "10", label: "Max", desc: "All-out, unsustainable" },
];
