// Peak — UI, persistence, and wiring.
// Cache-busting: bump ?v= here and in index.html on every deploy that changes
// app.js, plan-engine.js, workouts.js, or style.css.

import { firebaseConfig } from "./firebase-config.js?v=25";
import {
  WORKOUT_FREQ, CARDIO_FREQ, RUN_DURATION, INJURY_FOCUS_LABELS,
  WEEKDAYS, WEEKDAYS_SHORT, COMMITMENT_LOADS, SESSION_COUNTS, SESSION_MINUTES,
  GOAL_TYPES, EVENTS, FITNESS_TARGETS,
  dateKey, parseDateKey, addDays, mondayOnOrBefore,
  formatDuration, formatPace, paceToMile, parseTimeToSeconds,
  buildPlan, getWeek, getDayForDate, computeAdaptation, goalAssessment,
  feasibilityReport, deriveFitness, pruneCoachOverrides,
} from "./plan-engine.js?v=25";
import { RPE_SCALE, GEAR_LABELS } from "./workouts.js?v=25";
import { coachRespond } from "./coach.js?v=25";

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getAuth, onAuthStateChanged, signInWithPopup, GoogleAuthProvider,
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
  sendPasswordResetEmail, setPersistence, browserLocalPersistence,
  sendEmailVerification,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// Demo mode: add ?demo=1 to the URL to run the whole app against localStorage
// instead of Firestore. Useful for trying it before wiring Firebase up, and for
// the test harness. Nothing in demo mode leaves the browser.
const DEMO = new URLSearchParams(location.search).has("demo");
const DEMO_KEY = "peakDemoData";

let db = null, auth = null;
if (!DEMO) {
  const firebaseApp = initializeApp(firebaseConfig);
  db = getFirestore(firebaseApp);
  auth = getAuth(firebaseApp);
}

// Demo mode needs a stand-in identity; real mode uses the Firebase Auth uid and
// never invents one.
const DEMO_UID_KEY = "peakDemoUid";
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

let user = null;
let plan = null;
let adaptation = null;
let viewedWeek = null;

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str == null ? "" : String(str);
  return d.innerHTML;
}

// ---------------------------------------------------------------- persistence

// The document ID is always the authenticated uid. Nothing is derived from the
// user's name, so documents can't be guessed, and the Firestore rules can pin
// every read and write to request.auth.uid.
function currentUid() {
  if (DEMO) return localStorage.getItem(DEMO_UID_KEY);
  return auth?.currentUser?.uid || null;
}

function demoRead() {
  try { return JSON.parse(localStorage.getItem(DEMO_KEY) || "{}"); } catch { return {}; }
}
function demoWrite(all) { localStorage.setItem(DEMO_KEY, JSON.stringify(all)); }

async function fetchUser(id) {
  if (DEMO) {
    const all = demoRead();
    return all[id] ? { id, ...all[id] } : null;
  }
  const snap = await getDoc(doc(db, "users", id));
  return snap.exists() ? { id, ...snap.data() } : null;
}

async function createUser(data) {
  const id = currentUid();
  if (!id) throw new Error("Not signed in");
  const payload = {
    ...data,
    logs: {},
    tests: {},
    // Sessions-per-week can change mid-plan; this keeps past adherence honest.
    scheduleHistory: [{ fromWeek: 1, sessionsPerWeek: data.schedule.sessionsPerWeek }],
    changeLog: [],
    createdAt: Date.now(),
  };
  if (DEMO) {
    const all = demoRead();
    all[id] = payload;
    demoWrite(all);
  } else {
    await setDoc(doc(db, "users", id), payload);
  }
  return { id, ...payload };
}

// Writes a single dotted field path ("logs.2026-08-26") in whichever backend is active.
async function persistField(path, value) {
  if (DEMO) {
    const all = demoRead();
    const [top, key] = path.split(".");
    if (!all[user.id]) return;
    all[user.id][top] = all[user.id][top] || {};
    all[user.id][top][key] = value;
    demoWrite(all);
    return;
  }
  await updateDoc(doc(db, "users", user.id), { [path]: value });
}

// Writes whole top-level fields (goal, schedule, profile, fitness, …).
async function persistDoc(fields) {
  if (DEMO) {
    const all = demoRead();
    const id = currentUid();
    if (!all[id]) return;
    Object.assign(all[id], fields);
    demoWrite(all);
    return;
  }
  await updateDoc(doc(db, "users", currentUid()), fields);
}

// The fitness number is derived from logs and tests on every load — this just
// mirrors the current value into the document so it exists in the backend and
// can be read without replaying the whole history. Derivation always wins, so
// a stale stored value can never poison the plan.
async function persistFitness() {
  if (!user || !adaptation?.fitness) return;
  const f = adaptation.fitness;
  const stored = user.fitness;
  if (stored && Math.abs(stored.vdot - f.vdot) < 0.05 && stored.anchor === f.anchor) return;
  const snapshot = {
    vdot: Number(f.vdot.toFixed(2)),
    anchor: f.anchor,
    confidence: f.confidence,
    lastTestWeek: f.lastTestWeek,
    updatedAt: Date.now(),
  };
  user.fitness = snapshot;
  try {
    await persistDoc({ fitness: snapshot });
  } catch (e) {
    // Never block the UI on this — it is a mirror, not the source of truth.
    console.error("Couldn't persist fitness snapshot", e);
  }
}

async function saveLog(key, entry) {
  user.logs = user.logs || {};
  user.logs[key] = entry;
  await persistField(`logs.${key}`, entry);
}

async function saveTest(weekNum, result) {
  user.tests = user.tests || {};
  user.tests[weekNum] = result;
  await persistField(`tests.${weekNum}`, result);
}

// Recompute adaptation and plan from whatever is currently stored.
function rebuild() {
  adaptation = computeAdaptation(user);
  plan = buildPlan(user, adaptation);
}

// ---------------------------------------------------------------- auth screen

const AUTH_ERRORS = {
  "auth/invalid-email": "That doesn't look like a valid email address.",
  "auth/user-disabled": "This account has been disabled.",
  "auth/user-not-found": "No account with that email. Create one below.",
  "auth/wrong-password": "Wrong password.",
  "auth/invalid-credential": "Email or password is incorrect.",
  "auth/email-already-in-use": "An account already exists for that email. Sign in instead.",
  "auth/weak-password": "Password needs to be at least 6 characters.",
  "auth/popup-closed-by-user": "Sign-in window was closed before finishing.",
  "auth/popup-blocked": "Your browser blocked the sign-in popup. Allow popups for this site, or use email and password.",
  "auth/operation-not-allowed": "That sign-in method isn't enabled in the Firebase console yet — see the README.",
  "auth/network-request-failed": "Couldn't reach Firebase. Check your connection.",
  "auth/too-many-requests": "Too many attempts. Wait a minute and try again.",
  "auth/requires-recent-login": "For security, sign in again before doing that.",
};

// Never surface a raw exception to the user: internal messages are noise at
// best and leak implementation detail at worst. Map what we recognise, log the
// rest, and say something plain.
function authErrorMessage(e) {
  console.error(e);
  if (e?.code && AUTH_ERRORS[e.code]) return AUTH_ERRORS[e.code];
  if (/api-key|invalid-api/i.test(e?.code || e?.message || "")) {
    return "Firebase rejected the API key in firebase-config.js. Copy the config again from the Firebase console (see README).";
  }
  if (typeof e?.code === "string" && e.code.startsWith("auth/")) {
    return "That didn't work. Check your details and try again.";
  }
  return "Something went wrong. Try again in a moment.";
}

let authMode = "signin"; // or "signup"

function renderAuth() {
  const isSignup = authMode === "signup";
  $("#view-auth").innerHTML = `
    <div class="card hero-card">
      <p class="eyebrow">Peak</p>
      <h1>${isSignup ? "Create your account" : "Sign in"}</h1>
      <p class="muted">Your training plan, paces, and logged sessions are private to your account and sync to any device you sign in on.</p>
    </div>

    <div class="card">
      <button type="button" id="btn-google" class="btn btn-ghost btn-block btn-google">
        <span class="g-mark" aria-hidden="true">G</span> Continue with Google
      </button>

      <div class="divider"><span>or</span></div>

      <form id="auth-form" autocomplete="on">
        <label for="a-email">Email</label>
        <input type="email" id="a-email" autocomplete="email" required placeholder="you@example.com" />

        <label for="a-pass">Password</label>
        <input type="password" id="a-pass" autocomplete="${isSignup ? "new-password" : "current-password"}" required
               minlength="6" placeholder="${isSignup ? "At least 6 characters" : ""}" />

        <div id="auth-error" class="error-box hidden"></div>

        <button type="submit" id="btn-auth" class="btn btn-primary btn-block" style="margin-top:18px;">
          ${isSignup ? "Create account" : "Sign in"}
        </button>
      </form>

      <div class="auth-links">
        <button type="button" id="btn-toggle-mode" class="linkish">
          ${isSignup ? "Already have an account? Sign in" : "No account? Create one"}
        </button>
        ${isSignup ? "" : `<button type="button" id="btn-reset-pass" class="linkish">Forgot password?</button>`}
      </div>
    </div>

    <p class="muted legal-note">
      Peak stores only what you enter here: your training answers, logged sessions, and test results.
      No location, no health-app data, nothing shared with anyone.
    </p>
  `;

  const err = $("#auth-error");
  const showErr = (e) => {
    err.classList.remove("info-box");
    err.textContent = authErrorMessage(e);
    err.classList.remove("hidden");
  };
  const busy = (on, label) => {
    $("#btn-auth").disabled = on;
    $("#btn-google").disabled = on;
    if (label) $("#btn-auth").textContent = label;
  };

  $("#btn-google").addEventListener("click", async () => {
    err.classList.add("hidden");
    busy(true);
    try {
      await setPersistence(auth, browserLocalPersistence);
      await signInWithPopup(auth, new GoogleAuthProvider());
      // onAuthStateChanged takes it from here.
    } catch (e) {
      showErr(e);
      busy(false);
    }
  });

  $("#auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    err.classList.add("hidden");
    const email = $("#a-email").value.trim();
    const pass = $("#a-pass").value;
    busy(true, isSignup ? "Creating…" : "Signing in…");
    try {
      await setPersistence(auth, browserLocalPersistence);
      if (isSignup) {
        const cred = await createUserWithEmailAndPassword(auth, email, pass);
        await sendEmailVerification(cred.user);
        lastVerificationSent = Date.now();
      } else {
        await signInWithEmailAndPassword(auth, email, pass);
      }
      // onAuthStateChanged routes to the verify gate or the app from here.
    } catch (e2) {
      showErr(e2);
      busy(false, isSignup ? "Create account" : "Sign in");
    }
  });

  $("#btn-toggle-mode").addEventListener("click", () => {
    authMode = isSignup ? "signin" : "signup";
    renderAuth();
  });

  const resetBtn = $("#btn-reset-pass");
  if (resetBtn) {
    resetBtn.addEventListener("click", async () => {
      const email = $("#a-email").value.trim();
      err.classList.add("hidden");
      if (!email) {
        showErr({ message: "Enter your email above first, then tap this again." });
        return;
      }
      try {
        await sendPasswordResetEmail(auth, email);
        err.textContent = `Password reset sent to ${email}. Check your inbox.`;
        err.classList.remove("hidden");
        err.classList.add("info-box");
      } catch (e3) {
        showErr(e3);
      }
    });
  }
}

// ---------------------------------------------------------------- email verification
// An account is not usable until the address behind it is proven. The Firestore
// rules enforce this too — this screen is the courtesy, not the control.

let lastVerificationSent = 0;
let verifyPollTimer = null;

function stopVerifyPolling() {
  if (verifyPollTimer) { clearInterval(verifyPollTimer); verifyPollTimer = null; }
}

const RESEND_COOLDOWN_MS = 60_000;

function renderVerify(fbUser) {
  const email = fbUser.email || "your address";
  $("#view-verify").innerHTML = `
    <div class="card hero-card">
      <p class="eyebrow">Peak</p>
      <h1>Confirm your email</h1>
      <p class="muted">We sent a link to <strong>${escapeHtml(email)}</strong>. Open it, and this page will carry on by itself.</p>
    </div>

    <div class="card">
      <div class="verify-state" id="verify-state">
        <span class="spinner" aria-hidden="true"></span>
        <span>Waiting for you to confirm…</span>
      </div>

      <p class="hint" style="margin-top:16px;">
        Nothing in your inbox? Check spam — it comes from a <code>firebaseapp.com</code> address.
      </p>

      <div id="verify-error" class="error-box hidden"></div>

      <button type="button" id="btn-check" class="btn btn-primary btn-block" style="margin-top:16px;">I've confirmed it</button>
      <button type="button" id="btn-resend" class="btn btn-ghost btn-block" style="margin-top:10px;">Resend the email</button>

      <div class="auth-links" style="justify-content:center;">
        <button type="button" id="btn-verify-signout" class="linkish">Sign out</button>
      </div>
    </div>

    <p class="muted legal-note">
      Confirming proves the address is yours, so nobody else can claim it and nothing is
      stored against an address that doesn't exist.
    </p>
  `;

  const err = $("#verify-error");
  const state = $("#verify-state");
  const resendBtn = $("#btn-resend");

  const showErr = (e) => {
    err.classList.remove("info-box");
    err.textContent = authErrorMessage(e);
    err.classList.remove("hidden");
  };

  function refreshResendButton() {
    const left = Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - lastVerificationSent)) / 1000);
    if (left > 0) {
      resendBtn.disabled = true;
      resendBtn.textContent = `Resend the email (${left}s)`;
    } else {
      resendBtn.disabled = false;
      resendBtn.textContent = "Resend the email";
    }
  }
  refreshResendButton();

  // Checks with Firebase whether the address has been confirmed. The ID token
  // is minted at sign-in and still says unverified afterwards, so it has to be
  // force-refreshed or the Firestore rules will keep rejecting the write.
  async function check(silent) {
    try {
      await fbUser.reload();
      if (auth.currentUser?.emailVerified) {
        await auth.currentUser.getIdToken(true);
        stopVerifyPolling();
        await loadForUid();
        return true;
      }
      if (!silent) {
        err.textContent = "Not confirmed yet. Open the link in the email, then try again.";
        err.classList.remove("hidden");
        err.classList.remove("info-box");
      }
    } catch (e) {
      if (!silent) showErr(e);
    }
    return false;
  }

  $("#btn-check").addEventListener("click", async () => {
    const btn = $("#btn-check");
    btn.disabled = true;
    btn.textContent = "Checking…";
    await check(false);
    btn.disabled = false;
    btn.textContent = "I've confirmed it";
  });

  resendBtn.addEventListener("click", async () => {
    err.classList.add("hidden");
    resendBtn.disabled = true;
    try {
      await sendEmailVerification(auth.currentUser);
      lastVerificationSent = Date.now();
      err.textContent = `Sent again to ${email}.`;
      err.classList.remove("hidden");
      err.classList.add("info-box");
    } catch (e) {
      showErr(e);
    }
    refreshResendButton();
  });

  $("#btn-verify-signout").addEventListener("click", async () => {
    stopVerifyPolling();
    await signOut(auth);
  });

  // Poll quietly so returning to this tab after clicking the link just works.
  stopVerifyPolling();
  verifyPollTimer = setInterval(() => {
    refreshResendButton();
    if (!document.hidden) check(true);
  }, 4000);

  state.textContent = "";
  state.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>Waiting for you to confirm…</span>`;
}

// ---------------------------------------------------------------- onboarding

let onboardStep = 0;
let selectedInjuries = [];
let feasibilityAcknowledged = false;

function optionsHtml(obj) {
  return Object.entries(obj).map(([k, v]) => `<option value="${k}">${escapeHtml(v.label)}</option>`).join("");
}

function renderOnboarding() {
  $("#view-onboard").innerHTML = `
    <div class="card hero-card">
      <p class="eyebrow">Peak</p>
      <h1>Build the plan</h1>
      <p class="muted">Three steps. Everything after this is built from your answers, and moves as you train.</p>
    </div>
    <div class="steps">
      ${["Fitness", "Schedule", "Goal"].map((s, i) => `<div class="step ${i === onboardStep ? "current" : i < onboardStep ? "done" : ""}"><span class="step-num">${i + 1}</span>${s}</div>`).join("")}
    </div>

    <form id="onboard-form">
      <div class="card step-panel ${onboardStep === 0 ? "" : "hidden"}" data-step="0">
        <h2>Where you are now</h2>
        <label for="f-name">Your name</label>
        <input type="text" id="f-name" placeholder="e.g. Louka" autocomplete="name" required />

        <label for="f-workouts">Strength training right now</label>
        <select id="f-workouts">${optionsHtml(WORKOUT_FREQ)}</select>

        <label for="f-cardio">Cardio right now</label>
        <select id="f-cardio">${optionsHtml(CARDIO_FREQ)}</select>

        <label for="f-rundur">How long can you run comfortably, without stopping?</label>
        <select id="f-rundur">${optionsHtml(RUN_DURATION)}</select>

        <label for="f-5k">Your current 5K time <span class="optional-tag">optional</span></label>
        <input type="text" id="f-5k" placeholder="e.g. 24:30 — leave blank if you don't know" inputmode="numeric" />
        <p class="hint">If you know it, every training pace in your plan comes from this number instead of an estimate.</p>

        <label>Anything you want to keep injury-free?</label>
        <p class="hint" style="margin-top:-4px;">Optional. Prehab for whatever you pick gets built into your easy days.</p>
        <div id="f-injuries" class="chip-group">
          ${Object.entries(INJURY_FOCUS_LABELS).map(([k, l]) => `<button type="button" class="chip" data-value="${k}">${escapeHtml(l)}</button>`).join("")}
        </div>
      </div>

      <div class="card step-panel ${onboardStep === 1 ? "" : "hidden"}" data-step="1">
        <h2>The time you actually have</h2>
        <label for="f-sessions">Training sessions per week</label>
        <select id="f-sessions">${SESSION_COUNTS.map((n) => `<option value="${n}" ${n === 4 ? "selected" : ""}>${n} sessions</option>`).join("")}</select>

        <label for="f-minutes">Time per session</label>
        <select id="f-minutes">${SESSION_MINUTES.map((n) => `<option value="${n}" ${n === 60 ? "selected" : ""}>${n} minutes</option>`).join("")}</select>

        <label>Other commitments</label>
        <p class="hint" style="margin-top:-4px;">Mark the days that are already taken. Hard days get left alone; the plan schedules around them.</p>
        <div class="commitments">
          ${WEEKDAYS.map((d, i) => `
            <div class="commit-row">
              <div class="commit-day">${WEEKDAYS_SHORT[i]}</div>
              <select class="commit-load" data-day="${i}">${optionsHtml(COMMITMENT_LOADS)}</select>
              <input type="text" class="commit-label" data-day="${i}" placeholder="What is it?" />
            </div>
          `).join("")}
        </div>
      </div>

      <div class="card step-panel ${onboardStep === 2 ? "" : "hidden"}" data-step="2">
        <h2>What you're chasing</h2>
        <label for="f-goaltype">Goal type</label>
        <select id="f-goaltype">${optionsHtml(GOAL_TYPES)}</select>

        <div id="endurance-fields">
          <label for="f-event">Distance</label>
          <select id="f-event">${optionsHtml(EVENTS)}</select>

          <label for="f-target">Target time <span class="optional-tag">optional</span></label>
          <input type="text" id="f-target" placeholder="e.g. 22:00 — leave blank to just finish it" inputmode="numeric" />
          <p class="hint">Give a time and the app tells you honestly whether it's reachable by your deadline.</p>
        </div>

        <div id="fitness-fields" class="hidden">
          <label for="f-fitnesstarget">Emphasis</label>
          <select id="f-fitnesstarget">${optionsHtml(FITNESS_TARGETS)}</select>
        </div>

        <label for="f-deadline">Deadline</label>
        <input type="date" id="f-deadline" required />
        <p class="hint">The date you want to be ready by. The plan works backwards from it.</p>

        <div id="feasibility-panel"></div>
        <div id="onboard-error" class="error-box hidden"></div>
      </div>

      <div class="onboard-nav">
        <button type="button" id="btn-back" class="btn btn-ghost ${onboardStep === 0 ? "hidden" : ""}">Back</button>
        <button type="button" id="btn-next" class="btn btn-primary ${onboardStep === 2 ? "hidden" : ""}">Continue</button>
        <button type="submit" id="btn-build" class="btn btn-primary ${onboardStep === 2 ? "" : "hidden"}">Build it</button>
      </div>
    </form>

  `;

  // Default deadline: 12 weeks out.
  const dl = $("#f-deadline");
  if (dl && !dl.value) dl.value = dateKey(addDays(new Date(), 84));

  $("#f-injuries").querySelectorAll(".chip").forEach((btn) => {
    if (selectedInjuries.includes(btn.dataset.value)) btn.classList.add("selected");
    btn.addEventListener("click", () => {
      const v = btn.dataset.value;
      if (selectedInjuries.includes(v)) {
        selectedInjuries = selectedInjuries.filter((x) => x !== v);
        btn.classList.remove("selected");
      } else {
        selectedInjuries.push(v);
        btn.classList.add("selected");
      }
    });
  });

  $("#f-goaltype").addEventListener("change", (e) => {
    const isEndurance = e.target.value === "endurance";
    $("#endurance-fields").classList.toggle("hidden", !isEndurance);
    $("#fitness-fields").classList.toggle("hidden", isEndurance);
  });

  $("#btn-next").addEventListener("click", () => {
    if (onboardStep === 0 && !$("#f-name").value.trim()) {
      $("#f-name").focus();
      return;
    }
    stash();
    onboardStep++;
    renderOnboarding();
    window.scrollTo(0, 0);
  });

  $("#btn-back").addEventListener("click", () => {
    stash();
    onboardStep--;
    renderOnboarding();
    window.scrollTo(0, 0);
  });

  $("#onboard-form").addEventListener("submit", handleOnboardSubmit);

  restore();
}

// Onboarding spans three re-renders, so field values are stashed in memory.
const draft = {};
function stash() {
  $$("#onboard-form input, #onboard-form select").forEach((el) => {
    if (el.id) draft[el.id] = el.value;
    else if (el.dataset.day) draft[`${el.className.split(" ")[0]}-${el.dataset.day}`] = el.value;
  });
}
function restore() {
  $$("#onboard-form input, #onboard-form select").forEach((el) => {
    const key = el.id || `${el.className.split(" ")[0]}-${el.dataset.day}`;
    if (draft[key] !== undefined) el.value = draft[key];
  });
  const gt = $("#f-goaltype");
  if (gt) {
    const isEndurance = gt.value === "endurance";
    $("#endurance-fields")?.classList.toggle("hidden", !isEndurance);
    $("#fitness-fields")?.classList.toggle("hidden", isEndurance);
  }
}

async function handleOnboardSubmit(e) {
  e.preventDefault();
  stash();
  const err = $("#onboard-error");
  err.classList.add("hidden");

  const deadline = draft["f-deadline"];
  if (!deadline) return showErr("Pick a deadline.");
  const weeksOut = Math.ceil((parseDateKey(deadline) - mondayOnOrBefore(new Date())) / (7 * 86400000));
  if (weeksOut < 2) return showErr("That deadline is less than two weeks away — too short to build a plan around. Push it out a bit.");
  if (weeksOut > 52) return showErr("That deadline is more than a year out. Pick something within 12 months and set a new goal when you get there.");

  const fiveK = parseTimeToSeconds(draft["f-5k"]);
  if (draft["f-5k"] && !fiveK) return showErr("Couldn't read that 5K time. Use mm:ss, like 24:30.");

  const goalType = draft["f-goaltype"] || "endurance";
  const targetSeconds = goalType === "endurance" ? parseTimeToSeconds(draft["f-target"]) : null;
  if (goalType === "endurance" && draft["f-target"] && !targetSeconds) {
    return showErr("Couldn't read that target time. Use mm:ss or h:mm:ss.");
  }

  const commitments = {};
  for (let i = 0; i < 7; i++) {
    const load = draft[`commit-load-${i}`] || "none";
    // Cap the free-text label: it is the only unbounded string a user can store.
    if (load !== "none") {
      const label = (draft[`commit-label-${i}`] || "").trim().slice(0, 40);
      commitments[i] = { load, label: label || COMMITMENT_LOADS[load].label };
    }
  }

  const candidate = {
    name: draft["f-name"].trim().slice(0, 60),
    planStart: dateKey(new Date()),
    profile: {
      workoutsPerWeek: draft["f-workouts"] || "none",
      cardioPerWeek: draft["f-cardio"] || "none",
      runDuration: draft["f-rundur"] || "to20",
      fiveKSeconds: fiveK,
      injuryFocus: selectedInjuries.filter((k) => k in INJURY_FOCUS_LABELS).slice(0, 8),
    },
    schedule: {
      sessionsPerWeek: Number(draft["f-sessions"] || 4),
      minutesPerSession: Number(draft["f-minutes"] || 60),
      commitments,
    },
    goal: {
      type: goalType,
      event: draft["f-event"] || "fiveK",
      targetSeconds,
      fitnessTarget: draft["f-fitnesstarget"] || "allround",
      deadline,
    },
  };

  // Catch impossible goals here, while the target and deadline can still change.
  const issues = feasibilityReport(candidate);
  const blockers = issues.filter((i) => i.severity === "blocker");
  const panel = $("#feasibility-panel");

  // Only interrupt for something actionable. Pure notes are informational and
  // already live on the Plan tab — gating the build on them is just noise.
  const needsAttention = issues.some((i) => i.severity !== "note");
  if (needsAttention && !feasibilityAcknowledged) {
    panel.innerHTML = `
      <div class="card" style="margin-top:18px;">
        <h3>${blockers.length ? "This goal doesn't add up" : "Before you start"}</h3>
        <p class="muted" style="margin-top:-4px;">
          ${blockers.length
            ? "Based on your answers, this target isn't reachable by that date. Here's the honest read:"
            : "Nothing blocking, but these are worth knowing:"}
        </p>
        ${issuesHtml(issues)}
        <div class="issue-actions">
          <button type="button" class="btn btn-primary" id="btn-adjust">Change my goal</button>
          <button type="button" class="btn btn-ghost" id="btn-anyway">${blockers.length ? "Build it anyway" : "Continue"}</button>
        </div>
      </div>`;
    panel.scrollIntoView({ behavior: "smooth", block: "start" });

    $("#btn-adjust").addEventListener("click", () => {
      panel.innerHTML = "";
      $("#f-target")?.focus();
    });
    $("#btn-anyway").addEventListener("click", () => {
      feasibilityAcknowledged = true;
      panel.innerHTML = `<p class="hint" style="margin-top:14px;">Building it as specified — the same warnings stay on your Plan tab.</p>`;
      $("#onboard-form").dispatchEvent(new Event("submit"));
    });
    return;
  }

  const btn = $("#btn-build");
  btn.disabled = true;
  btn.textContent = "Building…";

  try {
    user = await createUser(candidate);
    rebuild();
    await persistFitness();
    enterApp();
  } catch (e2) {
    console.error(e2);
    showErr("Couldn't save your plan. Check the Firebase setup in the README.");
    btn.disabled = false;
    btn.textContent = "Build it";
  }

  function showErr(msg) {
    err.textContent = msg;
    err.classList.remove("hidden");
    err.scrollIntoView({ behavior: "smooth", block: "center" });
    btn.disabled = false;
    btn.textContent = "Build it";
  }
}

// ---------------------------------------------------------------- feasibility

function issuesHtml(issues) {
  return issues.map((i) => `
    <div class="issue ${i.severity}">
      <p class="issue-title">${i.severity === "blocker" ? "⛔" : i.severity === "warning" ? "⚠️" : "ℹ️"} ${escapeHtml(i.title)}</p>
      <p class="issue-detail">${escapeHtml(i.detail)}</p>
      ${i.fix ? `<p class="issue-fix"><strong>What to do:</strong> ${escapeHtml(i.fix)}</p>` : ""}
    </div>
  `).join("");
}

// ---------------------------------------------------------------- shared bits

function sessionCardHtml(day, week, { showLog = false } = {}) {
  const s = day.session;
  const logged = user.logs?.[day.dateKey];
  const gearList = s.gear.map((g) => GEAR_LABELS[g]).filter(Boolean);

  return `
    <div class="card session-card ${logged?.done ? "is-logged" : ""}">
      <div class="session-head">
        <span class="badge">Week ${week.num} · ${week.phase}</span>
        ${week.isDeload ? `<span class="badge badge-soft">Deload</span>` : ""}
        ${s.type === "test" ? `<span class="badge badge-test">Test</span>` : ""}
      </div>
      <h2>${escapeHtml(s.label)}</h2>
      <div class="session-meta">
        <span>${s.minutes} min</span>
        <span>RPE ${s.targetRpe}</span>
      </div>
      <ul class="workout-list">
        ${s.lines.map((l) => `<li class="${l.startsWith("🩹") ? "extra" : ""}">${escapeHtml(l)}</li>`).join("")}
      </ul>
      ${gearList.length ? `<p class="gear-line">🎒 ${gearList.map(escapeHtml).join(" · ")}</p>` : ""}
      ${day.commitment ? `<p class="commit-note">Also on today: ${escapeHtml(day.commitment.label)}</p>` : ""}
      ${showLog ? logControlsHtml(day, week, logged) : ""}
    </div>
  `;
}

function logControlsHtml(day, week, logged) {
  if (logged?.done) {
    return `<div class="logged-banner">Done${typeof logged.rpe === "number" ? ` · RPE ${logged.rpe}` : ""}</div>`;
  }
  if (day.session.type === "test") {
    return `<button id="log-btn" class="btn btn-primary btn-block">Enter your result</button>`;
  }
  return `
    <div class="log-block">
      <p class="log-prompt">How hard was it?</p>
      <div class="rpe-picker" id="rpe-picker">
        ${[2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `<button type="button" class="rpe-btn" data-rpe="${n}">${n}</button>`).join("")}
      </div>
      <button id="log-btn" class="btn btn-primary btn-block" disabled>Rate it first</button>
    </div>
  `;
}

function wireLogControls(day, week) {
  const btn = $("#log-btn");
  if (!btn) return;
  let chosenRpe = null;

  $$(".rpe-btn").forEach((b) => {
    b.addEventListener("click", () => {
      $$(".rpe-btn").forEach((x) => x.classList.remove("selected"));
      b.classList.add("selected");
      chosenRpe = Number(b.dataset.rpe);
      btn.disabled = false;
      btn.textContent = "Log it";
    });
  });

  btn.addEventListener("click", async () => {
    if (day.session.type === "test") return openTestDialog(week);
    btn.disabled = true;
    btn.textContent = "Saving…";
    await saveLog(day.dateKey, {
      done: true,
      rpe: chosenRpe,
      targetRpe: day.session.targetRpe,
      type: day.session.type,
      minutes: day.session.minutes,
    });
    rebuild();
    await persistFitness();
    renderAll();
  });
}

// ---------------------------------------------------------------- test dialog

function openTestDialog(week) {
  const isRun = user.goal.type === "endurance";
  const ev = EVENTS[user.goal.event];
  const testMeters = isRun ? Math.min(ev.meters, 5000) : 1609;

  $("#modal-root").innerHTML = `
    <div class="modal-backdrop">
      <div class="modal card">
        <h2>Record your test</h2>
        ${isRun ? `
          <label for="t-time">${testMeters / 1000} km time</label>
          <input type="text" id="t-time" placeholder="e.g. 23:45" inputmode="numeric" />
        ` : `
          <label for="t-push">Max push-ups (2 min)</label>
          <input type="number" id="t-push" min="0" />
          <label for="t-squat">Max squats (2 min)</label>
          <input type="number" id="t-squat" min="0" />
          <label for="t-plank">Plank hold (seconds)</label>
          <input type="number" id="t-plank" min="0" />
          <label for="t-mile">1 mile time</label>
          <input type="text" id="t-mile" placeholder="e.g. 8:30" inputmode="numeric" />
        `}
        <div id="test-error" class="error-box hidden"></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="t-cancel">Cancel</button>
          <button type="button" class="btn btn-primary" id="t-save">Save result</button>
        </div>
      </div>
    </div>
  `;

  $("#t-cancel").addEventListener("click", () => { $("#modal-root").innerHTML = ""; });

  $("#t-save").addEventListener("click", async () => {
    const err = $("#test-error");
    err.classList.add("hidden");
    let result;

    if (isRun) {
      const secs = parseTimeToSeconds($("#t-time").value);
      if (!secs) {
        err.textContent = "Couldn't read that time. Use mm:ss, like 23:45.";
        err.classList.remove("hidden");
        return;
      }
      result = { type: "run", seconds: secs, meters: testMeters, recordedAt: Date.now() };
    } else {
      const mile = parseTimeToSeconds($("#t-mile").value);
      result = {
        type: "run",
        meters: 1609,
        seconds: mile,
        pushups: Number($("#t-push").value) || 0,
        squats: Number($("#t-squat").value) || 0,
        plankSeconds: Number($("#t-plank").value) || 0,
        recordedAt: Date.now(),
      };
      if (!mile) delete result.seconds;
    }

    await saveTest(week.num, result);
    const todayKey = dateKey(new Date());
    await saveLog(todayKey, { done: true, rpe: 9, targetRpe: 9, type: "test" });
    $("#modal-root").innerHTML = "";
    rebuild();
    await persistFitness();
    renderAll();
  });
}

// ---------------------------------------------------------------- views

function renderToday() {
  const c = $("#today-content");
  const today = new Date();
  const found = getDayForDate(plan, today);

  if (!found) {
    const past = today > plan.deadline;
    c.innerHTML = `<div class="card empty-state">${past
      ? "🎉 Plan complete. Set a new goal from the Profile tab."
      : "Your plan hasn't started yet."}</div>`;
    return;
  }

  const { week, day } = found;

  if (day.isRest) {
    c.innerHTML = `
      <div class="card">
        <div class="session-head"><span class="badge">Week ${week.num} · ${week.phase}</span></div>
        <h2>Rest</h2>
        <p>${day.commitment
          ? `You've got ${escapeHtml(day.commitment.label)} today — that's the load. Nothing extra from the plan.`
          : "Sleep, eat, stay off your feet. Adaptation happens on these days, not the hard ones."}</p>
      </div>
      ${weekGlanceHtml(week)}
    `;
    return;
  }

  const extraHtml = day.extraSession
    ? `<div class="card session-card">
         <div class="session-head">
           <span class="badge badge-soft">Also today</span>
           <span class="badge badge-test">Added by coach</span>
         </div>
         <h2>${escapeHtml(day.extraSession.label)}</h2>
         <div class="session-meta"><span>${day.extraSession.minutes} min</span><span>RPE ${day.extraSession.targetRpe}</span></div>
         <ul class="workout-list">${day.extraSession.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>
         <p class="hint" style="margin:16px 0 0;">Logging today covers both sessions.</p>
       </div>`
    : "";

  c.innerHTML = sessionCardHtml(day, week, { showLog: true }) + extraHtml + rpeGuideHtml() + weekGlanceHtml(week);
  wireLogControls(day, week);
}

function weekGlanceHtml(week) {
  const todayKey = dateKey(new Date());
  return `
    <div class="card">
      <h3>This week</h3>
      <p class="muted" style="margin-top:-4px;">${escapeHtml(week.focus)}</p>
      <div class="glance-row">
        ${week.days.map((d) => {
          const logged = user.logs?.[d.dateKey]?.done;
          const cls = d.dateKey === todayKey ? "today" : logged ? "done" : d.isRest ? "rest" : "";
          return `<div class="glance-day ${cls}">
            <span class="glance-label">${WEEKDAYS_SHORT[d.weekdayIndex]}</span>
            <span class="glance-dot">${logged ? "✓" : d.isRest ? "–" : "•"}</span>
          </div>`;
        }).join("")}
      </div>
    </div>
  `;
}

function rpeGuideHtml() {
  return `
    <details class="card rpe-card">
      <summary>What is RPE?</summary>
      <p class="muted">Rate of Perceived Exertion — how hard the effort feels, 1 to 10.</p>
      ${RPE_SCALE.map((r) => `
        <div class="rpe-row">
          <span class="rpe-pill">${r.range}</span>
          <div><div class="rpe-label">${escapeHtml(r.label)}</div><div class="rpe-desc">${escapeHtml(r.desc)}</div></div>
        </div>`).join("")}
    </details>
  `;
}

function renderWeek() {
  if (viewedWeek === null) viewedWeek = Math.max(1, Math.min(plan.totalWeeks, adaptation.currentWeek));
  const week = getWeek(plan, viewedWeek);
  if (!week) return;

  $("#week-title").textContent = `Week ${week.num} of ${plan.totalWeeks}`;
  $("#week-subtitle").textContent = week.focus;
  $("#week-prev").disabled = week.num <= 1;
  $("#week-next").disabled = week.num >= plan.totalWeeks;

  const todayKey = dateKey(new Date());
  $("#week-days").innerHTML = week.days.map((d) => {
    const isToday = d.dateKey === todayKey;
    const logged = user.logs?.[d.dateKey]?.done;
    const dateLabel = d.date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

    if (d.isRest) {
      return `
        <div class="card day-card ${isToday ? "is-today" : ""}">
          <div class="day-head">
            <span class="badge badge-soft">Rest</span>
            ${isToday ? `<span class="today-tag">Today</span>` : ""}
          </div>
          <div class="day-date">${dateLabel}</div>
          <p class="muted" style="margin:8px 0 0;">${d.commitment ? escapeHtml(d.commitment.label) : "Recovery day."}</p>
        </div>`;
    }

    return `
      <div class="card day-card ${isToday ? "is-today" : ""} ${logged ? "is-logged" : ""}">
        <div class="day-head">
          <span class="badge">${escapeHtml(d.session.label)}</span>
          ${d.session.type === "test" ? `<span class="badge badge-test">Test</span>` : ""}
          ${isToday ? `<span class="today-tag">Today</span>` : ""}
          ${logged ? `<span class="today-tag done-tag">Done</span>` : ""}
        </div>
        <div class="day-date">${dateLabel} · ${d.session.minutes} min · RPE ${d.session.targetRpe}</div>
        <ul class="workout-list">
          ${d.session.lines.map((l) => `<li class="${l.startsWith("🩹") ? "extra" : ""}">${escapeHtml(l)}</li>`).join("")}
        </ul>
        ${d.extraSession ? `
          <div class="extra-session">
            <div class="day-head"><span class="badge badge-soft">+ ${escapeHtml(d.extraSession.label)}</span></div>
            <ul class="workout-list">${d.extraSession.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>
          </div>` : ""}
        ${d.commitment ? `<p class="commit-note">Also today: ${escapeHtml(d.commitment.label)}</p>` : ""}
      </div>`;
  }).join("");
}

function renderPlanOverview() {
  const c = $("#plan-content");
  const assess = goalAssessment(user, plan, adaptation);
  const issues = feasibilityReport(user);
  const cur = adaptation.currentWeek;

  const verdictClass = { ahead: "good", onTrack: "good", ambitious: "warn", unrealistic: "bad" };

  c.innerHTML = `
    <div class="card">
      <h2>${user.goal.type === "endurance" ? escapeHtml(EVENTS[user.goal.event].label) : "General fitness"}</h2>
      <p class="muted" style="margin-top:-4px;">
        ${plan.totalWeeks} weeks · ${plan.sessionsPerWeek} sessions a week ·
        deadline ${plan.deadline.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}
      </p>
      ${assess ? `
        <div class="assess ${verdictClass[assess.verdict]}">
          <div class="assess-row">
            <div><span class="assess-label">Target</span><strong>${formatDuration(assess.targetSeconds)}</strong></div>
            <div><span class="assess-label">Predicts now</span><strong>${formatDuration(assess.currentPredicted)}</strong></div>
            <div><span class="assess-label">Projected</span><strong>${formatDuration(assess.projectedSeconds)}</strong></div>
          </div>
          <p class="assess-detail">${escapeHtml(assess.detail)}</p>
        </div>` : ""}
    </div>

    ${issues.length ? `
      <div class="card">
        <h3>${issues.some((i) => i.severity === "blocker") ? "Why this goal is at risk" : "Worth knowing"}</h3>
        <p class="muted" style="margin-top:-4px;">Checked against your starting point, your schedule, and the calendar.</p>
        ${issuesHtml(issues)}
      </div>` : ""}

    ${plan.warnings.length ? `
      <div class="card warn-card">
        <h3>How the plan is handling it</h3>
        <ul class="workout-list">${plan.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>
      </div>` : ""}

    <div class="card">
      <h3>The whole plan</h3>
      <p class="muted" style="margin-top:-4px;">Test weeks are where the plan recalibrates.</p>
      <div class="timeline">
        ${plan.weeks.map((w) => `
          <button class="tl-week ${w.num === cur ? "current" : ""} ${w.isTest ? "test" : ""} ${w.isDeload ? "deload" : ""} ${w.isTaper ? "taper" : ""}" data-week="${w.num}">
            <span class="tl-num">W${w.num}</span>
            <span class="tl-phase">${w.phase}</span>
            ${w.isTest ? `<span class="tl-flag">TEST</span>` : w.isDeload ? `<span class="tl-flag soft">deload</span>` : ""}
          </button>`).join("")}
      </div>
    </div>

    <div class="card">
      <h3>Test weeks</h3>
      <ul class="test-list">
        ${plan.testWeeks.map((n) => {
          const w = getWeek(plan, n);
          const res = user.tests?.[n];
          return `<li>
            <strong>Week ${n}</strong> — ${w.startDate.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
            ${res ? `<span class="test-result">${res.seconds ? formatDuration(res.seconds) : ""}${res.pushups ? ` · ${res.pushups} push-ups` : ""}</span>`
                  : `<span class="muted">not yet run</span>`}
          </li>`;
        }).join("")}
      </ul>
    </div>

    <div class="card">
      <h3>Gear you'll need</h3>
      <ul class="workout-list">${plan.gear.map((g) => `<li>${escapeHtml(GEAR_LABELS[g] || g)}</li>`).join("")}</ul>
    </div>
  `;

  $$(".tl-week").forEach((b) => b.addEventListener("click", () => {
    viewedWeek = Number(b.dataset.week);
    renderWeek();
    switchTab("week");
  }));
}

function fitnessCardHtml() {
  const f = adaptation.fitness;
  const measured = f.confidence === "measured";
  return `
    <div class="card">
      <div class="card-head">
        <h3>Current fitness</h3>
        <span class="badge ${measured ? "" : "badge-soft"}">${measured ? "Measured" : "Estimated"}</span>
      </div>
      <p class="muted" style="margin-top:-4px;">
        This isn't something you set. It starts from your onboarding answers, moves with the
        training you actually log, and gets replaced by a real number every test week.
      </p>
      <div class="fitness-readout">
        <div class="fitness-num">${f.vdot.toFixed(1)}</div>
        <div class="fitness-meta">
          <div>${f.lastTestWeek
            ? `Last measured in week ${f.lastTestWeek}, ${f.weeksSinceTest} week${f.weeksSinceTest === 1 ? "" : "s"} ago`
            : "Never measured yet — run your first test week"}</div>
          <div class="muted">${f.anchor === "test"
            ? `Anchored to that test${Math.abs(f.driftSinceAnchor) >= 0.1 ? `, then moved ${f.driftSinceAnchor > 0 ? "+" : ""}${f.driftSinceAnchor.toFixed(1)} by logged training` : ""}`
            : `Seeded from your onboarding answers${Math.abs(f.driftSinceAnchor) >= 0.1 ? `, then moved ${f.driftSinceAnchor > 0 ? "+" : ""}${f.driftSinceAnchor.toFixed(1)} by logged training` : ""}`}</div>
        </div>
      </div>
      ${!measured ? `<p class="hint" style="margin:12px 0 0;">Estimated numbers drift. Your next test week replaces this with something real.</p>` : ""}
    </div>
  `;
}

function renderProfile() {
  const c = $("#profile-content");
  const p = user.profile;
  const g = user.goal;
  const adherencePct = Math.round((adaptation.adherence ?? 1) * 100);
  const commitCount = Object.keys(user.schedule.commitments || {}).length;

  c.innerHTML = `
    <div class="card">
      <h2>${escapeHtml(user.name)}</h2>
      <p class="muted" style="margin-top:-4px;">Week ${Math.min(adaptation.currentWeek, plan.totalWeeks)} of ${plan.totalWeeks} · ${plan.tier} starting point</p>
      <div class="stat-row">
        <div class="stat"><span class="stat-num">${Object.values(user.logs || {}).filter((l) => l.done).length}</span><span class="stat-label">sessions logged</span></div>
        <div class="stat"><span class="stat-num">${adherencePct}%</span><span class="stat-label">recent adherence</span></div>
        <div class="stat"><span class="stat-num">${plan.vdot ? plan.vdot.toFixed(1) : "—"}</span><span class="stat-label">fitness score</span></div>
      </div>
    </div>

    ${fitnessCardHtml()}

    ${plan.paces ? `
      <div class="card">
        <h3>Your training paces</h3>
        <p class="muted" style="margin-top:-4px;">Derived from your current fitness above — they move when it moves.</p>
        <table class="pace-table">
          ${[["easy", "Easy"], ["marathon", "Steady"], ["threshold", "Tempo"], ["interval", "Interval"], ["repetition", "Sprint"]]
            .map(([k, label]) => `<tr><td>${label}</td><td>${formatPace(plan.paces[k])}</td><td class="muted">${paceToMile(plan.paces[k])}</td></tr>`).join("")}
        </table>
      </div>` : ""}

    <div class="card">
      <div class="card-head">
        <h3>Your goal</h3>
        <button class="btn-edit" id="edit-goal">Edit</button>
      </div>
      <table class="profile-table">
        <tr><td>Goal</td><td>${escapeHtml(g.type === "endurance" ? EVENTS[g.event].label : FITNESS_TARGETS[g.fitnessTarget || "allround"].label)}</td></tr>
        ${g.type === "endurance" ? `<tr><td>Target time</td><td>${g.targetSeconds ? formatDuration(g.targetSeconds) : "just finish it"}</td></tr>` : ""}
        <tr><td>Deadline</td><td>${plan.deadline.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}</td></tr>
        <tr><td>Weeks left</td><td>${Math.max(0, plan.totalWeeks - adaptation.currentWeek + 1)}</td></tr>
      </table>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>Your schedule</h3>
        <button class="btn-edit" id="edit-schedule">Edit</button>
      </div>
      <table class="profile-table">
        <tr><td>Sessions</td><td>${user.schedule.sessionsPerWeek} a week</td></tr>
        <tr><td>Session length</td><td>${user.schedule.minutesPerSession} min</td></tr>
        <tr><td>Commitments</td><td>${commitCount
          ? Object.entries(user.schedule.commitments).map(([i, cm]) => `${WEEKDAYS_SHORT[i]}: ${escapeHtml(cm.label)}`).join(", ")
          : "none"}</td></tr>
      </table>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>Injury focus</h3>
        <button class="btn-edit" id="edit-injuries">Edit</button>
      </div>
      <p class="muted" style="margin-top:-4px;">Prehab for these is built into your easy days.</p>
      <div class="chip-group" style="margin-top:10px;">
        ${(p.injuryFocus || []).length
          ? p.injuryFocus.map((k) => `<span class="chip selected static">${escapeHtml(INJURY_FOCUS_LABELS[k] || k)}</span>`).join("")
          : `<span class="muted">Nothing selected</span>`}
      </div>
    </div>

    <div class="card">
      <h3>Plan adjustments</h3>
      <p class="muted" style="margin-top:-4px;">The plan tunes itself as you log. Here's every change it has made.</p>
      ${adaptation.notes.length
        ? `<ul class="adjust-list">${adaptation.notes.map((n) => `<li><span class="adjust-week">W${n.week}</span>${escapeHtml(n.text)}</li>`).join("")}</ul>`
        : `<p class="muted">No adjustments yet — the plan is running as originally built.</p>`}
      ${adaptation.volumeFactor !== 1 ? `<p class="adjust-factor">Current volume: ${Math.round(adaptation.volumeFactor * 100)}% of baseline</p>` : ""}
    </div>

    ${(user.changeLog || []).length ? `
      <div class="card">
        <h3>Changes you've made</h3>
        <ul class="adjust-list">
          ${[...user.changeLog].reverse().map((ch) => `<li><span class="adjust-week">W${ch.week}</span>${escapeHtml(ch.text)}</li>`).join("")}
        </ul>
      </div>` : ""}

    <div class="card">
      <h3>Account</h3>
      <p class="muted" style="margin-top:-4px;">
        ${DEMO
          ? "Demo mode — this plan lives in this browser only and is not signed in to anything."
          : `Signed in as ${escapeHtml(auth?.currentUser?.email || "your account")}. Sign in on any other device to pick up the same plan.`}
      </p>
      <div class="account-actions">
        ${DEMO ? "" : `<button id="btn-signout" class="btn btn-ghost btn-block">Sign out</button>`}
        <button id="btn-reset" class="btn btn-ghost btn-block danger">Start a new plan</button>
      </div>
      <p class="hint" style="margin:14px 0 0;">Starting a new plan replaces this one, including its logged sessions and test results. It can't be undone.</p>
    </div>
  `;

  $("#edit-goal").addEventListener("click", openGoalEditor);
  $("#edit-schedule").addEventListener("click", openScheduleEditor);
  $("#edit-injuries").addEventListener("click", openInjuryEditor);

  const signOutBtn = $("#btn-signout");
  if (signOutBtn) {
    signOutBtn.addEventListener("click", async () => {
      await signOut(auth);
      user = null; plan = null; adaptation = null; viewedWeek = null;
    });
  }

  $("#btn-reset").addEventListener("click", async () => {
    if (!confirm("This permanently deletes your current plan, every logged session, and every test result, then starts onboarding again. This cannot be undone. Continue?")) return;
    if (!confirm("Last check — your training history will be gone for good. Delete it?")) return;
    const id = currentUid();
    if (DEMO) {
      const all = demoRead();
      delete all[id];
      demoWrite(all);
    } else {
      await deleteDoc(doc(db, "users", id));
    }
    user = null; plan = null; adaptation = null; viewedWeek = null;
    onboardStep = 0;
    selectedInjuries = [];
    feasibilityAcknowledged = false;
    showScreen("onboard");
    renderOnboarding();
  });
}

// ---------------------------------------------------------------- editing

function closeModal() { $("#modal-root").innerHTML = ""; }

function modal(innerHtml) {
  $("#modal-root").innerHTML = `<div class="modal-backdrop"><div class="modal card">${innerHtml}</div></div>`;
}

// Applies an edit: merges into the in-memory user, writes it, and rebuilds.
// Every edit is recorded so the athlete can see what they changed and when.
async function applyEdit(patch, changeText) {
  const week = adaptation.currentWeek;
  const entry = { week, at: Date.now(), text: changeText };
  const changeLog = [...(user.changeLog || []), entry].slice(-200);

  Object.assign(user, patch, { changeLog });
  await persistDoc({ ...patch, changeLog });

  viewedWeek = null;
  rebuild();
  await persistFitness();
  renderAll();
}

function openGoalEditor() {
  const g = user.goal;
  modal(`
    <h2>Edit your goal</h2>
    <p class="muted" style="margin-top:-6px;">Your logged sessions and test results are kept — only the target changes.</p>

    <label for="e-goaltype">Goal type</label>
    <select id="e-goaltype">${Object.entries(GOAL_TYPES).map(([k, v]) => `<option value="${k}" ${k === g.type ? "selected" : ""}>${escapeHtml(v.label)}</option>`).join("")}</select>

    <div id="e-endurance" class="${g.type === "endurance" ? "" : "hidden"}">
      <label for="e-event">Distance</label>
      <select id="e-event">${Object.entries(EVENTS).map(([k, v]) => `<option value="${k}" ${k === g.event ? "selected" : ""}>${escapeHtml(v.label)}</option>`).join("")}</select>

      <label for="e-target">Target time <span class="optional-tag">optional</span></label>
      <input type="text" id="e-target" inputmode="numeric" placeholder="e.g. 22:00 — blank to just finish"
             value="${g.targetSeconds ? formatDuration(g.targetSeconds) : ""}" />
    </div>

    <div id="e-fitness" class="${g.type === "fitness" ? "" : "hidden"}">
      <label for="e-fitnesstarget">Emphasis</label>
      <select id="e-fitnesstarget">${Object.entries(FITNESS_TARGETS).map(([k, v]) => `<option value="${k}" ${k === (g.fitnessTarget || "allround") ? "selected" : ""}>${escapeHtml(v.label)}</option>`).join("")}</select>
    </div>

    <label for="e-deadline">Deadline</label>
    <input type="date" id="e-deadline" value="${escapeHtml(g.deadline)}" />

    <div id="e-issues"></div>
    <div id="e-error" class="error-box hidden"></div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" id="e-cancel">Cancel</button>
      <button type="button" class="btn btn-primary" id="e-save">Save goal</button>
    </div>
  `);

  $("#e-goaltype").addEventListener("change", (ev) => {
    const isEnd = ev.target.value === "endurance";
    $("#e-endurance").classList.toggle("hidden", !isEnd);
    $("#e-fitness").classList.toggle("hidden", isEnd);
  });
  $("#e-cancel").addEventListener("click", closeModal);

  let acknowledged = false;
  $("#e-save").addEventListener("click", async () => {
    const err = $("#e-error");
    err.classList.add("hidden");
    const type = $("#e-goaltype").value;
    const deadline = $("#e-deadline").value;
    if (!deadline) return showErr("Pick a deadline.");

    const weeksOut = Math.ceil((parseDateKey(deadline) - mondayOnOrBefore(new Date())) / (7 * 86400000));
    if (weeksOut < 2) return showErr("That deadline is less than two weeks away — too short to build a plan around.");
    if (weeksOut > 52) return showErr("That deadline is more than a year out. Pick something within 12 months.");

    const raw = $("#e-target").value.trim();
    const targetSeconds = type === "endurance" ? parseTimeToSeconds(raw) : null;
    if (type === "endurance" && raw && !targetSeconds) return showErr("Couldn't read that target time. Use mm:ss or h:mm:ss.");

    const newGoal = {
      type,
      event: $("#e-event").value,
      targetSeconds,
      fitnessTarget: $("#e-fitnesstarget").value,
      deadline,
    };

    // Same honesty check as onboarding — a goal edit can create an impossible
    // target just as easily as the original answers could.
    const issues = feasibilityReport({ ...user, goal: newGoal });
    const needsAttention = issues.some((i) => i.severity !== "note");
    if (needsAttention && !acknowledged) {
      $("#e-issues").innerHTML = `
        <div style="margin-top:16px;">
          <h3>${issues.some((i) => i.severity === "blocker") ? "This goal doesn't add up" : "Before you save"}</h3>
          ${issuesHtml(issues)}
        </div>`;
      acknowledged = true;
      $("#e-save").textContent = "Save anyway";
      $("#e-issues").scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }

    const label = type === "endurance"
      ? `${EVENTS[newGoal.event].label}${targetSeconds ? ` in ${formatDuration(targetSeconds)}` : ""} by ${deadline}`
      : `${FITNESS_TARGETS[newGoal.fitnessTarget].label} by ${deadline}`;

    $("#e-save").disabled = true;
    $("#e-save").textContent = "Saving…";
    try {
      await applyEdit({ goal: newGoal }, `Goal changed to ${label}.`);
      closeModal();
    } catch (e) {
      console.error(e);
      showErr("Couldn't save the change. Check your connection and try again.");
      $("#e-save").disabled = false;
      $("#e-save").textContent = "Save goal";
    }

    function showErr(m) {
      err.textContent = m;
      err.classList.remove("hidden");
      $("#e-save").disabled = false;
    }
  });
}

function openScheduleEditor() {
  const sc = user.schedule;
  modal(`
    <h2>Edit your schedule</h2>
    <p class="muted" style="margin-top:-6px;">Takes effect from this week. Past weeks are still judged against what was scheduled at the time.</p>

    <label for="e-sessions">Sessions per week</label>
    <select id="e-sessions">${SESSION_COUNTS.map((n) => `<option value="${n}" ${n === sc.sessionsPerWeek ? "selected" : ""}>${n} sessions</option>`).join("")}</select>

    <label for="e-minutes">Time per session</label>
    <select id="e-minutes">${SESSION_MINUTES.map((n) => `<option value="${n}" ${n === sc.minutesPerSession ? "selected" : ""}>${n} minutes</option>`).join("")}</select>

    <label>Other commitments</label>
    <div class="commitments">
      ${WEEKDAYS.map((d, i) => {
        const cm = (sc.commitments || {})[i];
        return `
          <div class="commit-row">
            <div class="commit-day">${WEEKDAYS_SHORT[i]}</div>
            <select class="commit-load" data-day="${i}">
              ${Object.entries(COMMITMENT_LOADS).map(([k, v]) => `<option value="${k}" ${cm && cm.load === k ? "selected" : ""}>${escapeHtml(v.label)}</option>`).join("")}
            </select>
            <input type="text" class="commit-label" data-day="${i}" maxlength="40" placeholder="What is it?" value="${cm ? escapeHtml(cm.label) : ""}" />
          </div>`;
      }).join("")}
    </div>

    <div id="e-error" class="error-box hidden"></div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" id="e-cancel">Cancel</button>
      <button type="button" class="btn btn-primary" id="e-save">Save schedule</button>
    </div>
  `);

  $("#e-cancel").addEventListener("click", closeModal);
  $("#e-save").addEventListener("click", async () => {
    const err = $("#e-error");
    err.classList.add("hidden");

    const commitments = {};
    $$(".commit-load").forEach((sel) => {
      const i = sel.dataset.day;
      if (sel.value === "none") return;
      const label = ($(`.commit-label[data-day="${i}"]`).value || "").trim().slice(0, 40);
      commitments[i] = { load: sel.value, label: label || COMMITMENT_LOADS[sel.value].label };
    });

    const sessionsPerWeek = Number($("#e-sessions").value);
    const free = 7 - Object.values(commitments).filter((cm) => cm.load === "hard").length;
    if (free < 2) {
      err.textContent = "That leaves fewer than two free days. Mark at least two days as free, or set one commitment to light.";
      err.classList.remove("hidden");
      return;
    }

    const schedule = { sessionsPerWeek, minutesPerSession: Number($("#e-minutes").value), commitments };
    // Record when the session count changed so historical adherence stays honest.
    const history = [...(user.scheduleHistory || [{ fromWeek: 1, sessionsPerWeek: user.schedule.sessionsPerWeek }])];
    if (sessionsPerWeek !== user.schedule.sessionsPerWeek) {
      const week = adaptation.currentWeek;
      // Editing twice in the same week should correct that week's entry, not
      // stack a second one on top of it.
      if (history.length && history[history.length - 1].fromWeek === week) {
        history[history.length - 1] = { fromWeek: week, sessionsPerWeek };
      } else {
        history.push({ fromWeek: week, sessionsPerWeek });
      }
    }

    $("#e-save").disabled = true;
    $("#e-save").textContent = "Saving…";
    try {
      await applyEdit(
        { schedule, scheduleHistory: history },
        `Schedule changed to ${sessionsPerWeek} x ${schedule.minutesPerSession} min a week.`
      );
      closeModal();
    } catch (e) {
      console.error(e);
      err.textContent = "Couldn't save the change. Check your connection and try again.";
      err.classList.remove("hidden");
      $("#e-save").disabled = false;
      $("#e-save").textContent = "Save schedule";
    }
  });
}

function openInjuryEditor() {
  let picked = [...(user.profile.injuryFocus || [])];
  modal(`
    <h2>Injury focus</h2>
    <p class="muted" style="margin-top:-6px;">Prehab for whatever you pick gets built into your easy days.</p>
    <div id="e-injuries" class="chip-group" style="margin-top:14px;">
      ${Object.entries(INJURY_FOCUS_LABELS).map(([k, l]) => `<button type="button" class="chip ${picked.includes(k) ? "selected" : ""}" data-value="${k}">${escapeHtml(l)}</button>`).join("")}
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" id="e-cancel">Cancel</button>
      <button type="button" class="btn btn-primary" id="e-save">Save</button>
    </div>
  `);

  $("#e-injuries").querySelectorAll(".chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const v = btn.dataset.value;
      if (picked.includes(v)) { picked = picked.filter((x) => x !== v); btn.classList.remove("selected"); }
      else if (picked.length < 8) { picked.push(v); btn.classList.add("selected"); }
    });
  });

  $("#e-cancel").addEventListener("click", closeModal);
  $("#e-save").addEventListener("click", async () => {
    $("#e-save").disabled = true;
    $("#e-save").textContent = "Saving…";
    const profile = { ...user.profile, injuryFocus: picked.filter((k) => k in INJURY_FOCUS_LABELS).slice(0, 8) };
    try {
      await applyEdit(
        { profile },
        picked.length ? `Injury focus set to ${picked.map((k) => INJURY_FOCUS_LABELS[k]).join(", ")}.` : "Injury focus cleared."
      );
      closeModal();
    } catch (e) {
      console.error(e);
      $("#e-save").disabled = false;
      $("#e-save").textContent = "Save";
    }
  });
}

// ---------------------------------------------------------------- coach

const QUICK_PROMPTS = [
  "What am I doing today?",
  "Ran 30 easy instead of the intervals",
  "Can't train Thursday",
  "Legs are wrecked",
];

// Turns the coach's structured actions into stored state. The coach decides
// what should change; this is the only place anything actually changes.
async function applyCoachActions(actions) {
  const patch = {};
  const co = { ...(user.coachOverrides || {}) };
  let touchedOverrides = false;
  let touchedLogs = false;

  for (const a of actions) {
    if (a.type === "logActual") {
      const entry = {
        done: true,
        rpe: a.session.rpe,
        targetRpe: a.session.plannedRpe ?? a.session.rpe,
        type: a.session.type,
        minutes: a.session.minutes,
        actual: { label: a.session.label, note: a.session.note },
        viaCoach: true,
      };
      user.logs = user.logs || {};
      user.logs[a.dateKey] = entry;
      await persistField(`logs.${a.dateKey}`, entry);
      touchedLogs = true;
    }

    else if (a.type === "blockDates") {
      co.blockedDates = [...new Set([...(co.blockedDates || []), ...a.dates])];
      touchedOverrides = true;
    }

    else if (a.type === "unblockDates") {
      co.blockedDates = (co.blockedDates || []).filter((d) => !a.dates.includes(d));
      touchedOverrides = true;
    }

    else if (a.type === "moveSession") {
      co.moves = { ...(co.moves || {}), [a.from]: a.to };
      touchedOverrides = true;
    }

    else if (a.type === "setLoad") {
      co.loadFactor = a.factor;
      co.loadFactorFromWeek = adaptation.currentWeek;
      co.loadReason = a.reason;
      touchedOverrides = true;
    }

    else if (a.type === "softenDays") {
      co.softenUntil = dateKey(addDays(new Date(), a.days));
      co.softenReason = a.reason;
      touchedOverrides = true;
    }

    else if (a.type === "addRecurringSessions") {
      const existing = co.extraSessions || [];
      const added = a.weekdays
        .filter((wd) => !existing.some((e) => e.weekday === wd))
        .map((wd) => ({ weekday: wd, type: a.sessionType, fromWeek: adaptation.currentWeek }));
      co.extraSessions = [...existing, ...added].slice(0, 7);
      touchedOverrides = true;
    }

    else if (a.type === "removeRecurringSessions") {
      co.extraSessions = (co.extraSessions || []).filter((e) => !a.weekdays.includes(e.weekday));
      touchedOverrides = true;
    }

    else if (a.type === "recordResult") {
      // Stored alongside test results so the derived fitness picks it up —
      // a measured maximal effort is exactly what a test week produces.
      const week = adaptation.currentWeek;
      const result = { type: "run", seconds: a.seconds, meters: a.meters, viaCoach: true, recordedAt: Date.now() };
      user.tests = user.tests || {};
      user.tests[week] = result;
      await persistField(`tests.${week}`, result);
      touchedLogs = true;
    }

    else if (a.type === "setExerciseRules") {
      co.exerciseRules = a.rules;
      touchedOverrides = true;
    }

    else if (a.type === "swapDays") {
      co.swaps = [...(co.swaps || []), [a.a, a.b]].slice(-20);
      touchedOverrides = true;
    }

    else if (a.type === "setSchedule") {
      const schedule = { ...user.schedule, ...a.change };
      const history = [...(user.scheduleHistory || [{ fromWeek: 1, sessionsPerWeek: user.schedule.sessionsPerWeek }])];
      if (a.change.sessionsPerWeek && a.change.sessionsPerWeek !== user.schedule.sessionsPerWeek) {
        const week = adaptation.currentWeek;
        if (history.length && history[history.length - 1].fromWeek === week) {
          history[history.length - 1] = { fromWeek: week, sessionsPerWeek: a.change.sessionsPerWeek };
        } else {
          history.push({ fromWeek: week, sessionsPerWeek: a.change.sessionsPerWeek });
        }
      }
      user.schedule = schedule;
      user.scheduleHistory = history;
      patch.schedule = schedule;
      patch.scheduleHistory = history;
      const bits = [];
      if (a.change.sessionsPerWeek) bits.push(`${a.change.sessionsPerWeek} sessions a week`);
      if (a.change.minutesPerSession) bits.push(`${a.change.minutesPerSession} min each`);
      patch.changeLog = [...(user.changeLog || []),
        { week: adaptation.currentWeek, at: Date.now(), text: `Schedule changed to ${bits.join(", ")} (via coach).` }].slice(-200);
      user.changeLog = patch.changeLog;
    }

    else if (a.type === "addInjuryFocus") {
      const list = [...new Set([...(user.profile.injuryFocus || []), a.part])].slice(0, 8);
      user.profile = { ...user.profile, injuryFocus: list };
      patch.profile = user.profile;
    }

    else if (a.type === "openGoalEditor") {
      // Handled by the caller once the message has rendered.
    }
  }

  if (touchedOverrides) {
    user.coachOverrides = co;
    patch.coachOverrides = co;
  }
  if (Object.keys(patch).length) await persistDoc(patch);
  return touchedOverrides || touchedLogs || Object.keys(patch).length > 0;
}

async function appendChat(entry) {
  user.chat = [...(user.chat || []), entry].slice(-120);
  await persistDoc({ chat: user.chat });
}

function chatBubbleHtml(m) {
  const cls = m.role === "user" ? "from-user" : "from-coach";
  const time = new Date(m.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  // Coach replies are authored here, never by a third party, but they still go
  // through escaping — the only untrusted input is the athlete's own text.
  const body = escapeHtml(m.text).replace(/\n/g, "<br>");
  return `
    <div class="bubble ${cls}">
      <div class="bubble-body">${body}</div>
      ${m.changes?.length ? `<div class="bubble-changes">${m.changes.map((c) => `<span class="change-pill">${escapeHtml(c)}</span>`).join("")}</div>` : ""}
      <div class="bubble-time">${time}</div>
    </div>`;
}

function renderCoach() {
  const log = $("#coach-log");
  const history = user.chat || [];

  log.innerHTML = history.length
    ? history.map(chatBubbleHtml).join("")
    : `<div class="coach-intro">
        <h2>Talk to your coach</h2>
        <p class="muted">Tell me what actually happened and I'll change the plan around it. I can log a session you did differently, reshuffle a week you can't make, and dial the load up or down.</p>
        <p class="hint">I won't change your goal from here — that runs a feasibility check in Profile → Your goal. And I'm not a physio: if something hurts, I'll take the impact out, but I'll tell you to get it looked at.</p>
      </div>`;

  $("#coach-quick").innerHTML = history.length
    ? ""
    : QUICK_PROMPTS.map((p) => `<button type="button" class="quick-prompt">${escapeHtml(p)}</button>`).join("");

  $$(".quick-prompt").forEach((b) => b.addEventListener("click", () => {
    $("#coach-input").value = b.textContent;
    sendToCoach();
  }));

  log.scrollTop = log.scrollHeight;
}

let coachBusy = false;

async function sendToCoach() {
  if (coachBusy) return;
  const input = $("#coach-input");
  const text = input.value.trim();
  if (!text) return;

  coachBusy = true;
  input.value = "";
  $("#coach-send").disabled = true;

  await appendChat({ role: "user", text: text.slice(0, 500), at: Date.now() });
  renderCoach();

  try {
    const res = coachRespond(text, { user, plan, adaptation, today: new Date() });
    const changed = await applyCoachActions(res.actions || []);

    if (changed) {
      viewedWeek = null;
      rebuild();
      await persistFitness();
    }

    // Short, human-readable summary of what actually moved.
    const changes = [];
    for (const a of res.actions || []) {
      if (a.type === "logActual") changes.push(`Logged ${WEEKDAYS_SHORT[(parseDateKey(a.dateKey).getDay() + 6) % 7]}`);
      if (a.type === "blockDates") changes.push(`${a.dates.length} day${a.dates.length === 1 ? "" : "s"} blocked`);
      if (a.type === "moveSession") changes.push("Session moved");
      if (a.type === "setLoad") changes.push(`Load ${Math.round(a.factor * 100)}%`);
      if (a.type === "softenDays") changes.push("Impact removed");
      if (a.type === "addRecurringSessions") changes.push(`+${a.weekdays.length} weekly session${a.weekdays.length === 1 ? "" : "s"}`);
      if (a.type === "removeRecurringSessions") changes.push("Session removed");
      if (a.type === "setExerciseRules") changes.push("Exercises updated");
      if (a.type === "swapDays") changes.push("Days swapped");
      if (a.type === "setSchedule") changes.push("Schedule updated");
      if (a.type === "recordResult") changes.push("Fitness recalculated");
      if (a.type === "addInjuryFocus") changes.push("Prehab added");
    }

    await appendChat({ role: "coach", text: res.reply, at: Date.now(), changes, intent: res.intent });
    renderCoach();
    if (changed) { renderToday(); renderWeek(); renderPlanOverview(); renderProfile(); }
    if ((res.actions || []).some((a) => a.type === "openGoalEditor")) {
      switchTab("profile");
      setTimeout(openGoalEditor, 300);
    }
  } catch (e) {
    console.error(e);
    await appendChat({
      role: "coach",
      text: "Something went wrong on my end and I couldn't apply that. Your plan is unchanged — try rephrasing it.",
      at: Date.now(),
      changes: [],
    });
    renderCoach();
  } finally {
    coachBusy = false;
    $("#coach-send").disabled = false;
    input.focus();
  }
}

function initCoach() {
  $("#coach-send").addEventListener("click", sendToCoach);
  $("#coach-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendToCoach(); }
  });
}

// ---------------------------------------------------------------- shell

function switchTab(name) {
  $$(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$("#main-app .view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  window.scrollTo(0, 0);
}

function renderAll() {
  renderToday();
  renderWeek();
  renderPlanOverview();
  renderProfile();
  renderCoach();
}

// One of: "auth" | "onboard" | "app"
// One of: "auth" | "verify" | "onboard" | "app"
function showScreen(name) {
  $("#view-auth").classList.toggle("active", name === "auth");
  $("#view-verify").classList.toggle("active", name === "verify");
  $("#view-onboard").classList.toggle("active", name === "onboard");
  $("#main-app").classList.toggle("hidden", name !== "app");
}

function enterApp() {
  showScreen("app");
  if (DEMO) $("#demo-banner").classList.remove("hidden");
  renderAll();
  switchTab("today");
}

function initShell() {
  $$(".tab-btn").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
  initCoach();
  $("#week-prev").addEventListener("click", () => { if (viewedWeek > 1) { viewedWeek--; renderWeek(); } });
  $("#week-next").addEventListener("click", () => { if (viewedWeek < plan.totalWeeks) { viewedWeek++; renderWeek(); } });
}

function fatal(msg) {
  $("#view-auth").innerHTML = `<div class="card empty-state">${escapeHtml(msg)}</div>`;
  showScreen("auth");
}

// Loads the signed-in user's plan, or sends them to onboarding if they have none.
async function loadForUid() {
  if (!DEMO && auth?.currentUser && !auth.currentUser.emailVerified) {
    renderVerify(auth.currentUser);
    showScreen("verify");
    return;
  }
  try {
    const found = await fetchUser(currentUid());
    if (found) {
      user = found;
      // Drop blocked days and moves from weeks that have already passed.
      const pruned = pruneCoachOverrides(user.coachOverrides);
      if (pruned) {
        user.coachOverrides = pruned;
        persistDoc({ coachOverrides: pruned }).catch((e) => console.error(e));
      }
      rebuild();
      persistFitness();
      enterApp();
    } else {
      showScreen("onboard");
      renderOnboarding();
    }
  } catch (e) {
    console.error(e);
    fatal("Couldn't reach the database. Check the Firestore setup and rules in the README, then reload.");
  }
}

async function boot() {
  initShell();

  if (DEMO) {
    if (!localStorage.getItem(DEMO_UID_KEY)) {
      localStorage.setItem(DEMO_UID_KEY, `demo-${Math.random().toString(36).slice(2, 10)}`);
    }
    await loadForUid();
    return;
  }

  if (!auth || firebaseConfig.apiKey === "REPLACE_ME") {
    fatal("Firebase isn't configured yet. Fill in firebase-config.js (see README), or add ?demo=1 to the URL to try the app without a backend.");
    return;
  }

  onAuthStateChanged(auth, async (fbUser) => {
    if (!fbUser) {
      stopVerifyPolling();
      user = null; plan = null; adaptation = null; viewedWeek = null;
      feasibilityAcknowledged = false;
      renderAuth();
      showScreen("auth");
      return;
    }

    // Google sign-in arrives already verified — Google has proven the address.
    // Email/password accounts must confirm before they can create or read a plan.
    if (!fbUser.emailVerified) {
      renderVerify(fbUser);
      showScreen("verify");
      return;
    }

    stopVerifyPolling();
    await loadForUid();
  });
}

boot();
