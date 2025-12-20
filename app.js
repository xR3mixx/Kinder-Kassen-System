// =====================
// KKS – Kinderkassa Web App (v1.1.2)
// - Scanner via SSE (/events)
// - EAN-8 + EAN-13 (Pruefziffer-check)
// - Produkte aus products.json + localStorage Overrides
// - BEZAHLT: druckt echten Bon (/print) und startet neuen Bon
// - BON DRUCKEN: druckt nur (ohne neuen Bon)
// - Dezimalzahlen im Admin an/aus
// =====================

// --- Admin PIN ---
const ADMIN_PIN = "1234";

// --- Dateiname fuer Produkte ---
const PRODUCTS_JSON_URL = "products.json"; // muss im selben Ordner liegen

// --- localStorage keys ---
const LS_SETTINGS = "kks_settings";
const LS_PRODUCTS_OVERRIDES = "kks_products_overrides";

// --- Settings (persisted) ---
const defaultSettings = {
  uiMode: "standard",     // "standard" | "kid"
  centMode: "all",        // "all" | "coarse" | "none"
  bigNotes: "off",        // "on" | "off"
  confirmBigNotes: "on",  // "on" | "off"
  sound: "on",            // "on" | "off"
  decimals: "on",         // "on" | "off"
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(LS_SETTINGS);
    if (!raw) return { ...defaultSettings };
    return { ...defaultSettings, ...JSON.parse(raw) };
  } catch (e) {
    return { ...defaultSettings };
  }
}
function saveSettings(s) {
  localStorage.setItem(LS_SETTINGS, JSON.stringify(s));
}

// --- Product overrides persisted ---
function loadOverrides() {
  try {
    const raw = localStorage.getItem(LS_PRODUCTS_OVERRIDES);
    if (!raw) return {};
    return JSON.parse(raw) || {};
  } catch (e) {
    return {};
  }
}
function saveOverrides(o) {
  localStorage.setItem(LS_PRODUCTS_OVERRIDES, JSON.stringify(o));
}

// --- Helpers ---
function onlyDigits(s) {
  return String(s || "").replace(/\D/g, "");
}
function clampInt(n) {
  n = Number(n);
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n);
}
function eur(cents) {
  // Anzeige in der UI
  if (settings.decimals === "off") {
    const euros = Math.round(cents / 100);
    return String(euros) + " €";
  }
  const v = (cents / 100).toFixed(2).replace(".", ",");
  return v + " €";
}
function nowClock() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return hh + ":" + mm;
}
function parseEuroToCents(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  // Wenn Dezimal AUS: nur ganze Zahlen
  if (settings.decimals === "off") {
    const n = Number(raw.replace(/\s/g, ""));
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n * 100);
  }

  const norm = raw.replace(/\s/g, "").replace(",", ".");
  const num = Number(norm);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.round(num * 100);
}

// --- EAN helpers (EAN-13 + EAN-8) ---
function ean13CheckDigit(base12) {
  const s = onlyDigits(base12);
  if (s.length !== 12) return null;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const d = parseInt(s[i], 10);
    sum += (i % 2 === 0) ? d : (3 * d);
  }
  const mod = sum % 10;
  return (10 - mod) % 10;
}
function isValidEan13(ean13) {
  const s = onlyDigits(ean13);
  if (s.length !== 13) return false;
  const base12 = s.slice(0, 12);
  const cd = ean13CheckDigit(base12);
  if (cd === null) return false;
  return cd === parseInt(s[12], 10);
}

function ean8CheckDigit(base7) {
  const s = onlyDigits(base7);
  if (s.length !== 7) return null;
  // weights: 3,1,3,1,3,1,3
  let sum = 0;
  for (let i = 0; i < 7; i++) {
    const d = parseInt(s[i], 10);
    sum += (i % 2 === 0) ? (3 * d) : d;
  }
  const mod = sum % 10;
  return (10 - mod) % 10;
}
function isValidEan8(ean8) {
  const s = onlyDigits(ean8);
  if (s.length !== 8) return false;
  const base7 = s.slice(0, 7);
  const cd = ean8CheckDigit(base7);
  if (cd === null) return false;
  return cd === parseInt(s[7], 10);
}

// normalize: akzeptiert 7/8/12/13 -> gibt 8 oder 13 zurueck
function normalizeCode(codeInput) {
  const s = onlyDigits(codeInput);

  if (s.length === 13) return s;
  if (s.length === 12) {
    const cd = ean13CheckDigit(s);
    return cd === null ? null : (s + String(cd));
  }

  if (s.length === 8) return s;
  if (s.length === 7) {
    const cd = ean8CheckDigit(s);
    return cd === null ? null : (s + String(cd));
  }

  return null;
}

function isValidCode(code) {
  const s = onlyDigits(code);
  if (s.length === 13) return isValidEan13(s);
  if (s.length === 8) return isValidEan8(s);
  return false;
}

// -----------------
// Sound (WebAudio)
// -----------------
let audioCtx = null;
let audioUnlocked = false;

let settings = loadSettings();

function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}
function unlockAudioOnce() {
  if (audioUnlocked) return;
  try {
    const ctx = ensureAudio();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.01);
    audioUnlocked = true;
  } catch (e) {}
}
function playTone(freq, ms, volume, type) {
  if (settings.sound !== "on") return;
  try {
    const ctx = ensureAudio();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type || "square";
    osc.frequency.value = freq;

    const t0 = ctx.currentTime;
    const dur = ms / 1000;

    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(volume || 0.08, t0 + 0.01);
    gain.gain.setValueAtTime(volume || 0.08, t0 + Math.max(0.01, dur - 0.02));
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(t0 + dur);
  } catch (e) {}
}
function soundScanOk()  { playTone(1800, 70, 0.08, "square"); }
function soundError()   { playTone(220, 180, 0.10, "sawtooth"); }
function soundPrintOk() {
  playTone(1200, 60, 0.07, "sine");
  setTimeout(function () { playTone(1500, 60, 0.07, "sine"); }, 70);
}

// --- State ---
let PRODUCTS_BASE = {};
let PRODUCTS_OVERRIDES = loadOverrides();
let PRODUCTS = {};

let cart = []; // {code, name, unitCents, qty}
let givenCents = 0;
let moneyTapHistory = [];
let moneyCounters = new Map();

// --- Denominations ---
const COINS_ALL = [1, 2, 5, 10, 20, 50, 100, 200];
const COINS_COARSE = [10, 20, 50, 100, 200];
const NOTES_BASE = [500, 1000, 2000, 5000];
const NOTES_BIG = [10000, 20000, 50000];

// --- Elements ---
const clockEl = document.getElementById("clock");

const cartBody = document.getElementById("cartBody");
const posCountEl = document.getElementById("posCount");
const sumTotalEl = document.getElementById("sumTotal");
const sumBoxValue = document.getElementById("sumBoxValue");
const givenBoxValue = document.getElementById("givenBoxValue");
const changeBoxValue = document.getElementById("changeBoxValue");
const msgEl = document.getElementById("msg");

const scanInput = document.getElementById("scanInput");
const addByEanBtn = document.getElementById("addByEanBtn");

const clearCartBtn = document.getElementById("clearCartBtn");
const stornoLastBtn = document.getElementById("stornoLastBtn");
const newReceiptBtn = document.getElementById("newReceiptBtn");
const printBtn = document.getElementById("printBtn");

const btnExact = document.getElementById("btnExact");
const btnUndo = document.getElementById("btnUndo");
const btnResetGiven = document.getElementById("btnResetGiven");
const btnPaid = document.getElementById("btnPaid"); // muss im HTML existieren

const coinsGrid = document.getElementById("coinsGrid");
const notesGrid = document.getElementById("notesGrid");
const bigNotesHint = document.getElementById("bigNotesHint");
const scannerStateEl = document.getElementById("scannerState"); // optional

// Admin modal
const adminBtn = document.getElementById("adminBtn");
const adminBackdrop = document.getElementById("adminBackdrop");
const closeAdmin = document.getElementById("closeAdmin");
const adminLocked = document.getElementById("adminLocked");
const adminUnlocked = document.getElementById("adminUnlocked");
const pinInput = document.getElementById("pinInput");
const pinLoginBtn = document.getElementById("pinLoginBtn");
const logoutAdminBtn = document.getElementById("logoutAdminBtn");
const saveSettingsBtn = document.getElementById("saveSettingsBtn");

const uiModeSelect = document.getElementById("uiModeSelect");
const centModeSelect = document.getElementById("centModeSelect");
const bigNotesSelect = document.getElementById("bigNotesSelect");
const confirmBigNotesSelect = document.getElementById("confirmBigNotesSelect");
const soundSelect = document.getElementById("soundSelect");
const decimalsSelect = document.getElementById("decimalsSelect");

// Product admin
const prodEanInput = document.getElementById("prodEanInput");
const prodNameInput = document.getElementById("prodNameInput");
const prodPriceInput = document.getElementById("prodPriceInput");
const prodCalcCheckBtn = document.getElementById("prodCalcCheckBtn");
const prodSaveBtn = document.getElementById("prodSaveBtn");
const prodDeleteBtn = document.getElementById("prodDeleteBtn");
const prodHint = document.getElementById("prodHint");
const prodSearchInput = document.getElementById("prodSearchInput");
const prodListBody = document.getElementById("prodListBody");

// CSV
const exportCsvBtn = document.getElementById("exportCsvBtn");
const importCsvInput = document.getElementById("importCsvInput");
const csvHint = document.getElementById("csvHint");

// --- UI messages ---
function setMsg(text, ok) {
  if (!msgEl) return;
  msgEl.textContent = text || "";
  msgEl.style.color = (ok === false) ? "#ffb4b4" : "var(--muted)";
}
function setProdHint(text, ok) {
  if (!prodHint) return;
  prodHint.textContent = text || "";
  prodHint.style.color = (ok === false) ? "#ffb4b4" : "var(--muted)";
}
function setCsvHint(text, ok) {
  if (!csvHint) return;
  csvHint.textContent = text || "";
  csvHint.style.color = (ok === false) ? "#ffb4b4" : "var(--muted)";
}
function setScannerState(ok) {
  if (!scannerStateEl) return;
  scannerStateEl.textContent = ok ? "Scanner verbunden ✅" : "Scanner getrennt ❌";
}

// --- Products loading/merge ---
function mergeProducts() {
  PRODUCTS = { ...PRODUCTS_BASE, ...PRODUCTS_OVERRIDES };
}

async function loadProductsJson() {
  try {
    const res = await fetch(PRODUCTS_JSON_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();

    // Erwartet: { "EAN": { "name":"", "price": 123 } } (Cent)
    // oder price als Euro-String
    const normalized = {};
    for (const k in (data || {})) {
      if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
      const v = data[k];

      const code = normalizeCode(k);
      if (!code) continue;

      const name = String((v && v.name) ? v.name : "").trim();
      if (!name) continue;

      let priceCents = null;
      if (typeof (v && v.price) === "number") {
        priceCents = Math.round(v.price);
      } else {
        priceCents = parseEuroToCents(v && v.price);
      }
      if (priceCents === null) continue;

      normalized[code] = { name: name, price: priceCents };
    }

    PRODUCTS_BASE = normalized;
    mergeProducts();
    return true;
  } catch (e) {
    PRODUCTS_BASE = {};
    mergeProducts();
    return false;
  }
}

// --- Cart computations ---
function cartTotalCents() {
  return cart.reduce(function (sum, it) {
    return sum + it.unitCents * it.qty;
  }, 0);
}

// --- Cart ops ---
function addItemByCode(codeRaw) {
  const code = normalizeCode(codeRaw);
  if (!code) {
    setMsg("Code muss 7/8 oder 12/13-stellig sein", false);
    soundError();
    return;
  }
  if (!isValidCode(code)) {
    setMsg("Pruefziffer ungueltig (EAN-8/EAN-13)", false);
    soundError();
    return;
  }

  const p = PRODUCTS[code];
  if (!p) {
    setMsg("Code nicht gefunden: " + code, false);
    soundError();
    return;
  }

  const existing = cart.find(function (x) { return x.code === code; });
  if (existing) existing.qty += 1;
  else cart.push({ code: code, name: p.name, unitCents: p.price, qty: 1 });

  soundScanOk();
  setMsg(p.name + " hinzugefuegt", true);
  render();
}

function removeOneIndex(i) {
  const it = cart[i];
  if (!it) return;
  it.qty -= 1;
  if (it.qty <= 0) cart.splice(i, 1);
  render();
}

function clearCart() {
  cart = [];
  resetGiven();
  setMsg("Warenkorb geleert", true);
  render();
}

function stornoLast() {
  if (cart.length === 0) return;
  const last = cart[cart.length - 1];
  last.qty -= 1;
  if (last.qty <= 0) cart.pop();
  setMsg("Letzten Artikel entfernt", true);
  render();
}

function newReceipt() {
  cart = [];
  resetGiven();
  moneyTapHistory = [];
  moneyCounters.clear();
  setMsg("Neuer Bon gestartet", true);
  render();
}

// --- Payment ops ---
function tapMoney(denomCents) {
  denomCents = clampInt(denomCents);
  if (denomCents <= 0) return;

  if ((denomCents >= 10000) && settings.confirmBigNotes === "on") {
    const ok = confirm("Wirklich " + eur(denomCents) + " gegeben?");
    if (!ok) return;
  }

  givenCents += denomCents;
  moneyTapHistory.push(denomCents);
  moneyCounters.set(denomCents, (moneyCounters.get(denomCents) || 0) + 1);

  renderTotalsAndButtons();
  renderMoneyCounters();
}

function undoLastMoneyTap() {
  const last = moneyTapHistory.pop();
  if (!last) return;

  givenCents = Math.max(0, givenCents - last);

  const c = (moneyCounters.get(last) || 0) - 1;
  if (c <= 0) moneyCounters.delete(last);
  else moneyCounters.set(last, c);

  renderTotalsAndButtons();
  renderMoneyCounters();
}

function resetGiven() {
  givenCents = 0;
  moneyTapHistory = [];
  moneyCounters.clear();
  renderTotalsAndButtons();
  renderMoneyCounters();
}

function setExact() {
  givenCents = cartTotalCents();
  moneyTapHistory = [];
  moneyCounters.clear();
  renderTotalsAndButtons();
  renderMoneyCounters();
}

// =====================
// DRUCKEN (REAL PRINTER)
// =====================

// -> schickt Text an bridge.py (/print). Bridge macht CRLF + Papier-Vorschub.
async function printToRealPrinter(receiptText) {
  try {
    const res = await fetch("/print", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: receiptText })
    });

    if (!res.ok) return false;
    const data = await res.json().catch(function () { return null; });
    return !!(data && data.ok);
  } catch (e) {
    return false;
  }
}

// Bon-Text fuer Drucker bauen (bewusst ASCII: "EUR" statt "€")
function buildReceiptText() {
  const total = cartTotalCents();
  const d = new Date();
  const dateStr = d.toLocaleDateString("de-AT");
  const timeStr = d.toLocaleTimeString("de-AT", { hour: "2-digit", minute: "2-digit" });

  const lines = [];
  lines.push("KINDERLADEN");
  lines.push(dateStr + " " + timeStr);
  lines.push("--------------------------------");

  cart.forEach(function (it) {
    const sumCents = it.unitCents * it.qty;
    const sum = (sumCents / 100).toFixed(2);
    // kurz & stabil (Bondrucker)
    lines.push(it.name + " x" + it.qty + "  " + sum + " EUR");
  });

  lines.push("--------------------------------");
  lines.push("SUMME:   " + (total / 100).toFixed(2) + " EUR");
  lines.push("GEGEBEN: " + (givenCents / 100).toFixed(2) + " EUR");
  lines.push("RUECKG.: " + ((givenCents - total) / 100).toFixed(2) + " EUR");
  lines.push("--------------------------------");
  lines.push("Danke fuers Einkaufen! :)");

  // ein paar Leerzeilen (falls Autocut/Abreisskante)
  lines.push("");
  lines.push("");
  lines.push("");

  // Bridge macht CRLF + extra Vorschub, hier bleiben wir bei \n
  return lines.join("\n");
}

// BON DRUCKEN: druckt nur - startet NICHT neu
async function manualPrint() {
  const total = cartTotalCents();
  if (total <= 0) {
    setMsg("Warenkorb ist leer", false);
    soundError();
    return;
  }

  setMsg("Drucke Bon...", true);
  const ok = await printToRealPrinter(buildReceiptText());

  if (!ok) {
    setMsg("Drucker nicht erreichbar - Kabel/Port pruefen", false);
    soundError();
    return;
  }

  soundPrintOk();
  setMsg("Bon gedruckt", true);
}

// BEZAHLT: pruefen -> drucken -> NEUER BON
async function payAndPrint() {
  const total = cartTotalCents();

  if (total <= 0) {
    setMsg("Warenkorb ist leer", false);
    soundError();
    return;
  }

  if (givenCents < total) {
    setMsg("Noch zu wenig Geld :)", false);
    soundError();
    return;
  }

  setMsg("Bezahlt - drucke Bon...", true);

  const ok = await printToRealPrinter(buildReceiptText());

  if (!ok) {
    setMsg("Drucker nicht erreichbar - bitte Kabel/Port pruefen", false);
    soundError();
    return;
  }

  soundPrintOk();
  setMsg("Bon gedruckt - neuer Bon gestartet", true);

  // wirklich neu starten
  newReceipt();
  if (scanInput) scanInput.focus();
}

// --- Rendering ---
function renderCart() {
  if (!cartBody) return;
  cartBody.innerHTML = "";

  cart.forEach(function (it, idx) {
    const tr = document.createElement("tr");

    const tdName = document.createElement("td");
    tdName.textContent = it.name;

    const tdUnit = document.createElement("td");
    tdUnit.className = "right";
    tdUnit.textContent = eur(it.unitCents);

    const tdQty = document.createElement("td");
    tdQty.className = "right";
    tdQty.textContent = String(it.qty);

    const tdSum = document.createElement("td");
    tdSum.className = "right";
    tdSum.textContent = eur(it.unitCents * it.qty);

    const tdBtn = document.createElement("td");
    tdBtn.className = "right";
    const btn = document.createElement("button");
    btn.className = "iconBtn";
    btn.textContent = "-1";
    btn.onclick = function () { removeOneIndex(idx); };
    tdBtn.appendChild(btn);

    tr.appendChild(tdName);
    tr.appendChild(tdUnit);
    tr.appendChild(tdQty);
    tr.appendChild(tdSum);
    tr.appendChild(tdBtn);

    cartBody.appendChild(tr);
  });

  const pos = cart.reduce(function (n, it) { return n + it.qty; }, 0);
  if (posCountEl) posCountEl.textContent = String(pos);
}

function renderTotalsAndButtons() {
  const total = cartTotalCents();

  if (sumTotalEl) sumTotalEl.textContent = eur(total);
  if (sumBoxValue) sumBoxValue.textContent = eur(total);
  if (givenBoxValue) givenBoxValue.textContent = eur(givenCents);
  if (changeBoxValue) changeBoxValue.textContent = eur(Math.max(0, givenCents - total));

  if (total > 0 && givenCents < total) setMsg("Noch zu wenig Geld :)", false);
  else if (total > 0 && givenCents === total) setMsg("Perfekt passend ✅", true);
  else if (total > 0 && givenCents > total) setMsg("Rueckgeld bitte geben :)", true);
  else setMsg("", true);
}

function makeMoneyBtn(denomCents) {
  const btn = document.createElement("button");
  btn.className = "moneyBtn";
  btn.dataset.denom = String(denomCents);

  const val = document.createElement("div");
  val.className = "val";
  // Anzeige ohne Leerzeichen vor €
  val.textContent = eur(denomCents).replace(" €", "€");

  const count = document.createElement("div");
  count.className = "count";
  const c = moneyCounters.get(denomCents) || 0;
  count.textContent = c > 0 ? ("x" + c) : " ";

  btn.appendChild(val);
  btn.appendChild(count);

  btn.onclick = function () { tapMoney(denomCents); };
  return btn;
}

function renderMoneyButtons() {
  if (!coinsGrid || !notesGrid) return;

  coinsGrid.innerHTML = "";
  notesGrid.innerHTML = "";

  let coins = COINS_ALL;
  if (settings.centMode === "coarse") coins = COINS_COARSE;
  if (settings.centMode === "none") coins = [100, 200];

  const notes = NOTES_BASE.slice();
  if (settings.bigNotes === "on") {
    NOTES_BIG.forEach(function (c) { notes.push(c); });
  }

  if (bigNotesHint) {
    bigNotesHint.textContent = (settings.bigNotes === "on")
      ? "Grosse Scheine aktiv ✅"
      : "Grosse Scheine aus (100/200/500 versteckt)";
  }

  coins.forEach(function (c) { coinsGrid.appendChild(makeMoneyBtn(c)); });
  notes.forEach(function (c) { notesGrid.appendChild(makeMoneyBtn(c)); });
}

function renderMoneyCounters() {
  document.querySelectorAll(".moneyBtn").forEach(function (b) {
    const denom = clampInt(b.dataset.denom);
    const c = moneyCounters.get(denom) || 0;
    const countEl = b.querySelector(".count");
    if (countEl) countEl.textContent = c > 0 ? ("x" + c) : " ";
  });
}

function applyUiMode() {
  document.body.classList.toggle("kid", settings.uiMode === "kid");
}

// --- Product list render ---
function renderProductsList(filter) {
  if (!prodListBody) return;
  const f = String(filter || "").trim().toLowerCase();

  const entries = Object.entries(PRODUCTS)
    .map(function (kv) { return { code: kv[0], name: kv[1].name, price: kv[1].price }; })
    .filter(function (x) {
      if (!f) return true;
      return x.code.includes(f) || x.name.toLowerCase().includes(f);
    })
    .sort(function (a, b) { return a.name.localeCompare(b.name, "de"); });

  prodListBody.innerHTML = "";

  entries.forEach(function (it) {
    const tr = document.createElement("tr");
    tr.style.cursor = "pointer";
    tr.title = "Klicken zum Laden";

    const tdE = document.createElement("td");
    tdE.textContent = it.code;

    const tdN = document.createElement("td");
    tdN.textContent = it.name;

    const tdP = document.createElement("td");
    tdP.className = "right";
    tdP.textContent = eur(it.price);

    tr.appendChild(tdE);
    tr.appendChild(tdN);
    tr.appendChild(tdP);

    tr.onclick = function () {
      if (prodEanInput) prodEanInput.value = it.code;
      if (prodNameInput) prodNameInput.value = it.name;
      if (prodPriceInput) {
        if (settings.decimals === "off") prodPriceInput.value = String(Math.round(it.price / 100));
        else prodPriceInput.value = (it.price / 100).toFixed(2).replace(".", ",");
      }
      setProdHint("Artikel geladen. Du kannst ihn aendern und speichern.", true);
    };

    prodListBody.appendChild(tr);
  });
}

function render() {
  applyUiMode();
  renderCart();
  renderTotalsAndButtons();
  renderMoneyButtons();
  renderMoneyCounters();
  if (prodSearchInput) renderProductsList(prodSearchInput.value || "");
  setTimeout(function () { if (scanInput) scanInput.focus(); }, 60);
}

// --- Admin modal logic ---
function openAdmin() {
  if (!adminBackdrop) return;
  adminBackdrop.classList.remove("hidden");
  if (adminLocked) adminLocked.classList.remove("hidden");
  if (adminUnlocked) adminUnlocked.classList.add("hidden");
  if (pinInput) {
    pinInput.value = "";
    pinInput.focus();
  }
}

function closeAdminModal() {
  if (!adminBackdrop) return;
  adminBackdrop.classList.add("hidden");
}

function loginAdmin() {
  if (!pinInput) return;
  if (pinInput.value === ADMIN_PIN) {
    if (adminLocked) adminLocked.classList.add("hidden");
    if (adminUnlocked) adminUnlocked.classList.remove("hidden");

    if (uiModeSelect) uiModeSelect.value = settings.uiMode;
    if (centModeSelect) centModeSelect.value = settings.centMode;
    if (bigNotesSelect) bigNotesSelect.value = settings.bigNotes;
    if (confirmBigNotesSelect) confirmBigNotesSelect.value = settings.confirmBigNotes;
    if (soundSelect) soundSelect.value = settings.sound;
    if (decimalsSelect) decimalsSelect.value = settings.decimals;

    renderProductsList("");
    setProdHint("Bereit. Code scannen/eintippen, Name + Preis eingeben, speichern.", true);
    setCsvHint("CSV-Format: ean;name;preis", true);
  } else {
    alert("Falscher PIN");
    pinInput.focus();
  }
}

function logoutAdmin() {
  if (adminLocked) adminLocked.classList.remove("hidden");
  if (adminUnlocked) adminUnlocked.classList.add("hidden");
  if (pinInput) pinInput.value = "";
}

function saveAdminSettings() {
  if (uiModeSelect) settings.uiMode = uiModeSelect.value;
  if (centModeSelect) settings.centMode = centModeSelect.value;
  if (bigNotesSelect) settings.bigNotes = bigNotesSelect.value;
  if (confirmBigNotesSelect) settings.confirmBigNotes = confirmBigNotesSelect.value;
  if (soundSelect) settings.sound = soundSelect.value;
  if (decimalsSelect) settings.decimals = decimalsSelect.value;

  saveSettings(settings);
  render();
  alert("Gespeichert ✅");
}

// --- Product admin actions ---
function adminCalcCheckDigit() {
  const digits = onlyDigits(prodEanInput ? prodEanInput.value : "");

  if (digits.length === 13) {
    if (isValidEan13(digits)) setProdHint("EAN-13 ist gueltig ✅", true);
    else { setProdHint("EAN-13 Pruefziffer ist ungueltig ❌", false); soundError(); }
    return;
  }
  if (digits.length === 8) {
    if (isValidEan8(digits)) setProdHint("EAN-8 ist gueltig ✅", true);
    else { setProdHint("EAN-8 Pruefziffer ist ungueltig ❌", false); soundError(); }
    return;
  }

  if (digits.length === 12) {
    const full = normalizeCode(digits);
    if (prodEanInput) prodEanInput.value = full || digits;
    setProdHint("Pruefziffer berechnet (EAN-13): " + (prodEanInput ? prodEanInput.value : ""), true);
    return;
  }

  if (digits.length === 7) {
    const full2 = normalizeCode(digits);
    if (prodEanInput) prodEanInput.value = full2 || digits;
    setProdHint("Pruefziffer berechnet (EAN-8): " + (prodEanInput ? prodEanInput.value : ""), true);
    return;
  }

  setProdHint("Bitte 7/8 oder 12/13 Stellen eingeben", false);
  soundError();
}

function adminSaveProduct() {
  const code = normalizeCode(prodEanInput ? prodEanInput.value : "");
  if (!code) { setProdHint("Code muss 7/8 oder 12/13-stellig sein", false); soundError(); return; }
  if (!isValidCode(code)) { setProdHint("Pruefziffer ungueltig (EAN-8/EAN-13)", false); soundError(); return; }

  const name = String(prodNameInput ? prodNameInput.value : "").trim();
  if (!name) { setProdHint("Artikelname fehlt", false); soundError(); return; }

  const priceCents = parseEuroToCents(prodPriceInput ? prodPriceInput.value : "");
  if (priceCents === null) { setProdHint("Preis ungueltig", false); soundError(); return; }

  PRODUCTS_OVERRIDES[code] = { name: name, price: priceCents };
  saveOverrides(PRODUCTS_OVERRIDES);
  mergeProducts();

  if (prodEanInput) prodEanInput.value = code;
  setProdHint("Gespeichert ✅ (" + code + ")", true);
  if (prodSearchInput) renderProductsList(prodSearchInput.value || "");
  render();
}

function adminDeleteProduct() {
  const code = normalizeCode(prodEanInput ? prodEanInput.value : "");
  if (!code || !isValidCode(code)) { setProdHint("Gueltigen Code zum Loeschen eingeben", false); soundError(); return; }

  if (!PRODUCTS_OVERRIDES[code]) {
    setProdHint("Dieser Artikel kommt aus products.json - loesche ihn dort oder ueberschreibe ihn.", false);
    soundError();
    return;
  }

  const ok = confirm("Artikel " + code + " wirklich loeschen?");
  if (!ok) return;

  delete PRODUCTS_OVERRIDES[code];
  saveOverrides(PRODUCTS_OVERRIDES);
  mergeProducts();

  setProdHint("Geloescht ✅", true);
  if (prodNameInput) prodNameInput.value = "";
  if (prodPriceInput) prodPriceInput.value = "";
  if (prodSearchInput) renderProductsList(prodSearchInput.value || "");
  render();
}

// --- CSV Export/Import ---
function exportProductsToCsv() {
  const rows = [["ean", "name", "preis"]];
  Object.entries(PRODUCTS).forEach(function (kv) {
    const code = kv[0];
    const p = kv[1];
    const price = (p.price / 100).toFixed(2).replace(".", ",");
    rows.push([code, p.name, price]);
  });

  const csv = rows.map(function (r) { return r.join(";"); }).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });

  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "produkte.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  setCsvHint("Export erfolgreich ✅", true);
}

function importProductsFromCsv(file) {
  const reader = new FileReader();
  reader.onload = function () {
    const text = String(reader.result || "");
    const lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); });

    let added = 0;
    let skipped = 0;

    lines.forEach(function (line) {
      const cols = line.split(";").map(function (c) { return c.trim(); });
      if (!cols.length) return;
      if (String(cols[0] || "").toLowerCase() === "ean") return;

      const code = normalizeCode(cols[0]);
      const name = cols[1];
      const priceCents = parseEuroToCents(cols[2]);

      if (!code || !isValidCode(code) || !name || priceCents === null) {
        skipped += 1;
        return;
      }

      PRODUCTS_OVERRIDES[code] = { name: name, price: priceCents };
      added += 1;
    });

    saveOverrides(PRODUCTS_OVERRIDES);
    mergeProducts();
    if (prodSearchInput) renderProductsList(prodSearchInput.value || "");
    setCsvHint("Import fertig ✅ " + added + " hinzugefuegt, " + skipped + " uebersprungen", true);
    render();
  };

  reader.readAsText(file, "UTF-8");
}

// --- Events ---
document.addEventListener("pointerdown", unlockAudioOnce, { once: true });
document.addEventListener("keydown", unlockAudioOnce, { once: true });

if (adminBtn) adminBtn.onclick = openAdmin;
if (closeAdmin) closeAdmin.onclick = closeAdminModal;
if (adminBackdrop) {
  adminBackdrop.addEventListener("click", function (e) {
    if (e.target === adminBackdrop) closeAdminModal();
  });
}

if (pinLoginBtn) pinLoginBtn.onclick = loginAdmin;
if (pinInput) {
  pinInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") loginAdmin();
  });
}

if (logoutAdminBtn) logoutAdminBtn.onclick = logoutAdmin;
if (saveSettingsBtn) saveSettingsBtn.onclick = saveAdminSettings;

if (clearCartBtn) clearCartBtn.onclick = clearCart;
if (stornoLastBtn) stornoLastBtn.onclick = stornoLast;
if (newReceiptBtn) newReceiptBtn.onclick = newReceipt;

if (btnExact) btnExact.onclick = setExact;
if (btnUndo) btnUndo.onclick = undoLastMoneyTap;
if (btnResetGiven) btnResetGiven.onclick = resetGiven;

if (printBtn) printBtn.onclick = manualPrint;
if (btnPaid) btnPaid.onclick = payAndPrint;

if (addByEanBtn) {
  addByEanBtn.onclick = function () {
    addItemByCode(scanInput ? scanInput.value : "");
    if (scanInput) scanInput.value = "";
  };
}

if (scanInput) {
  scanInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      addItemByCode(scanInput.value);
      scanInput.value = "";
    }
  });
}

if (prodCalcCheckBtn) prodCalcCheckBtn.onclick = adminCalcCheckDigit;
if (prodSaveBtn) prodSaveBtn.onclick = adminSaveProduct;
if (prodDeleteBtn) prodDeleteBtn.onclick = adminDeleteProduct;

if (prodSearchInput) {
  prodSearchInput.addEventListener("input", function () {
    renderProductsList(prodSearchInput.value);
  });
}

if (exportCsvBtn) exportCsvBtn.onclick = exportProductsToCsv;
if (importCsvInput) {
  importCsvInput.onchange = function () {
    if (importCsvInput.files && importCsvInput.files.length > 0) {
      importProductsFromCsv(importCsvInput.files[0]);
      importCsvInput.value = "";
    }
  };
}

// clock
if (clockEl) {
  setInterval(function () { clockEl.textContent = nowClock(); }, 500);
  clockEl.textContent = nowClock();
}

// --- Scanner SSE ---
(function setupScannerSSE() {
  try {
    const es = new EventSource("/events");

    es.addEventListener("hello", function () {
      setScannerState(true);
    });

    es.onmessage = function (ev) {
      setScannerState(true);

      const code = normalizeCode(ev.data);
      if (!code) return;

      if (scanInput) scanInput.value = code;
      addItemByCode(code);
      if (scanInput) scanInput.value = "";
    };

    es.onerror = function () {
      setScannerState(false);
    };
  } catch (e) {
    setScannerState(false);
  }
})();

// --- Start: Produkte laden, dann rendern ---
(async function boot() {
  await loadProductsJson();
  render();
})();
