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
  formatDuration, formatPace, INJURY_FOCUS_LABELS, vdotFromRace,
} from "./plan-engine.js?v=34";

// ---------------------------------------------------------------- text utils

// Deliberately excludes "its", "ill", "well", "hes", "shes" — expanding those
// would break more than it fixes ("ill" is how people say they're unwell).
const CONTRACTIONS = {
  dont: "don't", cant: "can't", wont: "won't", didnt: "didn't", doesnt: "doesn't",
  isnt: "isn't", wasnt: "wasn't", arent: "aren't", werent: "weren't",
  couldnt: "couldn't", shouldnt: "shouldn't", wouldnt: "wouldn't",
  havent: "haven't", hasnt: "hasn't", hadnt: "hadn't",
  im: "i'm", ive: "i've", youre: "you're", theyre: "they're",
  thats: "that's", whats: "what's", lets: "let's",
};

function expandContractions(t) {
  return t.replace(/\b([a-z]+)\b/g, (w) => CONTRACTIONS[w] || w);
}

function normalise(text) {
  return ` ${String(text || "").toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9'\s:.\-\/%]/g, " ").replace(/\s+/g, " ").trim()} `.replace(/\S+/g, (w) => expandContractions(w));
}

// ---------------------------------------------------------------- fuzzy matching
//
// People type "holliday", "delaod", "thurdsay". Exact substring matching misses
// all of it. Bounded edit distance fixes that, but naive fuzzing is dangerous:
// "face" is one edit from "race", and "i can't face it" would book a race.
//
// Two guards make it safe:
//   1. Only words of 5+ characters are fuzzed at all — short words must match
//      exactly, because at that length everything is one edit from everything.
//   2. The first letter must match. Typos overwhelmingly preserve it, and this
//      is what stops face/race, pain/rain, cold/bold.

let _tokCache = { str: null, toks: null };
function tokensFor(t) {
  if (_tokCache.str === t) return _tokCache.toks;
  _tokCache = { str: t, toks: t.trim().split(/\s+/).filter(Boolean) };
  return _tokCache.toks;
}

// Bounded Damerau-Levenshtein — bails out as soon as the whole row exceeds max.
// The transposition case matters: swapped adjacent letters ("delaod", "teh",
// "recieve") are the single commonest typo, and plain Levenshtein scores them
// as two edits, which puts them outside a sane tolerance.
function lev(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prevPrev = null;
  let prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1);
    cur[0] = i;
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prevPrev[j - 2] + 1);
      }
      cur[j] = v;
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prevPrev = prev;
    prev = cur;
  }
  return prev[b.length];
}

// Guard 3, learned the hard way: "add some gym stuff" fuzzy-matched "stuffy"
// and reported the athlete as ill. A token that is already an ordinary English
// word is not a typo of something else — it's that word. Only misspellings get
// fuzzed, never real words.
const NEVER_FUZZ = new Set([
  "about", "after", "again", "along", "also", "always", "another", "anything", "around", "away",
  "back", "been", "before", "being", "below", "best", "better", "between", "both", "bring",
  "came", "come", "could", "doing", "down", "during", "each", "early", "enough", "even", "ever",
  "every", "face", "fact", "feel", "felt", "find", "fine", "first", "from", "full", "give",
  "going", "gone", "good", "great", "half", "hard", "have", "here", "home", "hour", "just",
  "keep", "kind", "know", "last", "late", "left", "less", "like", "line", "little", "long",
  "look", "lots", "made", "make", "many", "maybe", "mean", "might", "mine", "more", "most",
  "much", "must", "near", "need", "never", "next", "nice", "night", "none", "nothing", "often",
  "once", "only", "other", "over", "part", "past", "place", "plan", "point", "pretty", "quite",
  "rain", "read", "real", "really", "right", "room", "said", "same", "seem", "sent", "short",
  "should", "side", "since", "small", "some", "soon", "sort", "sound", "space", "spent",
  "start", "state", "still", "stuff", "such", "sure", "take", "than", "that", "their", "them",
  "then", "there", "these", "they", "thing", "think", "this", "those", "though", "three",
  "through", "time", "today", "told", "took", "tried", "turn", "under", "until", "upon",
  "used", "very", "want", "week", "well", "went", "were", "what", "when", "where", "which",
  "while", "will", "with", "work", "would", "year", "your",
]);

function wordMatches(tok, word) {
  if (tok === word) return true;
  if (word.length < 5) return false;              // guard 1: short words exact only
  if (tok[0] !== word[0]) return false;           // guard 2: typos keep the first letter
  if (NEVER_FUZZ.has(tok)) return false;          // guard 3: real words aren't typos
  const tol = word.length >= 8 ? 2 : 1;
  return lev(tok, word, tol) <= tol;
}

function fuzzyHas(t, phrase) {
  const p = phrase.trim().split(/\s+/).filter(Boolean);
  if (!p.length) return false;
  const toks = tokensFor(t);
  for (let i = 0; i + p.length <= toks.length; i++) {
    let ok = true;
    for (let k = 0; k < p.length; k++) {
      if (!wordMatches(toks[i + k], p[k])) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

function has(t, ...words) {
  if (words.some((w) => t.includes(` ${w} `) || t.includes(` ${w}.`) || t.includes(` ${w},`))) return true;
  return words.some((w) => fuzzyHas(t, w));
}

function hasAny(t, list) {
  // Exact first — it's cheap and covers most messages.
  if (list.some((w) => t.includes(w))) return true;
  return list.some((w) => fuzzyHas(t, w));
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
  for (const a of ACTIVITY_WORDS) {
    const hit = a.words.find((w) => t.includes(` ${w}`));
    if (hit) return a.key;
  }
  return null;
}

// The exact word used, so a log can say "tennis" rather than "sport session".
function detectActivityWord(t) {
  for (const a of ACTIVITY_WORDS) {
    const hit = a.words.find((w) => t.includes(` ${w}`));
    if (hit) return hit;
  }
  return null;
}

// "5:41/km", "5.41 min/km", "8:30 per mile". Written X.YY we read it as
// minutes and seconds, which is what people mean when they type a pace.
const PACE_RE = /\b(\d{1,2})[.:](\d{1,2})\s*(?:min\s*)?(?:\/|per\s+)\s*(km|k|mi|mile|miles)\b/;

function detectPace(t) {
  const m = t.match(PACE_RE);
  if (!m) return null;
  const mins = parseInt(m[1], 10);
  const secs = parseInt(m[2], 10);
  if (secs >= 60) return null;
  const perUnit = mins * 60 + secs;
  const isMiles = /^mi/.test(m[3]);
  return { secPerKm: isMiles ? perUnit / 1.60934 : perUnit, raw: m[0].trim() };
}

// Strip pace expressions so their digits can't be mistaken for a duration.
function stripPaces(t) {
  return t.replace(new RegExp(PACE_RE.source, "g"), " ");
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

// "tennis for an hour and a 50 min run" is two sessions, not one. Splitting on
// connectives keeps each duration attached to the activity it belongs to —
// otherwise the first number in the sentence wins and the rest is lost.
function detectActivitySegments(t) {
  const clean = stripPaces(t);
  const parts = clean.split(/\band\b|,|\bthen\b|\bplus\b|\balso\b|\bfollowed by\b/);
  const out = [];
  for (const raw of parts) {
    const seg = ` ${raw.trim()} `;
    const activity = detectActivity(seg);
    const minutes = detectMinutes(seg);
    const km = detectDistanceKm(seg);
    if (activity || minutes || km) out.push({ activity, word: detectActivityWord(seg), minutes, km, seg });
  }
  // Merge a leading bare duration into the following activity ("for an hour, tennis").
  return out.filter((x) => x.activity || x.minutes || x.km);
}

// Movements the plan actually prescribes. Used to tell "I can't do pull-ups"
// (an exercise constraint) apart from "I can't train Thursday" (a day off) —
// previously both matched "can't do" and a training day got silently blocked.
const EXERCISE_TERMS = [
  "pull-up", "pull up", "pullup", "chin-up", "chin up", "push-up", "push up", "pushup",
  "squat", "lunge", "plank", "burpee", "dip", "row", "deadlift", "rdl", "glute bridge",
  "calf raise", "step-up", "step up", "mountain climber", "hollow", "dead bug",
  "bird-dog", "superman", "nordic", "copenhagen", "wall sit", "pike", "jump", "crunch",
  "sit-up", "sit up", "bench press", "bench", "curl", "press", "core work", "abs",
];

function detectExercises(t) {
  return EXERCISE_TERMS.filter((x) => t.includes(` ${x}`));
}

// Kit someone might not have. Removing it prunes every movement that needs it.
const GEAR_PHRASES = [
  { gear: "bar", words: ["pull-up bar", "pull up bar", "pullup bar", "bar to hang", "chin-up bar"] },
  { gear: "band", words: ["resistance band", "bands", "band"] },
  { gear: "step", words: ["bench", "step", "box"] },
  { gear: "mat", words: ["mat"] },
];

function detectMissingGear(t) {
  if (!hasAny(t, [" don't have", " do not have", " no access", " haven't got", " without a", " without any", " lack a"])) return [];
  return GEAR_PHRASES.filter((g) => hasAny(t, g.words.map((w) => ` ${w}`))).map((g) => g.gear);
}

// "replace X with Y" / "swap X for Y" / "Y instead of X"
function detectSubstitution(t) {
  let m = t.match(/\b(?:replace|swap|switch|change)\s+(?:the\s+)?([a-z\-\s]{3,20}?)\s+(?:with|for|to)\s+(?:the\s+)?([a-z\-\s]{3,20}?)(?:\s|$|\.)/);
  if (m) return { from: m[1].trim(), to: m[2].trim() };
  return null;
}

// A clock time like "23:40" or "1:51:20", with pace expressions removed first
// so "5:41/km" can't be mistaken for a result.
function detectClockTime(t) {
  const m = stripPaces(t).match(/\b(\d{1,3}):(\d{2})(?::(\d{2}))?\b/);
  if (!m) return null;
  return m[3] ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : (+m[1]) * 60 + (+m[2]);
}

// Only a genuine maximal effort should reset training paces. A steady 8k in
// 45 min is not a test, and treating it as one would prescribe paces the
// athlete can't hold.
const RACE_MARKERS = [" pb", " pr ", " personal best", " race", " raced", " racing",
  " parkrun", " park run", " time trial", " all out", " all-out", " flat out", " went for it"];

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

// Weekday INDICES for recurring requests ("every Tuesday", "Tuesdays and Thursdays"),
// as distinct from detectDates which resolves to one concrete date.
function detectWeekdays(t) {
  const names = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  const shortToIndex = { mon: 0, tue: 1, tues: 1, wed: 2, weds: 2, thu: 3, thur: 3, thurs: 3, fri: 4, sat: 5, sun: 6 };
  const found = [];
  names.forEach((n, i) => { if (t.includes(` ${n}`)) found.push(i); });
  Object.entries(shortToIndex).forEach(([sname, i]) => {
    if (new RegExp(`\\s${sname}\\b`).test(t) && !found.includes(i)) found.push(i);
  });
  return [...new Set(found)].sort((a, b) => a - b);
}

const ADD_CUES = [" add ", " add a", " add two", " add 2", " put in", " include ", " schedule ",
  " i want ", " i'd like", " squeeze in", " can you add", " fit in", " throw in", " start doing"];
const REMOVE_CUES = [" remove ", " drop the", " take out", " get rid of", " delete ", " stop doing",
  " don't want the", " do not want the", " cancel the"];

// What kind of session to add. Order matters: "upper body strength" is upper,
// not generic strength.
function detectAddType(t) {
  if (hasAny(t, [" upper body", " upper-body", " pull up", " pull-up", " pullup", " chin up", " bench", " push day"])) return "upper";
  if (hasAny(t, [" lower body", " lower-body", " leg day", " legs ", " squat"])) return "lower";
  if (hasAny(t, [" conditioning", " hiit", " circuit", " metcon"])) return "conditioning";
  if (hasAny(t, [" mobility", " yoga", " stretching", " stretch session"])) return "mobility";
  if (hasAny(t, [" strength", " weights", " lifting", " gym", " resistance"])) return "full";
  if (hasAny(t, [" tempo"])) return "tempo";
  if (hasAny(t, [" intervals", " interval"])) return "intervals";
  if (hasAny(t, [" long run"])) return "long";
  if (hasAny(t, [" easy run", " run ", " running", " jog"])) return "easy";
  return null;
}

const ADD_TYPE_LABEL = {
  upper: "upper-body strength", lower: "lower-body strength", full: "full-body strength",
  conditioning: "conditioning", mobility: "mobility", tempo: "tempo run",
  intervals: "interval session", long: "long run", easy: "easy run",
};

// ---------------------------------------------------------------- feel words

const BAD_FEEL = [" harder than it should", " feels harder", " feeling harder", " harder than usual",
  " wrecked", " exhausted", " shattered", " knackered", " dead legs", " destroyed",
  " flat", " heavy legs", " struggled", " struggling", " brutal", " too hard", " really hard",
  " couldn't finish", " could not finish", " blew up", " bonked", " rough", " awful", " terrible",
  " drained", " fatigued", " burnt out", " burned out", " wiped"];

const GOOD_FEEL = [" felt great", " feeling great", " felt good", " feeling good", " too easy",
  " easy", " comfortable", " strong", " flying", " smashed", " crushed", " no problem",
  " felt amazing", " great shape", " feeling strong", " felt easy"];

const PAIN_WORDS = [" hurt", " hurts", " hurting", " sore", " soreness", " pain", " painful",
  " niggle", " niggling", " tight", " tightness", " strain", " strained", " pulled", " injured",
  " injury", " ache", " aching", " swollen", " twinge"];

const DONE_WORDS = [" completed", " finished", " done", " did the", " done the", " nailed", " smashed it", " got it done",
  " ticked off", " all done", " session done", " workout done", " did today's", " did the session",
  " did the workout", " did it", " job done"];

const MISS_WORDS = [" missed", " skipped", " skip", " didn't do", " did not do", " didn't train",
  " did not train", " couldn't train", " could not train", " no time", " bailed", " gave up",
  " didn't manage", " did not manage", " never got", " didn't get out", " nothing today"];

const UNAVAILABLE_WORDS = [" can't train", " cannot train", " can't make", " cannot make",
  " won't be able", " will not be able", " away", " travelling", " traveling", " on a trip",
  " out of town", " busy", " work dinner", " no time on", " unavailable", " can't do"];

const MORE_WORDS = [" too easy", " want more", " more volume", " push harder", " go harder",
  " train harder", " make it harder", " week harder", " bit harder",
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

// Symptoms that are not training problems. Deliberately narrow so normal
// training talk ("out of breath", "legs hurt") doesn't trip them.
const URGENT_MEDICAL = [
  " chest pain", " chest was tight", " chest tightness", " chest tight", " pain in my chest",
  " chest pressure", " tightness in my chest", " fainted", " passed out", " blacked out",
  " lost consciousness", " palpitations", " heart racing", " irregular heartbeat",
  " heart was pounding", " numbness", " numb down", " slurred", " vision went",
  " couldn't see", " severe headache", " worst headache",
];

// Disclosures about restriction or purging. A training app must not treat these
// as a scheduling problem, and must not give numbers.
const EATING_CONCERN = [
  " skipping meals", " skip meals", " not eating", " barely eating", " stopped eating",
  " starving myself", " starve myself", " restricting", " restrict my", " purge", " purging",
  " throw up after", " throwing up after", " make myself sick", " bingeing", " binging",
  " hate my body", " too fat to",
];

const NUTRITION_QUESTIONS = [
  " creatine", " supplement", " protein powder", " how many calories", " what should i eat",
  " macros", " carb load", " gels", " should i eat", " diet plan", " lose weight",
];

// ---------------------------------------------------------------- words

const UNDO_WORDS = [" undo", " revert", " take that back", " ignore what i just said",
  " ignore that", " scratch that", " never mind that", " cancel that", " reverse that",
  " put it back", " that was wrong", " logged that wrong", " got that wrong"];

const DELETE_LOG_WORDS = [" delete ", " remove the log", " unlog", " didn't actually",
  " did not actually", " wasn't me", " clear the log"];

const ILLNESS_SYSTEMIC = [" fever", " temperature", " flu", " covid", " chest infection",
  " vomiting", " throwing up", " being sick", " diarrhoea", " diarrhea", " body aches",
  " aching all over", " shivering", " chills", " bronchitis"];
const ILLNESS_MILD = [" cold", " sniffles", " blocked nose", " runny nose", " sore throat",
  " head cold", " congested", " stuffy", " bunged up"];
const ILLNESS_GENERAL = [" sick", " ill ", " unwell", " under the weather", " poorly"];
const RECOVERED_WORDS = [" feeling better", " over it now", " recovered", " back to normal",
  " symptom free", " symptom-free", " all clear"];

const ABSENCE_WORDS = [" holiday", " vacation", " away for", " off for", " travelling for",
  " traveling for", " business trip", " no training for", " can't train for"];
const RETURN_WORDS = [" just got back", " back after", " returning after", " been off for",
  " haven't trained in", " haven't run in", " first week back", " coming back after"];

const RACE_ADD_WORDS = [" parkrun", " park run", " got a race", " have a race", " signed up for",
  " racing on", " race on", " i'm racing", " im racing", " entered a", " doing a race"];

const ENV_TREADMILL = [" treadmill", " dreadmill", " indoors on the"];
const ENV_TRAIL = [" trails", " trail run", " off-road", " hills and trails", " mountain"];
const ENV_HEAT = [" degrees", " so hot", " really hot", " heatwave", " boiling", " humid"];
const ENV_COLD = [" icy", " snow", " freezing out", " black ice"];
const ENV_NOGYM = [" no gym", " gym is closed", " without a gym", " no gym access"];

const ALCOHOL_WORDS = [" night out", " big night", " hungover", " hangover", " been drinking",
  " few too many", " heavy weekend", " on the beers"];
const RACE_CANCEL = [" race got cancelled", " race is cancelled", " race was cancelled",
  " cancelled the race", " not doing the race", " pulled out of", " race got called off"];

const SLEEP_STRESS = [" slept", " no sleep", " insomnia", " stressed", " stressful",
  " burnt out", " burned out", " exams", " deadline", " work has been",
  " at work", " work is", " workload", " overwhelmed at", " full on at"];

const PROGRESS_Q = [" getting fitter", " am i improving", " progressing", " getting faster",
  " am i improving", " making progress", " any better than"];

// "in 3 weeks", "in a month", "for two weeks"
const NUM_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
function parseSpanDays(t) {
  const m = t.match(/\b(?:in|for|after)\s+(\d+|a|an|one|two|three|four|five|six)\s+(day|days|week|weeks|month|months)\b/);
  if (!m) return null;
  const n = /\d/.test(m[1]) ? parseInt(m[1], 10) : (NUM_WORDS[m[1]] || 1);
  if (/day/.test(m[2])) return n;
  if (/week/.test(m[2])) return n * 7;
  return n * 30;
}

// ---------------------------------------------------------------- intents

// Ordered by priority: pain is checked before anything else, because a plan
// change is never the right first response to someone reporting an injury.
// A rambling message often carries several signals at once. The coach acts on
// the highest-priority one, but staying silent about the rest makes it look
// like it only read half the message. Naming them is cheap and honest.
const SECONDARY_SIGNALS = [
  { intents: ["pain"], label: "something hurting", test: (t) => hasAny(t, PAIN_WORDS) },
  { intents: ["ease"], label: "how tired you are", test: (t) => hasAny(t, BAD_FEEL) },
  { intents: ["missed", "unavailable"], label: "a missed session", test: (t) => hasAny(t, MISS_WORDS) },
  { intents: ["race"], label: "a race coming up", test: (t) => hasAny(t, RACE_ADD_WORDS) },
  { intents: ["lifeLoad"], label: "sleep or stress", test: (t) => hasAny(t, SLEEP_STRESS) },
  { intents: ["addSession"], label: "wanting to add sessions", test: (t) => hasAny(t, ADD_CUES) },
  { intents: ["illness"], label: "being unwell", test: (t) => hasAny(t, ILLNESS_SYSTEMIC) || hasAny(t, ILLNESS_GENERAL) },
];

// Never appended to safety responses — those must not be diluted with
// housekeeping, and never to "unknown", which already asks for a rephrase.
const NO_SECONDARY = new Set(["urgentMedical", "eatingConcern", "outOfScope", "unknown", "undo"]);

export function coachRespond(message, ctx) {
  const res = coachRespondCore(message, ctx);
  const t = normalise(message);
  if (NO_SECONDARY.has(res.intent) || tokensFor(t).length < 14) return res;

  const others = SECONDARY_SIGNALS
    .filter((sig) => !sig.intents.includes(res.intent) && sig.test(t))
    .map((sig) => sig.label);
  if (!others.length) return res;

  const list = others.length === 1 ? others[0]
    : others.slice(0, -1).join(", ") + " and " + others[others.length - 1];
  return { ...res, reply: `${res.reply}\n\nYou also mentioned ${list} — I've only acted on the main thing. Say more about that and I'll deal with it too.`, secondary: others };
}

function coachRespondCore(message, ctx) {
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

  // ---- 0a. Symptoms that need a doctor, not a training adjustment. Checked
  //           before everything, and never changes the plan — quietly softening
  //           next week's sessions would imply this is a training problem.
  if (hasAny(t, URGENT_MEDICAL)) {
    return {
      intent: "urgentMedical",
      reply: "Stop training and get this looked at today — urgent care or your doctor, and emergency services if it's happening now or comes back.\n\nChest symptoms, fainting, palpitations and numbness around exercise are not training problems, and I'm not going to treat them like one by shuffling your sessions. I haven't changed anything in your plan; it'll still be here.\n\nPlease don't train again until someone qualified has told you it's safe.",
      actions: [],
      severity: "urgent",
    };
  }

  // ---- 0b. Restriction or purging. No plan change, no numbers, no advice
  //           about eating — just a straight answer and a route to real help.
  if (hasAny(t, EATING_CONCERN)) {
    return {
      intent: "eatingConcern",
      reply: "Thank you for telling me. I'm not going to change your training over that, because it isn't a training problem and I'd be the wrong thing to fix it.\n\nWhat I can say plainly: under-eating doesn't make you faster. It costs you adaptation, bone density and your period if you have one, and the fatigue you feel is the first symptom, not the last.\n\nPlease talk to your GP or a sports dietitian — and if it feels bigger than food, Beat (beateatingdisorders.org.uk) and NEDA (nationaleatingdisorders.org) both have helplines. I'll keep the plan exactly as it is in the meantime.",
      actions: [],
      severity: "high",
    };
  }

  // ---- 0c. Nutrition and supplements are outside what this app should answer.
  if (hasAny(t, NUTRITION_QUESTIONS) && /\?|\bshould i\b|\bhow many\b|\bwhat\b/.test(t)) {
    return {
      intent: "outOfScope",
      reply: "That's outside what I should be answering. I build training plans from your logged sessions — I've got no view of your body, your bloods or your history, and nutrition advice from something that can't see any of that is worth very little.\n\nA sports dietitian is the right person, and for anything supplement-related, your doctor. Ask me about the training and I'm on much firmer ground.",
      actions: [],
    };
  }

  // ---- 0d. Undo and log corrections. Early, because these are unambiguous
  //           and because the coach changes state — there must always be a way
  //           back that doesn't involve digging through the Profile editors.
  if (hasAny(t, UNDO_WORDS)) {
    return {
      intent: "undo",
      reply: "Reverted my last change. Everything is back to how it was before that message.",
      actions: [{ type: "undoLast" }],
    };
  }

  const swapDayFix = t.match(/\b(mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun)\w*\s+not\s+(mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun)\w*/);
  if (swapDayFix) {
    const idx = { mon: 0, tue: 1, tues: 1, wed: 2, weds: 2, thu: 3, thur: 3, thurs: 3, fri: 4, sat: 5, sun: 6 };
    const toIdx = idx[swapDayFix[1]], fromIdx = idx[swapDayFix[2]];
    const base = weekdayIndex(today);
    const dayFor = (i) => dateKey(addDays(today, i - base <= 0 ? i - base : i - base - 7));
    return {
      intent: "moveLog",
      reply: `Fixed — moved that session from ${WEEKDAYS[fromIdx]} to ${WEEKDAYS[toIdx]}.`,
      actions: [{ type: "moveLog", from: dayFor(fromIdx), to: dayFor(toIdx) }],
    };
  }

  if (hasAny(t, DELETE_LOG_WORDS) && (dates.length || hasAny(t, [" log", " session", " workout"]))) {
    const key = dates[0] || todayKey;
    return {
      intent: "deleteLog",
      reply: `Removed the log for ${prettyShort(key).toLowerCase()}. Your adherence and fitness estimate recalculate without it.`,
      actions: [{ type: "deleteLog", dateKey: key }],
    };
  }

  // ---- 0e. Illness. Not an injury, and not a motivation problem — it has its
  //          own rules, and they are stricter than most people expect.
  const weatherContext = hasAny(t, [" degrees", " outside", " out there", " weather", " forecast"]);
  const systemic = hasAny(t, ILLNESS_SYSTEMIC);
  const mild = !weatherContext && hasAny(t, ILLNESS_MILD);
  // If an illness is on record, "feeling better" is enough on its own — asking
  // them to restate the symptom would be pedantic.
  if (hasAny(t, RECOVERED_WORDS) &&
      (systemic || mild || hasAny(t, ILLNESS_GENERAL) || user.coachOverrides?.illness)) {
    return recoveredResponse({ user });
  }
  if (systemic || mild || hasAny(t, ILLNESS_GENERAL)) {
    return illnessResponse({ t, systemic, mild, today });
  }

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

  const exercises = detectExercises(t);
  const missingGear = detectMissingGear(t);
  const substitution = detectSubstitution(t);

  // ---- 1b. A race or event inside the plan.
  if (hasAny(t, RACE_CANCEL)) {
    const races = user.coachOverrides?.races || [];
    return {
      intent: "raceRemoved",
      reply: races.length
        ? `Taken it out. The days around it go back to normal training, and the block carries on as it was.`
        : `There's no race in your plan to remove. If you meant a session, tell me which day and I'll clear it.`,
      actions: races.length ? [{ type: "removeRace", dateKey: races[races.length - 1].dateKey }] : [],
    };
  }
  if (hasAny(t, RACE_ADD_WORDS)) {
    return raceResponse({ t, dates, today, plan, adaptation });
  }

  // ---- 1c. A block away, or coming back from one.
  if (hasAny(t, RETURN_WORDS)) return returningResponse({ t, user });
  if (hasAny(t, ABSENCE_WORDS)) return absenceResponse({ t, dates, today });

  // ---- 1d. Conditions that mean "run by effort, ignore the pace targets".
  const envKind = hasAny(t, ENV_TREADMILL) ? "treadmill"
    : hasAny(t, ENV_TRAIL) ? "trail"
    : hasAny(t, ENV_HEAT) ? "heat"
    : hasAny(t, ENV_COLD) ? "cold"
    : hasAny(t, ENV_NOGYM) ? "nogym" : null;
  if (envKind) return environmentResponse({ envKind, t, today, plan });

  // ---- 2a. Exercise-level changes. Checked early because "I can't do
  //          pull-ups" used to match the availability rules and silently block
  //          a whole training day.
  // "add 2 strength sessions with pull-ups on Tuesdays" names an exercise but
  // is a request for SESSIONS on named days. Weekdays plus a session noun mean
  // it belongs to the scheduling branch, not the exercise branch.
  const sessionScoped = detectWeekdays(t).length > 0 &&
    hasAny(t, [" session", " sessions", " workout", " workouts", " run", " runs", " day", " days"]);

  if (substitution || missingGear.length ||
      (!sessionScoped && exercises.length && hasAny(t, [" can't do", " cannot do", " can't manage",
        " hate ", " hurt my", " remove ", " drop the", " no more", " less ", " more ", " don't want",
        " do not want", " skip the", " take out", " get rid of", " add ", " include "]))) {
    return exerciseResponse({ t, exercises, missingGear, substitution, user });
  }

  // ---- 2b. Change the schedule itself (how often, how long).
  const sched = detectScheduleChange(t);
  if (sched) return scheduleResponse({ t, change: sched, user });

  // ---- 2b2. Resizing one specific session isn't something the plan models.
  //           Say so, and offer the two things that do work.
  if (hasAny(t, [" shorten", " lengthen", " make it shorter", " make it longer", " cut short"])) {
    const named = detectPlannedTypeLoose(t);
    return {
      intent: "resizeSession",
      reply: `I can't resize one session on its own — session length is a single setting across your plan, so changing it for the ${named ? (ADD_TYPE_LABEL[named] || named) : "session"} would change all of them.\n\nTwo things that do work: tell me "reduce the volume by 15%" and I'll trim everything proportionally, or "make my sessions 45 minutes" to reset the cap. If it's only this week, just do what you can and log it — I'd rather have the honest number.`,
      actions: [],
    };
  }

  // ---- 2c. Move or swap a specific session.
  const rearrange = detectRearrange(t, today, plan, adaptation);
  if (rearrange) return rearrange;

  // ---- 2d. Add or remove standing sessions. Checked before the "did something
  //          different" branch, because "add a run on Tuesdays" mentions an
  //          activity but is a schedule request, not a session report.
  // Named addWeekdays, not addDays — the latter is the imported date helper and
  // shadowing it put every later call into the temporal dead zone.
  const addWeekdays = detectWeekdays(t);
  if (hasAny(t, ADD_CUES) && (addWeekdays.length || detectAddType(t))) {
    return addSessionsResponse({ t, weekdays: addWeekdays, type: detectAddType(t), user, plan, adaptation });
  }
  if (hasAny(t, REMOVE_CUES) && addWeekdays.length) {
    return removeSessionsResponse({ t, weekdays: addWeekdays, user, plan });
  }

  // ---- 2e. "Did today's session" — the prescribed work, as written.
  if (hasAny(t, DONE_WORDS) && !minutes && !km && !hasAny(t, MISS_WORDS)) {
    return completedResponse({ t, dates, plan, user, today, todayKey });
  }

  // ---- 3. Did something other than what was prescribed.
  //         An activity plus a duration or distance is a session report on its
  //         own — it doesn't need "I did" in front of it.
  const didSomething = ((activity && (minutes || km)) || activity || minutes || km) &&
    (hasAny(t, [" instead", " rather than", " swapped", " ended up", " only did", " only managed",
                " just did", " did ", " ran ", " went ", " i did", " i ran", " managed"]) ||
     /\bi (ran|did|went|swam|cycled|biked|rowed|walked|lifted)\b/.test(t) ||
     (activity && (minutes || km)));

  if (didSomething && !hasAny(t, UNAVAILABLE_WORDS)) {
    return loggedDifferently({ t, dates, minutes, km, activity, plan, user, today, todayKey });
  }

  // ---- 4. Missed a session.
  if (hasAny(t, MISS_WORDS)) {
    return missedResponse({ t, dates, plan, user, today, todayKey });
  }

  // ---- 5. Not available on specific days.
  if (!exercises.length &&
      (hasAny(t, UNAVAILABLE_WORDS) || (dates.length && hasAny(t, [" can't", " cannot", " won't", " no "])))) {
    return unavailableResponse({ t, dates, plan, user, today, todayKey });
  }

  // ---- 5b. Explanations. Checked before the feel words, because "why is my
  //           easy pace so slow" contains "easy" and used to RAISE the load.
  if (/\bwhy\b|\bwhat's the point\b|\bwhat is the point\b|\bwhat's a\b|\bwhat is a\b|\bhow does\b/.test(t)) {
    const ex = explainResponse({ t, plan, adaptation });
    if (ex) return ex;
  }

  // ---- 5b2. Alcohol. Not a moral question — it genuinely blunts recovery, and
  //            saying so plainly is more useful than pretending otherwise.
  if (hasAny(t, ALCOHOL_WORDS)) {
    return {
      intent: "alcohol",
      reply: `Keep today easy — or take it off. No judgement, just physiology: alcohol wrecks the deep sleep where most of your adaptation happens, and dehydrates you on top, so a hard session today buys the fatigue without the fitness.\n\nAn easy run will make you feel better than sitting still will. Save the quality work for tomorrow, and drink more water than feels necessary.`,
      actions: [{ type: "softenDays", days: 1, reason: "post-drinking recovery" }],
    };
  }

  // ---- 5c. Sleep and life stress. Same load response as fatigue, but the
  //           reason matters and the advice is different.
  if (hasAny(t, SLEEP_STRESS)) return lifeLoadResponse({ t, user, adaptation });

  // ---- 5d. Progress questions.
  if (hasAny(t, PROGRESS_Q)) return progressResponse({ user, plan, adaptation });

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

// "train 5 times a week", "make my sessions 45 minutes"
function detectScheduleChange(t) {
  // "gym session done, 45 min" is a log, not an instruction to resize every
  // session. Reporting words disqualify the whole branch.
  if (hasAny(t, DONE_WORDS)) return null;

  const out = {};
  let m = t.match(/\b(\d)\s*(?:times|sessions|days|x)\s*(?:a|per)\s*week\b/);
  if (m) out.sessionsPerWeek = Math.max(2, Math.min(6, parseInt(m[1], 10)));

  // Changing session length needs an explicit imperative, not just the word
  // "session" sitting next to a number.
  const imperative = /\b(make|change|set|switch|move|shorten|lengthen|extend|reduce|cut)\s+(my|them|the|to|down|back)\b/.test(t)
    || /\bi\s+(want|need|'d like|would like)\b/.test(t);
  m = t.match(/\b(\d{2,3})\s*(?:min|mins|minute|minutes)\b/);
  if (m && imperative && hasAny(t, [" session", " sessions", " workout", " workouts", " training", " each", " them"])) {
    out.minutesPerSession = Math.max(20, Math.min(120, parseInt(m[1], 10)));
  }
  return Object.keys(out).length ? out : null;
}

function scheduleResponse({ t, change, user }) {
  const bits = [];
  if (change.sessionsPerWeek) bits.push(`${change.sessionsPerWeek} sessions a week`);
  if (change.minutesPerSession) bits.push(`${change.minutesPerSession} min each`);

  const now = user.schedule;
  const goingUp = change.sessionsPerWeek && change.sessionsPerWeek > now.sessionsPerWeek;

  let reply = `Schedule updated to ${bits.join(", ")}. The plan rebuilds around it from this week, and your logged history stays exactly as it is.`;
  if (goingUp) {
    reply += `\n\nGoing from ${now.sessionsPerWeek} to ${change.sessionsPerWeek} is a real jump in weekly load. Give it a fortnight before judging it, and tell me if it's too much — I'd rather pull it back than have you miss sessions.`;
  } else if (change.sessionsPerWeek && change.sessionsPerWeek < now.sessionsPerWeek) {
    reply += `\n\nFewer sessions you actually complete beats more that you don't. This is usually the right call, not a retreat.`;
  }
  return { intent: "scheduleChange", reply, actions: [{ type: "setSchedule", change }] };
}

// "move my long run to Sunday", "swap Tuesday and Thursday"
function detectRearrange(t, today, plan, adaptation) {
  const wds = detectWeekdays(t);
  const wk = plan.weeks.find((w) => w.num === adaptation.currentWeek) || plan.weeks[0];
  if (!wk) return null;

  // Swap two named days.
  if (hasAny(t, [" swap ", " switch ", " exchange "]) && wds.length === 2 && !detectSubstitution(t)) {
    const a = wk.days.find((d) => d.weekdayIndex === wds[0]);
    const b = wk.days.find((d) => d.weekdayIndex === wds[1]);
    if (!a || !b) return null;
    return {
      intent: "swapDays",
      reply: `Swapped ${WEEKDAYS[wds[0]]} and ${WEEKDAYS[wds[1]]} this week — ${a.session ? a.session.label.toLowerCase() : "the rest day"} and ${b.session ? b.session.label.toLowerCase() : "the rest day"} change places.`,
      actions: [{ type: "swapDays", a: a.dateKey, b: b.dateKey }],
    };
  }

  // Move a named session to a named day.
  if (hasAny(t, [" move ", " shift ", " put the", " do the"]) && wds.length === 1) {
    const type = detectAddType(t) || detectPlannedTypeLoose(t);
    if (!type) return null;
    const src = wk.days.find((d) => d.session && d.session.type === type);
    const dst = wk.days.find((d) => d.weekdayIndex === wds[0]);
    if (!src || !dst) {
      return {
        intent: "move",
        reply: `I couldn't find a ${ADD_TYPE_LABEL[type] || type} session in this week to move. Check the Week tab and tell me the day it's on.`,
        actions: [],
      };
    }
    if (dst.session) {
      return {
        intent: "move",
        reply: `${WEEKDAYS[wds[0]]} already has ${dst.session.label.toLowerCase()} on it, and I won't stack two sessions on one day. Tell me which day to clear and I'll move both.`,
        actions: [],
      };
    }
    return {
      intent: "move",
      reply: `Moved the ${src.session.label.toLowerCase()} to ${WEEKDAYS[wds[0]]}.`,
      actions: [{ type: "moveSession", from: src.dateKey, to: dst.dateKey }],
    };
  }
  return null;
}

// Looser than detectPlannedType: doesn't require a substitution cue.
function detectPlannedTypeLoose(t) {
  for (const p of PLANNED_TYPE_WORDS) if (hasAny(t, p.words.map((w) => ` ${w}`))) return p.key;
  return null;
}

function exerciseResponse({ t, exercises, missingGear, substitution, user }) {
  const rules = { ...(user.coachOverrides?.exerciseRules || {}) };
  const actions = [];
  let reply = "";

  if (missingGear.length) {
    rules.noGear = [...new Set([...(rules.noGear || []), ...missingGear])];
    const names = { bar: "pull-up bar", band: "resistance band", step: "bench or step", mat: "mat" };
    reply = `Noted — no ${missingGear.map((g) => names[g]).join(" or ")}. I've dropped every movement that needs it and the plan will pick alternatives that don't.`;
    actions.push({ type: "setExerciseRules", rules });
  }

  else if (substitution) {
    rules.substitute = { ...(rules.substitute || {}), [substitution.from]: substitution.to };
    reply = `Swapped ${substitution.from} for ${substitution.to} wherever it comes up. Match the sets and reps the plan gives you — the point of the slot is the movement pattern, not the exact exercise.`;
    actions.push({ type: "setExerciseRules", rules });
  }

  else if (hasAny(t, [" can't do", " cannot do", " can't manage", " hurt my", " remove ", " drop the",
                      " no more", " don't want", " do not want", " skip the", " take out",
                      " get rid of", " less ", " hate "])) {
    rules.exclude = [...new Set([...(rules.exclude || []), ...exercises])];
    reply = `Taken ${exercises.join(" and ")} out of your plan. The slot stays — you'll get a different movement working the same thing, so nothing goes missing.`;
    if (exercises.some((e) => /pull-up|chin/.test(e))) {
      reply += `\n\nIf it's strength rather than preference, band-assisted pull-ups and slow negatives from the top are how people get their first one. Say the word and I'll put those in instead.`;
    }
    actions.push({ type: "setExerciseRules", rules });
  }

  else if (hasAny(t, [" more ", " add ", " include "])) {
    rules.emphasis = [...new Set([...(rules.emphasis || []), ...exercises])];
    reply = `Added more ${exercises.join(" and ")} work to your strength sessions.`;
    actions.push({ type: "setExerciseRules", rules });
  }

  else {
    return {
      intent: "unknown",
      reply: `I got that you're talking about ${exercises.join(" and ")}, but not what you want done. Try "replace pull-ups with dips", "remove burpees", or "I don't have a pull-up bar".`,
      actions: [],
    };
  }

  return { intent: "exerciseRules", reply, actions };
}

function completedResponse({ t, dates, plan, user, today, todayKey }) {
  let key = dates[0] || todayKey;

  // "did the intervals" names the session rather than the day — find it.
  const named = detectPlannedTypeLoose(t);
  if (!dates.length && named) {
    const onToday = sessionOn(plan, todayKey);
    if (onToday?.day?.session?.type !== named) {
      const wk = plan.weeks.find((w) => w.days.some((d) => d.dateKey === todayKey));
      const match = wk?.days.find((d) => d.session && d.session.type === named);
      if (match) key = match.dateKey;
    }
  }

  const found = sessionOn(plan, key);
  if (!found || found.day.isRest) {
    return {
      intent: "completed",
      reply: `Nothing was scheduled for ${prettyShort(key).toLowerCase()}, so there's nothing to tick off.`,
      actions: [],
    };
  }
  const s = found.day.session;
  let rpe = s.targetRpe;
  if (hasAny(t, BAD_FEEL)) rpe = Math.min(10, rpe + 2);
  else if (hasAny(t, GOOD_FEEL)) rpe = Math.max(1, rpe - 1);

  return {
    intent: "completed",
    reply: `Logged ${prettyShort(key).toLowerCase()}'s ${s.label.toLowerCase()} as done at RPE ${rpe}. ${hasAny(t, GOOD_FEEL) ? "Good — that's the plan working." : "That's this week moving."}`,
    actions: [{
      type: "logActual",
      dateKey: key,
      session: { type: s.type, minutes: s.minutes, rpe, plannedRpe: s.targetRpe, label: s.label, note: "" },
    }],
  };
}

function illnessResponse({ t, systemic, mild, today }) {
  // The above-the-neck rule: symptoms confined to the head are usually fine to
  // train lightly through; anything systemic is not. Training through a fever
  // is how people end up with weeks off instead of days.
  if (systemic) {
    const until = dateKey(addDays(today, 3));
    return {
      intent: "illness",
      reply: `No training while that's going on. I've cleared the next three days.\n\nThe rule I'd hold you to is the neck check: symptoms above the neck — a blocked nose, a mild sore throat — are usually fine to train lightly through. A fever, chest symptoms, aching all over or anything in your stomach are not. Training through those doesn't just cost you the session, it drags the illness out and occasionally does real damage to your heart.\n\nWhen you're symptom-free for a full day, tell me you're better and I'll bring you back gradually — you'll want to go straight back to normal volume and that's exactly what not to do.`,
      actions: [{ type: "setIllness", level: "systemic", until }],
    };
  }
  const until = dateKey(addDays(today, 2));
  return {
    intent: "illness",
    reply: `A head cold on its own doesn't have to stop you, but the hard sessions have to go. For the next couple of days everything drops to easy effort — the interval and tempo work is off.\n\nIf it moves to your chest, you get a temperature, or you start aching all over, stop entirely and tell me. Tell me when you're better and I'll build you back up.`,
    actions: [{ type: "setIllness", level: "mild", until }],
  };
}

function recoveredResponse({ user }) {
  return {
    intent: "recovered",
    reply: `Good. I've lifted the illness block and put you back at 80% volume for a few days rather than straight back to full — the first sessions back always feel harder than they should, and that's normal rather than a sign you've lost everything.\n\nIf a session feels much worse than the number on it, stop and tell me. Coming back too fast is the most common way a week off becomes three.`,
    actions: [{ type: "clearIllness" }, { type: "setLoad", factor: 0.8, reason: "returning from illness" }],
  };
}

function raceResponse({ t, dates, today, plan, adaptation }) {
  const spanDays = parseSpanDays(t);
  const key = dates[0] || (spanDays ? dateKey(addDays(today, spanDays)) : null);
  if (!key) {
    return {
      intent: "race",
      reply: `Happy to build that in — when is it? Give me a day ("parkrun on Saturday") or a distance out ("a 10k in three weeks") and I'll taper you into it.`,
      actions: [],
    };
  }
  const km = detectDistanceKm(t);
  const isParkrun = hasAny(t, [" parkrun", " park run"]);
  const meters = isParkrun ? 5000 : km ? Math.round(km * 1000) : 5000;
  const label = isParkrun ? "parkrun" : `${meters / 1000}K race`;
  const daysOut = Math.round((parseDateKey(key) - today) / 86400000);

  let reply = `${label.charAt(0).toUpperCase() + label.slice(1)} on ${prettyDate(key)} — in. The day before drops to easy or rest, and the day after is recovery only.`;
  if (daysOut >= 10) {
    reply += ` It's far enough out that the block carries on as normal until the last few days, so treat it as a hard workout with a number attached rather than a goal race.`;
  } else {
    reply += ` It's close, so I've kept the days around it light rather than trying to squeeze a hard session in.`;
  }
  reply += `\n\nTell me the time afterwards and I'll use it the way I'd use a test — it recalculates every pace in your plan.`;

  return { intent: "race", reply, actions: [{ type: "addRace", dateKey: key, meters, label }] };
}

function absenceResponse({ t, dates, today }) {
  const days = parseSpanDays(t) || 7;
  const from = dates[0] ? parseDateKey(dates[0]) : today;
  const list = [];
  for (let i = 0; i < Math.min(days, 60); i++) list.push(dateKey(addDays(from, i)));

  const weeks = Math.round(days / 7);
  let reply = `Blocked out ${days} days from ${prettyDate(dateKey(from))}. Nothing is scheduled in that window and it won't count against your adherence.`;
  if (weeks >= 3) {
    reply += `\n\n${weeks} weeks is long enough that you'll lose some fitness — that's just true, and pretending otherwise would set you up to get hurt on the way back. Tell me when you're back and I'll rebuild you rather than dropping you into where the plan thinks you should be.`;
  } else {
    reply += `\n\nA week or two off costs far less than people fear. If you can get a couple of easy runs in, good; if not, the plan will be there.`;
  }
  return { intent: "absence", reply, actions: [{ type: "blockDates", dates: list, reason: "away" }] };
}

function returningResponse({ t, user }) {
  const days = parseSpanDays(t) || 14;
  const weeks = Math.max(1, Math.round(days / 7));
  const factor = weeks >= 4 ? 0.6 : weeks >= 2 ? 0.72 : 0.85;
  return {
    intent: "returning",
    reply: `Welcome back. After ${weeks} week${weeks === 1 ? "" : "s"} off I've put you at ${Math.round(factor * 100)}% volume, and I'd hold you there for a fortnight before pushing.\n\nYour engine comes back within a couple of weeks; tendons and bone take considerably longer, and they're what actually breaks when people resume at the volume they left at. Expect the first few sessions to feel much worse than the numbers suggest — that's normal and it passes quickly.\n\nWhen it stops feeling like a fight, tell me and I'll put the volume back.`,
    actions: [{ type: "setLoad", factor, reason: `returning after ${weeks} weeks off` }],
  };
}

function environmentResponse({ envKind, t, today, plan }) {
  const until = dateKey(addDays(today, 7));
  const copy = {
    treadmill: `Treadmill it is. Ignore the pace targets and run to effort — a treadmill's pace readout is its own opinion, and 1% incline roughly offsets the lack of air resistance if you want to match outdoor effort.`,
    trail: `Trails — run to effort and ignore the pace targets completely. Hills and uneven ground make the same effort far slower, and chasing a road pace off-road is how people end up hammering an easy day.`,
    heat: `In that heat, effort is the only number that means anything. Expect to be 20–40 sec/km slower for the same effort, and treat that as correct rather than as a bad day. Start slower than feels right, and if a hard session falls apart, bin it rather than fighting it.`,
    cold: `On ice, forget the paces and the session structure — getting round safely is the whole objective. Shorten your stride, and if it's genuinely treacherous, move the session indoors or take the day.`,
    nogym: `No gym, no problem — every strength session in your plan is already bodyweight-first, with a band or a step as the only optional extras. Nothing is lost.`,
  };
  const actions = envKind === "nogym" ? [] : [{ type: "setEffortOnly", until, reason: envKind }];
  return { intent: "environment", reply: copy[envKind], actions };
}

function lifeLoadResponse({ t, user, adaptation }) {
  const current = user.coachOverrides?.loadFactor ?? 1;
  const next = Math.max(0.7, Math.round((current - 0.12) * 100) / 100);
  const isSleep = hasAny(t, [" slept", " sleep", " insomnia"]);
  return {
    intent: "lifeLoad",
    reply: isSleep
      ? `Volume down to ${Math.round(next * 100)}% while sleep is bad.\n\nSleep is where training actually turns into fitness, so a hard session on four hours buys you the fatigue without the adaptation. If you only get one thing right this week, make it the easy days being genuinely easy — and if you have to choose between a session and an hour in bed, take the bed.`
      : `Volume down to ${Math.round(next * 100)}% while things are heavy.\n\nYour body doesn't distinguish between training stress and life stress — it's one bucket, and a hard block during a hard month is how people get ill rather than fit. Training less right now isn't losing ground; it's the reason you'll still be doing this in a month.`,
    actions: [{ type: "setLoad", factor: next, reason: isSleep ? "poor sleep" : "life stress" }],
  };
}

function progressResponse({ user, plan, adaptation }) {
  const f = adaptation.fitness;
  const start = f.timeline[0]?.vdot ?? f.vdot;
  const delta = f.vdot - start;
  const logged = Object.values(user.logs || {}).filter((l) => l.done).length;
  const tests = Object.values(user.tests || {}).filter((x) => x.seconds);

  let reply = `You've logged ${logged} session${logged === 1 ? "" : "s"} and you're in week ${adaptation.currentWeek} of ${plan.totalWeeks}.\n\n`;

  if (tests.length >= 2) {
    const first = tests[0], last = tests[tests.length - 1];
    if (first.meters === last.meters) {
      const gain = first.seconds - last.seconds;
      reply += gain > 0
        ? `Measured: ${formatDuration(gain)} faster over ${last.meters / 1000}K between your first test and your last. That's real, not an estimate.`
        : `Measured: your last test was ${formatDuration(-gain)} slower than your first. One test is a bad day; two in a row is a pattern worth acting on.`;
    } else {
      reply += `You've got ${tests.length} measured results in. Your fitness score sits at ${f.vdot.toFixed(1)}.`;
    }
  } else if (tests.length === 1) {
    reply += `One measured result so far, and your fitness sits at ${f.vdot.toFixed(1)}. Your next test week is the one that will tell you whether the block worked.`;
  } else {
    reply += `Nothing measured yet, so ${f.vdot.toFixed(1)} is still an estimate off your training. Your first test week turns that into a real number.`;
  }

  reply += `\n\n${delta > 0.5
    ? `The estimate has moved up ${delta.toFixed(1)} points since you started, which is what consistent weeks look like.`
    : delta < -0.5
      ? `The estimate has drifted down ${Math.abs(delta).toFixed(1)} points — that's missed sessions rather than lost ability, and it comes back quickly.`
      : `It's held steady, which early in a block is normal — fitness lags training by a few weeks.`}`;

  if (plan.paces) {
    reply += `\n\nEasy ${formatPace(plan.paces.easy)} · tempo ${formatPace(plan.paces.threshold)} · intervals ${formatPace(plan.paces.interval)}.`;
  }
  return { intent: "progress", reply, actions: [] };
}

function addSessionsResponse({ t, weekdays, type, user, plan, adaptation }) {
  if (!weekdays.length) {
    return {
      intent: "addSession",
      reply: `Happy to add that — which days? Tell me like "add an upper body session on Tuesdays and Thursdays" and I'll put it in every week.`,
      actions: [],
    };
  }
  const kind = type || "full";
  const label = ADD_TYPE_LABEL[kind];
  const commitments = user.schedule.commitments || {};
  const existing = (user.coachOverrides?.extraSessions || []);

  const added = [], clashCommit = [], clashPlan = [], already = [], doubled = [];
  for (const wd of weekdays) {
    if (existing.some((e) => e.weekday === wd)) { already.push(wd); continue; }
    if (commitments[wd] && commitments[wd].load === "hard") { clashCommit.push(wd); continue; }
    // A day that already has a session is fine for strength, mobility or
    // conditioning — doubling those up with a run is standard practice and
    // actually protects the easy/hard split. A second RUNNING session is not.
    const wk = plan.weeks.find((w) => w.num === adaptation.currentWeek) || plan.weeks[0];
    const day = wk?.days.find((d) => d.weekdayIndex === wd);
    const stackable = ["upper", "lower", "full", "mobility", "conditioning"].includes(kind);
    if (day && !day.isRest && !stackable) { clashPlan.push(wd); continue; }
    if (day && !day.isRest) doubled.push(wd);
    added.push(wd);
  }

  const actions = added.length
    ? [{ type: "addRecurringSessions", weekdays: added, sessionType: kind }]
    : [];

  const dayNames = (list) => list.map((i) => `${WEEKDAYS[i]}s`).join(" and ");
  // "every Tuesday and Thursday", not "every Tuesdays and Thursdays".
  const dayNamesEach = (list) => list.map((i) => WEEKDAYS[i]).join(" and ");
  const article = /^[aeiou]/i.test(label) ? "an" : "a";
  let reply = "";

  if (added.length) {
    reply = `Added ${article} ${label} session every ${dayNamesEach(added)}. It'll show up from this week on, and repeats until you tell me otherwise.`;
    if (kind === "upper") {
      reply += ` Pull-ups are in there — the plan gives you an easier version (inverted rows, band rows) and a harder one, so pick whichever you can hold form on.`;
    }
    reply += ` On test weeks I'll leave the time-trial day clear — nothing goes near a max effort, because that result resets every pace in your plan.`;
  }
  if (already.length) reply += `${reply ? " " : ""}You already had one on ${dayNames(already)}, so I left that alone.`;
  if (clashCommit.length) reply += `${reply ? " " : ""}${dayNames(clashCommit)} is marked as a hard commitment, so I've left it clear — that day is already loaded.`;
  if (doubled.length) reply += `${reply ? " " : ""}${dayNames(doubled)} already had a session, so this goes alongside it as a second piece of work that day — strength on a running day is fine, and keeps your easy days easy.`;
  if (clashPlan.length) reply += `${reply ? " " : ""}${dayNames(clashPlan)} already has a running session, so I didn't stack a second run on top. Move the existing one first if you want it there.`;

  const totalPerWeek = user.schedule.sessionsPerWeek + existing.length + added.length;
  if (added.length && totalPerWeek >= 6) {
    reply += `\n\nThat puts you at ${totalPerWeek} sessions a week. That's a lot of training days — watch how the next fortnight feels, and tell me if it's too much.`;
  } else if (added.length) {
    reply += `\n\nThese sit on top of your ${user.schedule.sessionsPerWeek} planned sessions, so you're now at ${totalPerWeek} a week.`;
  }

  return { intent: "addSession", reply: reply.trim(), actions };
}

function removeSessionsResponse({ t, weekdays, user, plan }) {
  const existing = user.coachOverrides?.extraSessions || [];
  const hit = existing.filter((e) => weekdays.includes(e.weekday));
  if (!hit.length) {
    return {
      intent: "removeSession",
      reply: `There's no session I added on ${weekdays.map((i) => `${WEEKDAYS[i]}s`).join(" or ")}. If you mean one from the original plan, tell me you can't train that day and I'll move it instead.`,
      actions: [],
    };
  }
  return {
    intent: "removeSession",
    reply: `Removed the ${hit.map((e) => ADD_TYPE_LABEL[e.type] || "extra").join(" and ")} session on ${hit.map((e) => `${WEEKDAYS[e.weekday]}s`).join(" and ")}. Back to your planned schedule on those days.`,
    actions: [{ type: "removeRecurringSessions", weekdays: hit.map((e) => e.weekday) }],
  };
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

  // One message can describe several sessions. Parse each clause separately so
  // "tennis for an hour and a 50 min run" doesn't collapse into one 60 min run.
  const segs = detectActivitySegments(t);
  const pace = detectPace(t);

  const pieces = segs.map((sg) => {
    let m = sg.minutes;
    if (!m && sg.km) m = Math.round(sg.km * (plan.paces ? plan.paces.easy / 60 : 6));
    return { activity: sg.activity, word: sg.word, minutes: m, km: sg.km };
  }).filter((x) => x.activity || x.minutes || x.km);

  const describe = (x) => {
    const bits = [];
    if (x.km) bits.push(`${x.km % 1 === 0 ? x.km : x.km.toFixed(1)} km`);
    if (x.minutes) bits.push(`${x.minutes} min`);
    // Named sports keep their own name; everything else uses the generic label.
    const name = x.activity === "sport" && x.word ? x.word : (ACTIVITY_LABEL[x.activity] || "session");
    return `${bits.join(", ")} ${name}`.trim();
  };

  let mins, desc, multi = false;
  if (pieces.length > 1) {
    multi = true;
    mins = pieces.reduce((sum, x) => sum + (x.minutes || 0), 0);
    desc = pieces.map(describe).join(" + ");
  } else {
    const only = pieces[0] || { activity, minutes, km };
    mins = only.minutes || (only.km ? Math.round(only.km * (plan.paces ? plan.paces.easy / 60 : 6)) : null) || planned?.minutes || 40;
    desc = describe({ ...only, minutes: mins });
  }

  // The type recorded is whichever piece matches the planned session, so the
  // plan sees the prescribed work as done rather than as a substitution.
  const types = pieces.map((x) => x.activity).filter(Boolean);
  const primary = (planned && types.includes("run") && ["easy", "long", "intervals", "tempo", "cardio"].includes(planned.type))
    ? "run"
    : (types[0] || activity || "other");

  // A measured maximal effort is worth as much as a test week — it should reset
  // the paces, not just sit in the log.
  const raceTime = detectClockTime(t);
  const raceKm = pieces.find((x) => x.km)?.km || km;
  const isRace = hasAny(t, RACE_MARKERS) && raceTime && raceKm && raceKm >= 1.5;

  const actions = [{
    type: "logActual",
    dateKey: key,
    session: {
      type: primary,
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

  if (multi) {
    reply += ` That's ${mins} min of work across ${pieces.length} sessions.`;
  }

  // Built here, appended after the substitution note so the reply reads in order.
  let paceNote = "";
  if (pace && plan.paces) {
    const delta = pace.secPerKm - plan.paces.easy;
    if (delta < -45) {
      paceNote = `\n\nAt ${formatPace(pace.secPerKm)} that was quicker than your easy pace of ${formatPace(plan.paces.easy)}. Easy runs done at tempo effort are the most common way to arrive at the hard sessions already tired — there's no prize for a fast easy run.`;
    } else if (delta > 60) {
      paceNote = `\n\nAt ${formatPace(pace.secPerKm)} that was comfortably inside your easy pace. Exactly right.`;
    } else {
      paceNote = `\n\n${formatPace(pace.secPerKm)} is right around your easy pace of ${formatPace(plan.paces.easy)}. Good.`;
    }
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

  if (isRace) {
    actions.push({ type: "recordResult", seconds: raceTime, meters: Math.round(raceKm * 1000) });
    const newVdot = vdotFromRace(raceTime, raceKm * 1000);
    const oldVdot = plan.vdot;
    reply += `\n\nThat's a measured effort, so I've used it the way I'd use a test: your fitness moves from ${oldVdot ? oldVdot.toFixed(1) : "estimated"} to ${newVdot.toFixed(1)}, and every training pace recalculates off it.`;
    if (oldVdot && newVdot > oldVdot) {
      reply += ` Your easy runs will get slightly quicker — resist the urge to run them quicker still.`;
    } else if (oldVdot && newVdot < oldVdot - 1) {
      reply += ` That's below what you'd been training at. One flat day isn't a trend, so I've taken the number at face value rather than reading anything into it.`;
    }
  }

  return { intent: "logActual", reply: reply + paceNote, actions };
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
  // If they named a number, use it rather than the default step.
  const pct = t.match(/\b(\d{1,2})\s*%/);
  const step = pct ? Math.min(0.3, parseInt(pct[1], 10) / 100) : 0.12;
  const next = Math.max(0.7, Math.round((current - step) * 100) / 100);
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
  const pct = t.match(/\b(\d{1,2})\s*%/);
  const step = pct ? Math.min(0.15, parseInt(pct[1], 10) / 100) : 0.08;
  const next = Math.min(1.15, Math.round((current + step) * 100) / 100);
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

function explainResponse({ t, plan, adaptation }) {
  const easy = plan.paces ? formatPace(plan.paces.easy) : null;

  if (hasAny(t, [" easy pace", " easy runs", " so slow", " too slow", " easy so"])) {
    return {
      intent: "explain",
      reply: `Because easy runs aren't training your speed — they're building the aerobic base that lets you survive the hard sessions.${easy ? ` Yours is ${easy}.` : ""}\n\nRun them at 80% effort and you get a session that's too hard to recover from and too easy to drive adaptation: the worst of both. The discipline of going genuinely slow on easy days is what makes the interval days possible. It should feel almost embarrassingly comfortable.`,
      actions: [],
    };
  }
  if (hasAny(t, [" intervals", " interval session", " reps"])) {
    return {
      intent: "explain",
      reply: `Intervals raise the ceiling. Short hard efforts with recovery let you accumulate far more time near your maximum than one continuous hard run ever could — that's what lifts your top-end fitness.\n\nThey only work if you arrive fresh, which is why the surrounding days are easy. Hard days hard, easy days easy; the whole plan hangs off that split.`,
      actions: [],
    };
  }
  if (hasAny(t, [" deload", " down week", " easy week"])) {
    return {
      intent: "explain",
      reply: `A deload is a deliberate cut in volume every fourth week. You don't get fitter during training — you get fitter recovering from it, and the gains you've built land during the lighter week.\n\nSkipping it feels productive and reliably backfires: the following block is where you'd have made the progress, and you arrive at it already tired.`,
      actions: [],
    };
  }
  if (hasAny(t, [" this session", " today's session", " the point of"])) {
    const found = plan.weeks.flatMap((w) => w.days).find((d) => d.dateKey === dateKey(new Date()));
    if (found?.session) {
      return {
        intent: "explain",
        reply: `Today is ${found.session.label} at RPE ${found.session.targetRpe}. ${found.session.targetRpe >= 8 ? "It's one of the two hard sessions this week — the ones that actually move your fitness." : found.session.targetRpe <= 4 ? "It's an easy day. Its job is recovery and aerobic volume, not to make you tired." : "It's a moderate session building sustainable pace."}\n\nThe full breakdown is on the Today tab.`,
        actions: [],
      };
    }
  }
  return null;
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
