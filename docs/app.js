/* GOODTrackBets — Keeneland frontend
 *
 * Loads the day's race card from the repo, lets the user edit odds /
 * scratch horses / add also-eligibles from their phone, then fires a
 * GitHub repository_dispatch to trigger predict.yml. Polls the committed
 * predictions.json until a fresh one shows up, then renders ranked
 * predictions with edge (model prob - market prob).
 */

// ---------- Config ----------
const OWNER = "greygoodwin";
const REPO = "GOODTrackBets";
const BRANCH = "main";

// Directory holding the day-cards and filename pattern.
// Cards are named <TRACK_CODE>_YYYY-MM-DD.csv (e.g. KEE_2026-04-16.csv).
// Track codes match the canonical 2-4 letter codes from the historical
// dataset, so adding cards for any track on the TRACK_NAME_BY_CODE map
// below is automatic.
const CARDS_DIR = "HorseRacing";
const CARD_REGEX = /^([A-Z]{2,4})_(\d{4}-\d{2}-\d{2})\.csv$/;

// Generated from all_tracks_hackathon.csv (123 tracks). A handful of
// truncated/weirdly-cased names from the source data have been overridden
// for readability. To extend: add the canonical 2-4 letter track code as
// the key and the display name as the value.
const TRACK_NAME_BY_CODE = {
  AIK: "Aiken", AJX: "Ajax Downs", ALB: "Albuquerque", AQU: "Aqueduct",
  ARP: "Arapahoe Park", ASD: "Assiniboia Downs", ATO: "Atokad Downs",
  BAQ: "Belmont At The Big A", BEL: "Belmont Park", BKF: "Black Foot",
  BTP: "Belterra Park", CAM: "Camden", CAS: "Cassia County Fair",
  CBY: "Canterbury Park", CD: "Churchill Downs", CHA: "Charleston",
  CHE: "Cheshire", CHL: "Charlotte", CLS: "Columbus", CNL: "Colonial Downs",
  CPW: "Chippewa Downs", CT: "Charles Town", CTD: "Century Downs",
  CTM: "Century Mile", DED: "Delta Downs", DEL: "Delaware Park",
  DG: "Cochise County Fair (Douglas)", DMR: "Del Mar",
  EDR: "Energy Downs 307 Racing", ELK: "Elko County Fair",
  ELP: "Ellis Park", EMD: "Emerald Downs", EVD: "Evangeline Downs",
  FAN: "Fanduel Horse Racing", FAR: "North Dakota Horse Park",
  FE: "Fort Erie", FER: "Ferndale", FG: "Fair Grounds", FH: "Far Hills",
  FL: "Finger Lakes", FMT: "Fair Meadows", FNO: "Fresno",
  FON: "Fonner Park", FPL: "Fair Play Park", FTP: "Fort Pierre",
  FX: "Foxfield", GF: "Great Falls", GG: "Golden Gate Fields",
  GIL: "Gillespie County Fairground", GLN: "Glyndon", GN: "Grand National",
  GP: "Gulfstream Park", GPR: "Grande Prairie", GRM: "Great Meadow",
  GRP: "Grants Pass", GV: "Genesee Valley", HAW: "Hawthorne",
  HOU: "Sam Houston Race Park", HPO: "Horsemen's Park", HST: "Hastings",
  IND: "Horseshoe Indianapolis", JRM: "Jerome County Fair",
  KD: "Kentucky Downs", KEE: "Keeneland",
  LA: "Los Alamitos (Quarter Horse)", LAD: "Louisiana Downs",
  LBG: "Lethbridge", LEG: "Legacy Downs",
  LRC: "Los Alamitos (Thoroughbred)", LRL: "Laurel Park",
  LS: "Lone Star Park", MAL: "Malvern", MC: "Miles City",
  MED: "Meadowlands", MID: "Middleburg", MIL: "Millarville",
  MNR: "Mountaineer Race Track", MON: "Monkton", MTH: "Monmouth Park",
  MTP: "Montpelier", MVR: "Mahoning Valley Race Course",
  ODH: "Old Dominion Hounds", ONE: "Oneida County Fair", OP: "Oaklawn Park",
  PEN: "Penn National", PIM: "Pimlico", PLN: "Pleasanton",
  PMT: "Pine Mountain-Calloway Garden", POD: "Pocatello Downs",
  PRM: "Prairie Meadows", PRV: "Crooked River Roundup", PRX: "Parx Racing",
  PW: "Percy Warner", RET: "Retama Park", RIL: "Rillito",
  RP: "Remington Park", RUI: "Ruidoso Downs", SA: "Santa Anita Park",
  SAC: "Sacramento", SAR: "Saratoga", SHW: "Shawan Downs",
  SON: "Santa Cruz County Fair", SR: "Santa Rosa",
  SRM: "Sandy Ridge At The Red Mile", SRP: "Sunray Park",
  SUN: "Sunland Park", SWF: "Sweetwater County Fair",
  TAM: "Tampa Bay Downs", TDN: "Thistledown", TIL: "Tillamook County Fair",
  TIM: "Timonium", TP: "Turfway Park", TRY: "Tryon", TUP: "Turf Paradise",
  UN: "Eastern Oregon Livestock Show", UNI: "Unionville",
  WBR: "Weber Downs", WIL: "Willowdale Steeplechase", WNT: "Winterthur",
  WO: "Woodbine", WRD: "Will Rogers Downs", WYO: "Wyoming Downs",
  ZIA: "Zia Park",
};

function trackDisplay(code) {
  return (code || "").toUpperCase();
}
function trackName(code) {
  const k = (code || "").toUpperCase();
  return TRACK_NAME_BY_CODE[k] || k;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
function ordinalSuffix(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return "th";
  switch (n % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}
function formatLongDate(yyyymmdd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyymmdd || "");
  if (!m) return yyyymmdd || "";
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  return `${MONTH_NAMES[month - 1]} ${day}${ordinalSuffix(day)}, ${year}`;
}

const PREDICTIONS_PATH = "predictions.json";
const DISPATCH_EVENT_TYPE = "predict";

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 180_000;

const SELECTED_DATE_KEY = "goodtrackbets_selected_date";

// ---------- State ----------
const state = {
  availableCards: [],  // [{date, path}] sorted newest-first
  selectedDate: null,  // "YYYY-MM-DD"
  card: null,          // { races: { "1": [horse, ...], ... }, raceNumbers: [1,2,...] }
  currentRace: null,   // string
  edits: {             // mutable overlay on top of card
    overrides: {},     // key -> new odds (number)
    scratches: new Set(),
    added: [],         // [{race_number, horse_name, jockey, trainer, post_position, dollar_odds}]
  },
  predictions: null,   // {generated_at, races: {...}}
  pollTimer: null,
  pollStartedAt: null,
};

function selectedCardPath() {
  if (!state.selectedDate) return null;
  const hit = state.availableCards.find((c) => c.date === state.selectedDate);
  return hit ? hit.path : null;
}

function clearEdits() {
  state.edits.overrides = {};
  state.edits.scratches = new Set();
  state.edits.added = [];
  state.predictions = null;
}

// ---------- DOM helpers ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function setStatus(text, kind = "idle") {
  const el = $("#status-pill");
  el.textContent = text;
  el.className = `pill pill-${kind}`;
}

// ---------- PAT management ----------
const PAT_KEY = "goodtrackbets_pat";
function getPAT() {
  return localStorage.getItem(PAT_KEY) || "";
}
function setPAT(tok) {
  localStorage.setItem(PAT_KEY, tok);
}
function clearPAT() {
  localStorage.removeItem(PAT_KEY);
}

function promptPAT() {
  return new Promise((resolve) => {
    const modal = $("#pat-modal");
    modal.classList.remove("hidden");
    $("#pat-input").value = "";
    $("#pat-input").focus();
    const onSave = () => {
      const tok = $("#pat-input").value.trim();
      if (!tok) return;
      setPAT(tok);
      modal.classList.add("hidden");
      $("#pat-save").removeEventListener("click", onSave);
      $("#pat-cancel").removeEventListener("click", onCancel);
      resolve(tok);
    };
    const onCancel = () => {
      modal.classList.add("hidden");
      $("#pat-save").removeEventListener("click", onSave);
      $("#pat-cancel").removeEventListener("click", onCancel);
      resolve(null);
    };
    $("#pat-save").addEventListener("click", onSave);
    $("#pat-cancel").addEventListener("click", onCancel);
  });
}

async function ensurePAT() {
  let tok = getPAT();
  if (!tok) {
    tok = await promptPAT();
  }
  return tok;
}

// ---------- GitHub API ----------
async function ghContents(path) {
  // Uses Contents API for fresh reads (bypasses raw CDN caching).
  const tok = await ensurePAT();
  if (!tok) throw new Error("PAT required");
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(path)}?ref=${BRANCH}&t=${Date.now()}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${tok}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub contents API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  // data.content is base64 w/ newlines
  const decoded = atob(data.content.replace(/\n/g, ""));
  // Handle UTF-8
  try {
    return decodeURIComponent(escape(decoded));
  } catch {
    return decoded;
  }
}

async function ghDispatch(payload) {
  const tok = await ensurePAT();
  if (!tok) throw new Error("PAT required");
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tok}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: DISPATCH_EVENT_TYPE,
      client_payload: payload,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Dispatch failed ${res.status}: ${body}`);
  }
}

async function ghListDir(path) {
  // Returns an array of {name, path, type} from the directory listing.
  const tok = await ensurePAT();
  if (!tok) throw new Error("PAT required");
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(path)}?ref=${BRANCH}&t=${Date.now()}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${tok}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHub list API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data;
}

// ---------- CSV parsing ----------
function parseCSV(text) {
  // Quote-aware line-by-line split.
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else { inQuotes = false; }
      } else { cell += c; }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
      else if (c === "\r") { /* skip */ }
      else { cell += c; }
    }
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }

  const header = rows.shift().map((h) => h.trim());
  const out = [];
  for (const r of rows) {
    if (r.length === 1 && r[0] === "") continue;
    const obj = {};
    header.forEach((h, i) => { obj[h] = r[i] ?? ""; });
    out.push(obj);
  }
  return out;
}

function horseKey(raceNum, horseName) {
  return `${raceNum}::${horseName}`;
}

function postPositionFor(raceNum, horseName) {
  const base = state.card?.races?.[raceNum] || [];
  const hit = base.find((h) => h.horse_name === horseName)
    || state.edits.added.find((h) => String(h.race_number) === raceNum && h.horse_name === horseName);
  return hit ? (hit.post_position ?? "") : "";
}

function gateBadgeHtml(gate, size) {
  if (gate === "" || gate == null) return "";
  const n = Number(gate);
  if (!Number.isInteger(n) || n < 1 || n > 20) return String(gate);
  const sizeClass = size === "sm" ? " gate-badge--sm" : "";
  return `<span class="gate-badge gate-${n}${sizeClass}">${n}</span>`;
}

// ---------- Load card ----------
async function loadAvailableCards() {
  // Discover all <CODE>_YYYY-MM-DD.csv files in HorseRacing/.
  const items = await ghListDir(CARDS_DIR);
  const cards = [];
  for (const it of items) {
    if (it.type !== "file") continue;
    const m = CARD_REGEX.exec(it.name);
    if (m) cards.push({ track: m[1].toUpperCase(), date: m[2], path: it.path });
  }
  cards.sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first
  state.availableCards = cards;

  // Decide which date to load: persisted pick (if still valid) else newest.
  const stored = localStorage.getItem(SELECTED_DATE_KEY);
  if (stored && cards.some((c) => c.date === stored)) {
    state.selectedDate = stored;
  } else if (cards.length) {
    state.selectedDate = cards[0].date;
  } else {
    state.selectedDate = null;
  }
  renderDatePicker();
}

async function loadCard() {
  setStatus("loading", "running");
  try {
    await loadAvailableCards();

    if (!state.selectedDate) {
      setStatus("no cards", "error");
      $("#race-title").textContent = "No cards found";
      $("#race-meta").textContent =
        `Commit a file matching ${CARDS_DIR}/<TRACK>_YYYY-MM-DD.csv, then tap 'reload card'.`;
      $("#entries-body").innerHTML = "";
      $("#race-tabs").innerHTML = "";
      return;
    }

    const path = selectedCardPath();
    const csv = await ghContents(path);
    if (!csv) {
      setStatus("no card", "error");
      $("#race-title").textContent = `No card at ${path}`;
      $("#race-meta").textContent = "File appeared in listing but couldn't be read.";
      return;
    }
    const rows = parseCSV(csv);
    const races = {};
    const raceNumbers = [];
    for (const r of rows) {
      const rn = String(parseInt(r.race_number, 10));
      if (!races[rn]) { races[rn] = []; raceNumbers.push(parseInt(rn, 10)); }
      races[rn].push(r);
    }
    raceNumbers.sort((a, b) => a - b);
    state.card = { races, raceNumbers: raceNumbers.map(String) };
    if (!state.currentRace || !races[state.currentRace]) {
      state.currentRace = state.card.raceNumbers[0];
    }
    renderTabs();
    renderRace();
    $("#results-section").classList.add("hidden");
    setStatus("idle", "idle");

    // Rehydrate any prior per-race predictions for this (track, card_date).
    const hit = state.availableCards.find((c) => c.date === state.selectedDate);
    if (hit) {
      loadStoredPredictionsForCard(hit.track, hit.date).catch((err) => {
        console.warn("rehydrate failed:", err.message);
      });
    }
  } catch (err) {
    console.error(err);
    setStatus("load error", "error");
    $("#race-title").textContent = "Error loading card";
    $("#race-meta").textContent = err.message;
  }
}

// Scan predictions/ for prior runs matching this (track_code, card_date)
// and merge the most recent per race into state.predictions. Newer runIds
// sort lexicographically larger, so we walk filenames in descending order
// and stop once every race in the card is covered.
async function loadStoredPredictionsForCard(trackCode, cardDate) {
  if (!trackCode || !cardDate || !state.card) return;
  const wantTrack = trackCode.toUpperCase();
  const entries = await ghListDir("predictions");
  const runFiles = entries
    .filter((e) => e.type === "file" && /^run_.+\.json$/.test(e.name))
    .sort((a, b) => (a.name < b.name ? 1 : -1));  // newest first

  const needRaces = new Set(state.card.raceNumbers);
  for (const entry of runFiles) {
    if (!needRaces.size) break;
    let data;
    try {
      const text = await ghContents(entry.path);
      if (!text) continue;
      data = JSON.parse(text);
    } catch (e) {
      console.warn(`skip ${entry.name}: ${e.message}`);
      continue;
    }
    if ((data.track_code || "").toUpperCase() !== wantTrack) continue;
    if (data.card_date !== cardDate) continue;
    let used = false;
    for (const rn of Object.keys(data.races || {})) {
      if (needRaces.has(rn)) {
        const sameScope =
          state.predictions &&
          state.predictions.track_code === wantTrack &&
          state.predictions.card_date === cardDate;
        if (!sameScope) {
          state.predictions = {
            generated_at: data.generated_at,
            track_code: wantTrack,
            card_date: cardDate,
            races: {},
          };
        }
        state.predictions.races[rn] = data.races[rn];
        needRaces.delete(rn);
        used = true;
      }
    }
    if (used && state.currentRace && state.predictions?.races?.[state.currentRace]) {
      // Render as soon as the current race becomes available.
      renderResults();
      renderBets();
    }
  }
}

function renderDatePicker() {
  const sel = $("#date-picker");
  if (!sel) return;
  sel.innerHTML = "";
  if (!state.availableCards.length) {
    const opt = document.createElement("option");
    opt.textContent = "— no cards —";
    opt.disabled = true;
    opt.selected = true;
    sel.appendChild(opt);
    sel.disabled = true;
    renderCardBanner();
    return;
  }
  sel.disabled = false;
  for (const c of state.availableCards) {
    const opt = document.createElement("option");
    opt.value = c.date;
    opt.textContent = `${trackDisplay(c.track)}  ${c.date}`;
    if (c.date === state.selectedDate) opt.selected = true;
    sel.appendChild(opt);
  }
  renderCardBanner();
}

function renderCardBanner() {
  const el = $("#card-banner");
  if (!el) return;
  const hit = state.availableCards.find((c) => c.date === state.selectedDate);
  if (!hit) { el.textContent = ""; return; }
  const parts = [trackName(hit.track), formatLongDate(hit.date)];
  if (state.currentRace) parts.push(`Race ${state.currentRace}`);
  el.textContent = parts.join(" · ");
}

function onDateChange(ev) {
  const newDate = ev.target.value;
  if (!newDate || newDate === state.selectedDate) return;
  state.selectedDate = newDate;
  localStorage.setItem(SELECTED_DATE_KEY, newDate);
  clearEdits();
  state.currentRace = null;
  loadCard();
}

// ---------- Render ----------
function renderTabs() {
  const tabs = $("#race-tabs");
  tabs.innerHTML = "";
  for (const rn of state.card.raceNumbers) {
    const b = document.createElement("button");
    b.className = "race-tab" + (rn === state.currentRace ? " active" : "");
    b.textContent = `R${rn}`;
    b.addEventListener("click", () => {
      state.currentRace = rn;
      renderTabs();
      renderCardBanner();
      renderRace();
      if (state.predictions) { renderResults(); renderBets(); }
    });
    tabs.appendChild(b);
  }
  renderCardBanner();
}

function currentRaceHorses() {
  const rn = state.currentRace;
  const base = (state.card.races[rn] || []).map((h) => ({ ...h, _added: false }));
  const added = state.edits.added
    .filter((h) => String(h.race_number) === rn)
    .map((h) => ({ ...h, _added: true }));
  return [...base, ...added];
}

function renderRace() {
  const rn = state.currentRace;
  if (!rn) return;
  const horses = currentRaceHorses();

  $("#race-title").textContent = `Race ${rn}`;
  const first = horses[0] || {};
  const metaBits = [];
  if (first.race_type) metaBits.push(first.race_type);
  if (first.purse) metaBits.push(`$${parseInt(first.purse, 10).toLocaleString()}`);
  if (first.surface) metaBits.push(first.surface);
  if (first.distance) metaBits.push(`${first.distance}${(first.distance_unit || "").toLowerCase()}`);
  if (first.track_condition) metaBits.push(first.track_condition);
  $("#race-meta").textContent = metaBits.join(" · ");

  const body = $("#entries-body");
  body.innerHTML = "";

  for (const h of horses) {
    const tr = document.createElement("tr");
    const key = horseKey(rn, h.horse_name);
    const scratched = state.edits.scratches.has(key);
    if (scratched) tr.classList.add("scratched");
    if (h._added) tr.classList.add("added");

    // Scratch toggle
    const tdS = document.createElement("td");
    tdS.className = "col-scratch";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "scratch-box";
    cb.checked = scratched;
    cb.addEventListener("change", () => {
      if (cb.checked) state.edits.scratches.add(key);
      else state.edits.scratches.delete(key);
      renderRace();
    });
    tdS.appendChild(cb);
    tr.appendChild(tdS);

    // Post position
    const tdPP = document.createElement("td");
    tdPP.className = "col-pp";
    const ppBadge = gateBadgeHtml(h.post_position);
    if (ppBadge) tdPP.innerHTML = ppBadge;
    else tdPP.textContent = h.post_position || "";
    tr.appendChild(tdPP);

    // Horse / jockey / trainer
    const tdH = document.createElement("td");
    tdH.className = "col-horse";
    const hn = document.createElement("div");
    hn.className = "horse-name";
    hn.textContent = h.horse_name;
    const jt = document.createElement("div");
    jt.className = "jt";
    jt.textContent = `${h.jockey || "—"} / ${h.trainer || "—"}`;
    tdH.appendChild(hn);
    tdH.appendChild(jt);
    tr.appendChild(tdH);

    // Odds input
    const tdO = document.createElement("td");
    tdO.className = "col-odds";
    const inp = document.createElement("input");
    inp.type = "number";
    inp.step = "0.1";
    inp.min = "0";
    inp.inputMode = "decimal";
    const override = state.edits.overrides[key];
    inp.value = override !== undefined ? override : (h.dollar_odds || "");
    inp.disabled = scratched;
    inp.addEventListener("input", () => {
      const v = parseFloat(inp.value);
      if (isNaN(v)) delete state.edits.overrides[key];
      else state.edits.overrides[key] = v;
    });
    tdO.appendChild(inp);
    tr.appendChild(tdO);

    body.appendChild(tr);
  }
}

// ---------- Add horse modal ----------
function openAddModal() {
  const modal = $("#add-modal");
  modal.classList.remove("hidden");
  ["add-name", "add-jockey", "add-trainer", "add-post", "add-odds"].forEach((id) => {
    $("#" + id).value = "";
  });
  $("#add-name").focus();
}

function closeAddModal() {
  $("#add-modal").classList.add("hidden");
}

function confirmAddModal() {
  const name = $("#add-name").value.trim();
  const jockey = $("#add-jockey").value.trim();
  const trainer = $("#add-trainer").value.trim();
  const post = parseInt($("#add-post").value, 10);
  const odds = parseFloat($("#add-odds").value);
  if (!name) { alert("Horse name required"); return; }
  state.edits.added.push({
    race_number: state.currentRace,
    horse_name: name,
    jockey: jockey || "",
    trainer: trainer || "",
    post_position: isNaN(post) ? "" : post,
    dollar_odds: isNaN(odds) ? "" : odds,
  });
  closeAddModal();
  renderRace();
}

// ---------- Run Model ----------
function generateRunId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(16).slice(2, 6);
  return `${ts}_${rand}`;
}

function buildEditsPayload(runId) {
  const overrides = {};
  for (const [k, v] of Object.entries(state.edits.overrides)) {
    overrides[k] = v;
  }
  return {
    run_id: runId,
    overrides,
    scratches: Array.from(state.edits.scratches),
    added: state.edits.added,
    card_path: selectedCardPath(),
    race_number: state.currentRace ? Number(state.currentRace) : null,
    requested_at: new Date().toISOString(),
  };
}

async function runModel() {
  const btn = $("#run-btn");
  btn.disabled = true;
  setStatus("dispatching", "running");
  $("#results-section").classList.add("hidden");

  const runId = generateRunId();
  try {
    await ghDispatch(buildEditsPayload(runId));
    setStatus("running", "running");
    await pollPredictions(runId);
    setStatus("done", "done");
    renderResults();
    renderBets();
  } catch (err) {
    console.error(err);
    setStatus("error", "error");
    alert("Run failed: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

async function pollPredictions(runId) {
  const start = Date.now();
  const predPath = `predictions/run_${runId}.json`;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const text = await ghContents(predPath);
      if (text) {
        const incoming = JSON.parse(text);
        mergePredictions(incoming);
        return;
      }
    } catch (e) {
      console.warn("poll err:", e.message);
    }
  }
  throw new Error("Timed out waiting for predictions (>3 min)");
}

// Merge a single-race prediction file into state.predictions. Existing
// races for the current (track, card_date) are preserved; only the races
// present in `incoming` are overwritten. If the incoming file belongs to
// a different track or card_date, it's treated as a fresh slate.
function mergePredictions(incoming) {
  if (!incoming || !incoming.races) return;
  const sameScope =
    state.predictions &&
    state.predictions.track_code === incoming.track_code &&
    state.predictions.card_date === incoming.card_date;
  if (!sameScope) {
    state.predictions = {
      generated_at: incoming.generated_at,
      track_code: incoming.track_code,
      card_date: incoming.card_date,
      races: { ...incoming.races },
    };
    return;
  }
  state.predictions.generated_at = incoming.generated_at;
  for (const [rn, horses] of Object.entries(incoming.races)) {
    state.predictions.races[rn] = horses;
  }
}

function renderResults() {
  const section = $("#results-section");
  const body = $("#results-body");
  const meta = $("#results-meta");
  body.innerHTML = "";

  const rn = state.currentRace;
  const race = state.predictions?.races?.[rn];
  if (!race) {
    meta.textContent = `No predictions for race ${rn}`;
    section.classList.remove("hidden");
    return;
  }

  const when = new Date(state.predictions.generated_at);
  meta.textContent = `Generated ${when.toLocaleTimeString()}`;

  for (const h of race) {
    const tr = document.createElement("tr");
    if (h.rank === 1) tr.classList.add("top1");
    else if (h.rank <= 3) tr.classList.add("top3");

    const gate = postPositionFor(rn, h.horse_name);
    const cells = [
      h.rank,
      h.horse_name,
      gate !== "" ? gate : "—",
      h.predicted_finish != null ? h.predicted_finish.toFixed(2) : "—",
      h.odds != null ? h.odds.toFixed(1) : "—",
      (h.model_prob * 100).toFixed(1) + "%",
      h.market_prob != null ? (h.market_prob * 100).toFixed(1) + "%" : "—",
      "",
    ];
    cells.forEach((v, i) => {
      const td = document.createElement("td");
      if (i === 2) {
        td.className = "col-gate";
        const badge = gateBadgeHtml(gate);
        if (badge) td.innerHTML = badge;
        else td.textContent = "—";
      } else {
        td.textContent = v;
      }
      tr.appendChild(td);
    });

    // Edge cell with color
    const edgeCell = tr.lastChild;
    if (h.edge != null) {
      const pct = (h.edge * 100).toFixed(1) + "%";
      edgeCell.textContent = (h.edge > 0 ? "+" : "") + pct;
      edgeCell.className = h.edge > 0.02 ? "edge-positive" : h.edge < -0.02 ? "edge-negative" : "";
    } else {
      edgeCell.textContent = "—";
    }

    body.appendChild(tr);
  }
  section.classList.remove("hidden");
}

// ---------- Recommended Bets (suitcases) ----------
// Keeneland approximate takeout rates
const TAKEOUT = { exacta: 0.19, trifecta: 0.24, superfecta: 0.24 };
const BASE_BET = 2;

function probFromOdds(odds) {
  if (odds == null || odds <= 0) return null;
  return 1 / (odds + 1);
}

function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const result = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const perm of permutations(rest)) {
      result.push([arr[i], ...perm]);
    }
  }
  return result;
}

function estimateExoticPayout(horses, numPositions, takeoutRate) {
  // horses = array of {horse_name, odds} in a specific finishing order.
  // Estimate P(this exact order) using conditional probabilities from win odds.
  // Then payout = $2 / P(order) * (1 - takeout).
  const probs = horses.map((h) => probFromOdds(h.odds));
  if (probs.some((p) => p == null)) return null;

  let comboProb = 1;
  let usedProb = 0;
  for (let i = 0; i < numPositions; i++) {
    const conditionalProb = probs[i] / (1 - usedProb);
    comboProb *= conditionalProb;
    usedProb += probs[i];
  }

  if (comboProb <= 0 || !isFinite(comboProb)) return null;
  return (BASE_BET / comboProb) * (1 - takeoutRate);
}

function computeBetType(raceHorses, numHorses, numPositions, takeoutRate) {
  // raceHorses: top N from predictions, sorted by rank.
  // numHorses: how many to include in the box.
  // numPositions: 2 for exacta, 3 for trifecta, 4 for superfecta.
  const selected = raceHorses.slice(0, numHorses);
  if (selected.length < numHorses) return null;
  if (selected.some((h) => h.odds == null || h.odds <= 0)) return null;

  const perms = permutations(selected).map((perm) => perm.slice(0, numPositions));
  // Deduplicate (when numPositions < numHorses, permutations of remaining positions don't matter)
  const seen = new Set();
  const uniquePerms = [];
  for (const p of perms) {
    const key = p.map((h) => h.horse_name).join("|");
    if (!seen.has(key)) {
      seen.add(key);
      uniquePerms.push(p);
    }
  }

  const payouts = [];
  for (const perm of uniquePerms) {
    const payout = estimateExoticPayout(perm, numPositions, takeoutRate);
    if (payout != null) payouts.push(payout);
  }

  if (!payouts.length) return null;

  const numCombos = uniquePerms.length;
  const cost = numCombos * BASE_BET;
  const minPayout = Math.min(...payouts);
  const maxPayout = Math.max(...payouts);

  return {
    horses: selected.map((h) => h.horse_name),
    numCombos,
    cost,
    minProfit: Math.round(minPayout - cost),
    maxProfit: Math.round(maxPayout - cost),
  };
}

const BET_TYPES = [
  { label: "Exacta Box", sub: "Top 2", numHorses: 2, positions: 2, takeout: TAKEOUT.exacta },
  { label: "Exacta Box", sub: "Top 3", numHorses: 3, positions: 2, takeout: TAKEOUT.exacta },
  { label: "Trifecta Box", sub: "Top 3", numHorses: 3, positions: 3, takeout: TAKEOUT.trifecta },
  { label: "Trifecta Box", sub: "Top 4", numHorses: 4, positions: 3, takeout: TAKEOUT.trifecta },
  { label: "Superfecta Box", sub: "Top 4", numHorses: 4, positions: 4, takeout: TAKEOUT.superfecta },
];

function renderBets() {
  const section = $("#bets-section");
  const grid = $("#bets-grid");
  grid.innerHTML = "";

  const rn = state.currentRace;
  const race = state.predictions?.races?.[rn];
  if (!race || !race.length) {
    section.classList.add("hidden");
    return;
  }

  const horses = race.map((h) => ({
    horse_name: h.horse_name,
    odds: h.odds,
    gate: postPositionFor(rn, h.horse_name),
  }));

  for (const bt of BET_TYPES) {
    const result = computeBetType(horses, bt.numHorses, bt.positions, bt.takeout);
    if (!result) continue;

    const card = document.createElement("div");
    card.className = "bet-card";

    const profitColor = result.minProfit > 0 ? "edge-positive" : "edge-negative";

    const horsesHtml = result.horses
      .map((name) => {
        const gate = postPositionFor(rn, name);
        const badge = gateBadgeHtml(gate, "sm");
        return badge ? `${badge} ${name}` : name;
      })
      .join(" · ");

    card.innerHTML = `
      <div class="bet-label">${bt.label} <span class="bet-sub">${bt.sub}</span></div>
      <div class="bet-horses">${horsesHtml}</div>
      <div class="bet-row">
        <span class="bet-stat">Cost <strong>$${result.cost}</strong></span>
        <span class="bet-stat">Combos <strong>${result.numCombos}</strong></span>
      </div>
      <div class="bet-row">
        <span class="bet-stat">Min profit <strong class="${profitColor}">$${result.minProfit}</strong></span>
        <span class="bet-stat">Max profit <strong class="edge-positive">$${result.maxProfit}</strong></span>
      </div>
    `;
    grid.appendChild(card);
  }

  section.classList.remove("hidden");
}

// ---------- Wire up ----------
function wireEvents() {
  $("#run-btn").addEventListener("click", runModel);
  $("#add-horse-btn").addEventListener("click", openAddModal);
  $("#add-cancel").addEventListener("click", closeAddModal);
  $("#add-confirm").addEventListener("click", confirmAddModal);
  $("#reset-pat-btn").addEventListener("click", () => {
    clearPAT();
    setStatus("token cleared", "idle");
  });
  $("#reload-btn").addEventListener("click", loadCard);
  $("#date-picker").addEventListener("change", onDateChange);
}

// ---------- Boot ----------
(async function boot() {
  wireEvents();
  await loadCard();
})();
