console.log("APP.JS VERSION: polish-v1");

// imports
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
  getFirestore,
  doc,
  onSnapshot,
  collection,
  query,
  orderBy,
  limit,
  runTransaction,
  serverTimestamp,
  where,
  Timestamp,
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

// -------------------- Firebase config --------------------
const firebaseConfig = {
  apiKey: "AIzaSyCUfxcFYLPJu4zJJo0LTjIuowFQ8pDIMNk",
  authDomain: "drinking-a-pool.firebaseapp.com",
  projectId: "drinking-a-pool",
  storageBucket: "drinking-a-pool.firebasestorage.app",
  messagingSenderId: "860458486264",
  appId: "1:860458486264:web:9ade5090f29e438778ae0d"
};

// -------------------- Constants --------------------
const NAME_STORAGE_KEY = "poolUserName";
const DAY_TZ = "America/Los_Angeles";
const MAX_OZ_PER_ENTRY = 256;

// -------------------- Init --------------------
async function initFirebase(config) {
  const app = initializeApp(config);
  const db = getFirestore(app);

  const auth = getAuth(app);
  await signInAnonymously(auth);

  console.log("Signed in:", auth.currentUser?.uid);
  return { app, db, auth };
}

// -------------------- DOM --------------------
function getDom() {
  const dom = {
    // pool
    poolStatus: document.getElementById("pool-status"),
    poolMetrics: document.getElementById("pool-metrics"),
    poolFill: document.getElementById("pool-fill"),
    poolLabel: document.getElementById("pool-label"),
    poolTank: document.querySelector(".pool-tank"),

    // controls
    nameInput: document.getElementById("user-name"),
    drink32Btn: document.getElementById("drink-32"),
    amountInput: document.getElementById("drink-amount"),
    drinkCustomBtn: document.getElementById("drink-custom"),
    undoBtn: document.getElementById("undo-last"),

    // dashboard
    rangeSelect: document.getElementById("range-select"),
    userPicker: document.getElementById("user-picker"),
    rangeChart: document.getElementById("range-chart"),
    totalsCaption: document.getElementById("totals-caption"),
    totalsBody: document.getElementById("totals-body"),

    // recent feed
    logFeed: document.getElementById("log-feed"),

    // toasts
    toastContainer: document.getElementById("toast-container"),
  };

  for (const [key, el] of Object.entries(dom)) {
    if (!el) throw new Error(`Missing DOM element: ${key}`);
  }
  return dom;
}

// -------------------- HTML escaping --------------------
function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// -------------------- Toast + animations --------------------
function showToast(dom, message, detail = "") {
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `
    <div>
      <div>${escapeHtml(message)}</div>
      ${detail ? `<small>${escapeHtml(detail)}</small>` : ""}
    </div>
    <div>💧</div>
  `;
  dom.toastContainer.appendChild(el);

  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity 250ms ease";
    setTimeout(() => el.remove(), 260);
  }, 2200);
}

function pulsePool(dom) {
  dom.poolTank.classList.remove("pulse");
  void dom.poolTank.offsetWidth; // force reflow so animation restarts
  dom.poolTank.classList.add("pulse");
}

function setBusy(dom, isBusy) {
  dom.drink32Btn.disabled = isBusy;
  dom.drinkCustomBtn.disabled = isBusy;
  dom.undoBtn.disabled = isBusy;
}

// -------------------- Name helpers --------------------
function loadSavedName(dom) {
  dom.nameInput.value = localStorage.getItem(NAME_STORAGE_KEY) || "";
}

function enableNameAutosave(dom) {
  dom.nameInput.addEventListener("input", () => {
    localStorage.setItem(NAME_STORAGE_KEY, dom.nameInput.value.trim());
  });
}

// Enforce name (no Anonymous)
function getUserName(dom) {
  const name = (dom.nameInput.value || "").trim();
  if (!name) {
    dom.nameInput.focus();
    throw new Error("Please enter your name before logging a drink.");
  }
  return name;
}

// -------------------- Validation --------------------
function parseAmountOz(raw) {
  const amount = Number(raw);
  if (!Number.isFinite(amount) || !Number.isInteger(amount)) {
    return { ok: false, error: "Enter a whole number." };
  }
  if (amount <= 0) {
    return { ok: false, error: "Enter a number greater than 0." };
  }
  if (amount > MAX_OZ_PER_ENTRY) {
    return { ok: false, error: `That seems high. Enter ${MAX_OZ_PER_ENTRY} or less per entry.` };
  }
  return { ok: true, value: amount };
}

// -------------------- Timezone helpers (LA day boundary) --------------------
function tzParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

// Convert a wall-clock time in a timezone to a real Date (UTC instant).
// Iteratively adjust a UTC guess until timezone-formatted parts match (handles DST).
function zonedWallTimeToDate({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  let guessMs = Date.UTC(year, month - 1, day, hour, minute, second);

  for (let i = 0; i < 6; i++) {
    const p = tzParts(new Date(guessMs), timeZone);
    const cur = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const want = Date.UTC(year, month - 1, day, hour, minute, second);

    const deltaMs = want - cur;
    if (Math.abs(deltaMs) < 1000) return new Date(guessMs);
    guessMs += deltaMs;
  }
  return new Date(guessMs);
}

function startOfTodayInTZ(timeZone) {
  const now = new Date();
  const p = tzParts(now, timeZone);
  return zonedWallTimeToDate({ year: p.year, month: p.month, day: p.day, hour: 0, minute: 0, second: 0 }, timeZone);
}

function startOfTomorrowInTZ(timeZone) {
  const start = startOfTodayInTZ(timeZone);
  const p = tzParts(start, timeZone);
  return zonedWallTimeToDate({ year: p.year, month: p.month, day: p.day + 1, hour: 0, minute: 0, second: 0 }, timeZone);
}

function laDayKeyFromDate(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DAY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function lastNDaysKeysLA(nDays) {
  const end = startOfTomorrowInTZ(DAY_TZ); // exclusive
  const keys = [];
  for (let i = nDays - 1; i >= 0; i--) {
    const d = new Date(end.getTime());
    d.setDate(d.getDate() - i);
    keys.push(laDayKeyFromDate(d));
  }
  return keys;
}

// -------------------- Firestore refs --------------------
function getRefs(db) {
  const poolRef = doc(db, "pool", "main");
  const recentLogsQuery = query(collection(db, "logs"), orderBy("ts", "desc"), limit(20));
  return { poolRef, recentLogsQuery };
}

// Range query (LA boundary). If rangeDays === "all", returns all logs ordered by ts.
function getLogsQueryForRangeLA(db, rangeDays) {
  if (rangeDays === "all") {
    return query(collection(db, "logs"), orderBy("ts", "asc"));
  }

  const n = Number(rangeDays);
  const endDate = startOfTomorrowInTZ(DAY_TZ);
  const startDate = new Date(endDate.getTime());
  startDate.setDate(startDate.getDate() - n);

  const start = Timestamp.fromDate(startDate);
  const end = Timestamp.fromDate(endDate);

  return query(
    collection(db, "logs"),
    where("ts", ">=", start),
    where("ts", "<", end),
    orderBy("ts", "asc")
  );
}

// -------------------- Writes --------------------
async function recordDrink({ db, poolRef, dom, uid }, amountOz) {
  const user = getUserName(dom);

  await runTransaction(db, async (tx) => {
    const poolSnap = await tx.get(poolRef);
    if (!poolSnap.exists()) throw new Error("Pool does not exist");

    const { totalVolumeOz, consumedOz } = poolSnap.data();
    const remaining = totalVolumeOz - consumedOz;

    if (amountOz > remaining) {
      throw new Error(`Only ${remaining} oz left in the pool`);
    }

    tx.update(poolRef, { consumedOz: consumedOz + amountOz });

    const logRef = doc(collection(db, "logs"));
    tx.set(logRef, { uid, user, amountOz, ts: serverTimestamp() });
  });

  return user;
}

async function undoLastDrink({ db, poolRef, uid }) {
  const lastLogQ = query(
    collection(db, "logs"),
    where("uid", "==", uid),
    orderBy("ts", "desc"),
    limit(1)
  );

  const snap = await getDocs(lastLogQ);
  if (snap.empty) throw new Error("No logs to undo.");

  const lastDoc = snap.docs[0];

  await runTransaction(db, async (tx) => {
    // READS FIRST
    const poolSnap = await tx.get(poolRef);
    if (!poolSnap.exists()) throw new Error("Pool does not exist");

    const logSnap = await tx.get(lastDoc.ref);
    if (!logSnap.exists()) throw new Error("That log was already removed. Try again.");

    const amountOz = Number(logSnap.data().amountOz || 0);
    if (!Number.isFinite(amountOz) || amountOz <= 0) {
      throw new Error("Last log has invalid amount.");
    }

    const consumedOz = Number(poolSnap.data().consumedOz || 0);
    const newConsumed = Math.max(0, consumedOz - amountOz);

    // WRITES AFTER READS
    tx.update(poolRef, { consumedOz: newConsumed });
    tx.delete(lastDoc.ref);
  });
}

// -------------------- Subscriptions (pool + recent feed) --------------------
function subscribePool(poolRef, dom, state) {
  return onSnapshot(poolRef, (snap) => {
    if (!snap.exists()) {
      dom.poolStatus.textContent = "Pool not found.";
      return;
    }

    const data = snap.data();
    const total = data.totalVolumeOz ?? 0;
    const consumed = data.consumedOz ?? 0;
    const remaining = total - consumed;

    state.total = total;
    state.consumed = consumed;
    state.remaining = remaining;

    const pctRemaining = total > 0 ? (remaining / total) * 100 : 0;

    dom.poolStatus.textContent = `Remaining: ${remaining} oz`;
    dom.poolMetrics.textContent = `Drained: ${consumed} / ${total} oz (${pctRemaining.toFixed(1)}% left)`;
    dom.poolLabel.textContent = `${pctRemaining.toFixed(1)}% left`;

    // vertical pool uses height
    dom.poolFill.style.height = `${pctRemaining}%`;
  });
}

function subscribeRecentLogs(recentLogsQuery, dom, uid) {
  return onSnapshot(recentLogsQuery, (snap) => {
    if (snap.empty) {
      dom.logFeed.innerHTML = `<div class="muted">No drinks yet — who’s going first?</div>`;
      return;
    }

    const rows = [];
    snap.forEach((docSnap) => {
      const d = docSnap.data();
      const who = d.user ?? "Unknown";
      const amt = d.amountOz ?? "?";
      const mine = d.uid === uid;

      rows.push(`
        <div class="${mine ? "mine" : ""}">
          ${escapeHtml(who)} drank <b>${amt} oz</b>${mine ? " (you)" : ""}
        </div>
      `);
    });

    dom.logFeed.innerHTML = rows.join("");
  });
}

// -------------------- Chart + table aggregation --------------------
function buildDailySeriesForRange(snap, dayKeys) {
  const indexByKey = new Map(dayKeys.map((k, i) => [k, i]));
  const all = Array(dayKeys.length).fill(0);
  const byUser = new Map(); // user -> array(dayKeys.length)

  snap.forEach((docSnap) => {
    const d = docSnap.data();
    const user = d.user || "Unknown";
    const amt = d.amountOz || 0;
    const ts = d.ts;
    if (!ts) return;

    const key = laDayKeyFromDate(ts.toDate());
    const idx = indexByKey.get(key);
    if (idx === undefined) return;

    all[idx] += amt;

    if (!byUser.has(user)) byUser.set(user, Array(dayKeys.length).fill(0));
    byUser.get(user)[idx] += amt;
  });

  return { all, byUser };
}

function renderUserPicker(dom, users, selectedSet) {
  dom.userPicker.innerHTML = "";

  function addRow(labelText, value, bold = false) {
    const row = document.createElement("div");
    row.className = "picker-row";

    const label = document.createElement("label");

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.dataset.user = value;
    cb.checked = selectedSet.has(value);

    const text = document.createElement(bold ? "strong" : "span");
    text.textContent = labelText;

    label.appendChild(cb);
    label.appendChild(text);

    row.appendChild(label);
    dom.userPicker.appendChild(row);
  }

  addRow("All (combined)", "__ALL__", true);

  users
    .slice()
    .sort((a, b) => a.localeCompare(b))
    .forEach((u) => addRow(u, u, false));
}




function getSelectedUsers(dom) {
  const set = new Set();
  dom.userPicker.querySelectorAll("input[type=checkbox]").forEach((cb) => {
    if (cb.checked) set.add(cb.dataset.user);
  });
  return set;
}

function initRangeChart(dom, labels) {
  return new Chart(dom.rangeChart, {
    type: "line",
    data: { labels, datasets: [] },
    options: {
      responsive: true,
      animation: false,
      plugins: { legend: { display: true } },
      scales: { y: { beginAtZero: true } },
    },
  });
}

function updateRangeChart(chart, labels, seriesObj, selectedUsers, meName) {
  const datasets = [];

  if (selectedUsers.has("__ALL__")) {
    datasets.push({
      label: "All",
      data: seriesObj.all,
      tension: 0.25,
      borderWidth: 2,
    });
  }

  for (const user of selectedUsers) {
    if (user === "__ALL__") continue;

    const isMe = meName && user === meName;
    datasets.push({
      label: user + (isMe ? " (you)" : ""),
      data: seriesObj.byUser.get(user) || Array(labels.length).fill(0),
      tension: 0.25,
      borderWidth: isMe ? 4 : 2,
    });
  }

  chart.data.labels = labels;
  chart.data.datasets = datasets;
  chart.update();
}

function renderTotalsTable(dom, seriesObj) {
  const totals = [];
  let grand = 0;

  for (const [user, arr] of seriesObj.byUser.entries()) {
    const sum = arr.reduce((a, b) => a + b, 0);
    totals.push({ user, sum });
    grand += sum;
  }

  totals.sort((a, b) => b.sum - a.sum);

  if (!totals.length) {
    dom.totalsBody.innerHTML = `<tr><td colspan="3" class="muted">No data in this range.</td></tr>`;
    return;
  }

  dom.totalsBody.innerHTML = totals.map((r) => {
    const pct = grand > 0 ? (r.sum / grand) * 100 : 0;
    return `<tr>
      <td>${escapeHtml(r.user)}</td>
      <td class="num">${r.sum}</td>
      <td class="num">${pct.toFixed(1)}%</td>
    </tr>`;
  }).join("");
}

function computeAvgDailyOz(arr) {
  if (!arr.length) return 0;
  const total = arr.reduce((a, b) => a + b, 0);
  return total / arr.length;
}

// -------------------- Dashboard setup --------------------
function setupRangeDashboard({ db, dom, state }) {
  const chart = initRangeChart(dom, []);

  let unsubscribeRange = null;
  let selectedUsers = new Set(["__ALL__"]);

  function resubscribeForRange() {
    if (unsubscribeRange) unsubscribeRange();

    const rangeValue = dom.rangeSelect.value;
    const q = getLogsQueryForRangeLA(db, rangeValue);

    const dayKeys =
      rangeValue === "all"
        ? null
        : lastNDaysKeysLA(Number(rangeValue));

    dom.totalsCaption.textContent =
      rangeValue === "all" ? "All time totals" : `Last ${rangeValue} days totals`;

    unsubscribeRange = onSnapshot(q, (snap) => {
      let labels = dayKeys;
      if (!labels) {
        // keep "all time" chart bounded; still useful
        labels = lastNDaysKeysLA(365);
      }

      const series = buildDailySeriesForRange(snap, labels);
      const users = Array.from(series.byUser.keys());


      renderUserPicker(dom, users, selectedUsers);
      const meName = (dom.nameInput.value || "").trim();
      updateRangeChart(chart, labels, series, selectedUsers, meName);
      renderTotalsTable(dom, series);
    });
  }

  dom.rangeSelect.addEventListener("change", () => {
    resubscribeForRange();
  });

  dom.userPicker.addEventListener("change", () => {
    selectedUsers = getSelectedUsers(dom);
    // simple approach: resubscribe (fine for your data size)
    resubscribeForRange();
  });

  // If user changes their name, update chart labels so "(you)" follows them
  dom.nameInput.addEventListener("input", () => {
    // just refresh the chart rendering using current snapshot by resubscribing
    resubscribeForRange();
  });

  resubscribeForRange();
}

// -------------------- UI wiring --------------------
function wireButtons(ctx) {
  const { dom } = ctx;

  dom.drink32Btn.addEventListener("click", async () => {
    try {
      setBusy(dom, true);
      const name = getUserName(dom); // validate + focus
      await recordDrink(ctx, 32);
      pulsePool(dom);
      showToast(dom, "+32 oz logged", `Logged as ${name}`);
    } catch (err) {
      console.error(err);
      alert(err.message || "Failed to save. Check console.");
    } finally {
      setBusy(dom, false);
    }
  });

  dom.drinkCustomBtn.addEventListener("click", async () => {
    const parsed = parseAmountOz(dom.amountInput.value);
    if (!parsed.ok) {
      alert(parsed.error);
      return;
    }

    try {
      setBusy(dom, true);
      const name = getUserName(dom);
      await recordDrink(ctx, parsed.value);
      pulsePool(dom);
      showToast(dom, `+${parsed.value} oz logged`, `Logged as ${name}`);
      dom.amountInput.value = "";
      dom.amountInput.focus();
    } catch (err) {
      console.error(err);
      alert(err.message || "Failed to save. Check console.");
    } finally {
      setBusy(dom, false);
    }
  });

  dom.undoBtn.addEventListener("click", async () => {
    const ok = confirm("Undo your most recent drink entry?");
    if (!ok) return;

    try {
      setBusy(dom, true);
      await undoLastDrink(ctx);
      pulsePool(dom);
      showToast(dom, "Undid last entry", "Removed your most recent log");
    } catch (err) {
      console.error(err);
      alert(err.message || "Failed to undo. Check console.");
    } finally {
      setBusy(dom, false);
    }
  });

  dom.amountInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") dom.drinkCustomBtn.click();
  });
}

// -------------------- Main --------------------
async function main() {
  const { db, auth } = await initFirebase(firebaseConfig);
  const dom = getDom();
  const { poolRef, recentLogsQuery } = getRefs(db);

  loadSavedName(dom);
  enableNameAutosave(dom);

  const uid = auth.currentUser.uid;

  // shared live state used for pace estimates
  const state = { total: 0, consumed: 0, remaining: 0 };

  const ctx = { db, dom, poolRef, uid };

  subscribePool(poolRef, dom, state);
  subscribeRecentLogs(recentLogsQuery, dom, uid);
  wireButtons(ctx);

  setupRangeDashboard({ db, dom, state });
}

main();