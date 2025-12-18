// =====================
// Kinderkassa – Web App
// =====================

// --- Admin PIN (hier ändern) ---
const ADMIN_PIN = "1234";

// --- Default Produkte (Fallback, falls Server/JSON nicht erreichbar) ---
const DEFAULT_PRODUCTS = {
  "2000000000017": { name: "Apfel", price: 50 },
  "2000000000024": { name: "Banane", price: 60 },
  "2000000000031": { name: "Orange", price: 70 },
  "2000000000048": { name: "Milch 1 L", price: 120 },
  "2000000000055": { name: "Kakao", price: 150 },
  "2000000000062": { name: "Wasser", price: 80 },
  "2000000000079": { name: "Brot", price: 110 },
  "2000000000086": { name: "Semmel", price: 40 },
  "2000000000093": { name: "Käse", price: 180 },
  "2000000000109": { name: "Wurst", price: 200 },
  "2000000000116": { name: "Schokolade", price: 100 },
  "2000000000123": { name: "Gummibärchen", price: 90 },
  "2000000000130": { name: "Eis", price: 120 },
  "2000000000147": { name: "Zahnbürste", price: 130 },
  "2000000000154": { name: "Seife", price: 90 },
  "2000000000161": { name: "Klopapier", price: 170 },
  "2000000000178": { name: "Spielzeugauto", price: 350 },
  "2000000000185": { name: "Puppe", price: 500 },
  "2000000000192": { name: "Ball", price: 250 },
  "2000000000208": { name: "Buch", price: 400 }
};

// --- Settings persisted (localStorage nur für UI-Settings, NICHT Produkte) ---
const LS_SETTINGS = "kinderkassa_settings";

// --- Settings Defaults ---
const defaultSettings = {
  uiMode: "standard",      // "standard" | "kid"
  centMode: "all",         // "all" | "coarse" | "none"
  bigNotes: "off",         // "on" | "off"
  confirmBigNotes: "on",   // "on" | "off"
  sound: "on",             // "on" | "off"
  decimals: "on"           // "on" | "off"  <-- NEU
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(LS_SETTINGS);
    if (!raw) return { ...defaultSettings };
    return { ...defaultSettings, ...JSON.parse(raw) };
  } catch {
    return { ...defaultSettings };
  }
}
function saveSettings(s) {
  localStorage.setItem(LS_SETTINGS, JSON.stringify(s));
}

// --- Products (werden vom Server geladen/gespeichert) ---
let PRODUCTS = { ...DEFAULT_PRODUCTS };

async function loadProductsFromServer() {
  try {
    const res = await fetch("/products", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    // Falls die JSON leer ist, trotzdem fallback behalten
    PRODUCTS = { ...DEFAULT_PRODUCTS, ...(data || {}) };
    console.log("[products] loaded:", Object.keys(PRODUCTS).length);
  } catch (e) {
    console.warn("[products] load failed, using defaults:", e);
    PRODUCTS = { ...DEFAULT_PRODUCTS };
  }
}

async function saveProductsToServer() {
  try {
    const res = await fetch("/products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(PRODUCTS)
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    console.log("[products] saved");
    return true;
  } catch (e) {
    console.error("[products] save failed:", e);
    return false;
  }
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
function nowClock() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
function parseEuroToCents(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  // Wenn Dezimal AUS: interpretieren wir "3" als 3,00 €
  if (settings.decimals === "off") {
    const num = Number(raw.replace(",", "."));
    if (!Number.isFinite(num) || num < 0) return null;
    return Math.round(num * 100); // ganze Euro *100
  }

  // Normal: 1,20 oder 1.20
  const norm = raw.replace(/\s/g, "").replace(",", ".");
  const num = Number(norm);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.round(num * 100);
}

// --- Anzeigeformat Euro (respektiert decimals) ---
function eur(cents) {
  const c = clampInt(cents);

  if (settings.decimals === "off") {
    const euros = Math.round(c / 100);
    return `${euros} €`;
  }

  const v = (c / 100).toFixed(2).replace(".", ",");
  return `${v} €`;
}

// --- EAN-13 helpers ---
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
function normalizeEanInputTo13(eanInput) {
  const s = onlyDigits(eanInput);

  // EAN-13
  if (s.length === 13) return s;

  // 12 -> berechne Prüfziffer
  if (s.length === 12) {
    const cd = ean13CheckDigit(s);
    return cd === null ? null : (s + String(cd));
  }

  // EAN-8 erlauben wir fürs SCANNEN (optional):
  // -> Wir lassen EAN-8 einfach als "8-stellig" durchgehen, ABER:
  //    Produkte müssen dann exakt als 8-stellig im PRODUCTS stehen.
  if (s.length === 8) return s;

  return null;
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
  } catch {}
}
function playTone(freq, ms, volume = 0.08, type = "square") {
  if (settings.sound !== "on") return;
  try {
    const ctx = ensureAudio();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;

    const t0 = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(volume, t0 + 0.01);
    gain.gain.setValueAtTime(volume, t0 + ms / 1000 - 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + ms / 1000);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(t0 + ms / 1000);
  } catch {}
}
function soundScanOk()  { playTone(1800, 70, 0.08, "square"); }
function soundError()   { playTone(220, 180, 0.10, "sawtooth"); }
function soundPrintOk() {
  playTone(1200, 60, 0.07, "sine");
  setTimeout(() => playTone(1500, 60, 0.07, "sine"), 70);
}

// --- State ---
let cart = []; // {ean, name, unitCents, qty}
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

// Optional: bezahlt Button (falls du ihn im HTML hast)
const paidBtn = document.getElementById("paidBtn") || document.getElementById("btnPaid");

const btnExact = document.getElementById("btnExact");
const btnUndo = document.getElementById("btnUndo");
const btnResetGiven = document.getElementById("btnResetGiven");

const coinsGrid = document.getElementById("coinsGrid");
const notesGrid = document.getElementById("notesGrid");
const bigNotesHint = document.getElementById("bigNotesHint");

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

// Dezimal Setting (NEU) – wenn du es im HTML noch nicht hast, ignoriert er es einfach
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
function setMsg(text, ok = true) {
  if (!msgEl) return;
  msgEl.textContent = text || "";
  msgEl.style.color = ok ? "var(--muted)" : "#ffb4b4";
}
function setProdHint(text, ok = true) {
  if (!prodHint) return;
  prodHint.textContent = text || "";
  prodHint.style.color = ok ? "var(--muted)" : "#ffb4b4";
}
function setCsvHint(text, ok = true) {
  if (!csvHint) return;
  csvHint.textContent = text || "";
  csvHint.style.color = ok ? "var(--muted)" : "#ffb4b4";
}

// --- Cart computations ---
function cartTotalCents() {
  return cart.reduce((sum, it) => sum + it.unitCents * it.qty, 0);
}

// --- Cart ops ---
function addItemByEan(eanRaw) {
  const code = normalizeEanInputTo13(eanRaw);
  if (!code) {
    setMsg("Code muss EAN-8 / 12 / 13-stellig sein", false);
    soundError();
    return;
  }

  // Wenn 13-stellig: prüfen
  if (code.length === 13 && !isValidEan13(code)) {
    setMsg("EAN-13 Prüfziffer ungültig", false);
    soundError();
    return;
  }

  const p = PRODUCTS[code];
  if (!p) {
    setMsg(`Code nicht gefunden: ${code}`, false);
    soundError();
    return;
  }

  const existing = cart.find(x => x.ean === code);
  if (existing) existing.qty += 1;
  else cart.push({ ean: code, name: p.name, unitCents: p.price, qty: 1 });

  soundScanOk();
  setMsg(`${p.name} hinzugefügt`);
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
  setMsg("Warenkorb geleert");
  render();
}

function stornoLast() {
  if (cart.length === 0) return;
  const last = cart[cart.length - 1];
  last.qty -= 1;
  if (last.qty <= 0) cart.pop();
  setMsg("Letzten Artikel entfernt");
  render();
}

function newReceipt() {
  cart = [];
  resetGiven();
  moneyTapHistory = [];
  moneyCounters.clear();
  setMsg("Neuer Bon gestartet");
  render();
}

// --- Payment ops ---
function tapMoney(denomCents) {
  denomCents = clampInt(denomCents);
  if (denomCents <= 0) return;

  if ((denomCents >= 10000) && settings.confirmBigNotes === "on") {
    const ok = confirm(`Wirklich ${eur(denomCents)} gegeben?`);
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

// --- Printing (Browser print) ---
function printReceipt() {
  const total = cartTotalCents();
  if (total <= 0) {
    setMsg("Warenkorb ist leer", false);
    soundError();
    return;
  }
  if (givenCents < total) {
    setMsg("Noch zu wenig Geld 😊", false);
    soundError();
    return;
  }

  const d = new Date();
  const dateStr = d.toLocaleDateString("de-AT");
  const timeStr = d.toLocaleTimeString("de-AT", { hour: "2-digit", minute: "2-digit" });

  const lines = cart.map(it => ({
    name: it.name,
    qty: it.qty,
    sum: eur(it.unitCents * it.qty),
  }));

  const win = window.open("", "printWin");
  if (!win) {
    setMsg("Popup blockiert – bitte erlauben", false);
    soundError();
    return;
  }

  soundPrintOk();

  win.document.write(`
<!doctype html><html><head><meta charset="utf-8">
<title>Bon</title>
<style>
  body{font-family:monospace;margin:0;padding:12px;}
  .c{width:320px;max-width:100%;}
  .hr{border-top:1px dashed #000;margin:8px 0;}
  .row{display:flex;justify-content:space-between;gap:10px;}
  .small{font-size:12px;}
  h3{margin:0 0 6px 0;text-align:center;}
</style>
</head><body>
<div class="c">
  <h3>KINDERLADEN</h3>
  <div class="small">Datum: ${dateStr} &nbsp; ${timeStr}</div>
  <div class="hr"></div>
  ${lines.map(l => `
    <div class="row"><div>${l.name} x${l.qty}</div><div>${l.sum}</div></div>
  `).join("")}
  <div class="hr"></div>
  <div class="row"><div><b>Summe</b></div><div><b>${eur(total)}</b></div></div>
  <div class="row"><div>Gegeben</div><div>${eur(givenCents)}</div></div>
  <div class="row"><div>Rückgeld</div><div>${eur(givenCents - total)}</div></div>
  <div class="hr"></div>
  <div style="text-align:center">Danke fürs Einkaufen! :)</div>
</div>
<script>window.print(); window.close();</script>
</body></html>
  `);
  win.document.close();

  setMsg("Bon gedruckt 🧾");
}

// --- Rendering ---
function renderCart() {
  if (!cartBody) return;
  cartBody.innerHTML = "";
  cart.forEach((it, idx) => {
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
    btn.textContent = "−1";
    btn.onclick = () => removeOneIndex(idx);
    tdBtn.appendChild(btn);

    tr.appendChild(tdName);
    tr.appendChild(tdUnit);
    tr.appendChild(tdQty);
    tr.appendChild(tdSum);
    tr.appendChild(tdBtn);

    cartBody.appendChild(tr);
  });

  const pos = cart.reduce((n, it) => n + it.qty, 0);
  if (posCountEl) posCountEl.textContent = String(pos);
}

function renderTotalsAndButtons() {
  const total = cartTotalCents();
  if (sumTotalEl) sumTotalEl.textContent = eur(total);
  if (sumBoxValue) sumBoxValue.textContent = eur(total);
  if (givenBoxValue) givenBoxValue.textContent = eur(givenCents);
  if (changeBoxValue) changeBoxValue.textContent = eur(Math.max(0, givenCents - total));

  if (total > 0 && givenCents < total) setMsg("Noch zu wenig Geld 😊", false);
  else if (total > 0 && givenCents === total) setMsg("Perfekt passend ✅", true);
  else if (total > 0 && givenCents > total) setMsg("Rückgeld bitte geben 🙂", true);
  else setMsg("");
}

function makeMoneyBtn(denomCents) {
  const btn = document.createElement("button");
  btn.className = "moneyBtn";
  btn.dataset.denom = String(denomCents);

  const val = document.createElement("div");
  val.className = "val";
  val.textContent = eur(denomCents).replace(" €", "€");

  const count = document.createElement("div");
  count.className = "count";
  const c = moneyCounters.get(denomCents) || 0;
  count.textContent = c > 0 ? `x${c}` : " ";

  btn.appendChild(val);
  btn.appendChild(count);

  btn.onclick = () => tapMoney(denomCents);
  return btn;
}

function renderMoneyButtons() {
  if (!coinsGrid || !notesGrid) return;

  coinsGrid.innerHTML = "";
  notesGrid.innerHTML = "";

  // Wenn decimals OFF: keine Cent-Münzen
  let coins;
  if (settings.decimals === "off") {
    coins = [100, 200]; // nur 1€ / 2€ (einfach & kindgerecht)
  } else {
    coins = COINS_ALL;
    if (settings.centMode === "coarse") coins = COINS_COARSE;
    if (settings.centMode === "none") coins = [100, 200];
  }

  const notes = [...NOTES_BASE, ...(settings.bigNotes === "on" ? NOTES_BIG : [])];

  if (bigNotesHint) {
    bigNotesHint.textContent =
      settings.bigNotes === "on"
        ? "Große Scheine aktiv ✅"
        : "Große Scheine aus (100/200/500 versteckt)";
  }

  coins.forEach(c => coinsGrid.appendChild(makeMoneyBtn(c)));
  notes.forEach(c => notesGrid.appendChild(makeMoneyBtn(c)));
}

function renderMoneyCounters() {
  document.querySelectorAll(".moneyBtn").forEach(b => {
    const denom = clampInt(b.dataset.denom);
    const c = moneyCounters.get(denom) || 0;
    const countEl = b.querySelector(".count");
    if (countEl) countEl.textContent = c > 0 ? `x${c}` : " ";
  });
}

function applyUiMode() {
  document.body.classList.toggle("kid", settings.uiMode === "kid");
}

// --- Product list render ---
function renderProductsList(filter = "") {
  if (!prodListBody) return;

  const f = String(filter || "").trim().toLowerCase();

  const entries = Object.entries(PRODUCTS)
    .map(([ean, obj]) => ({ ean, name: obj.name, price: obj.price }))
    .filter(x => !f || x.ean.includes(f) || x.name.toLowerCase().includes(f))
    .sort((a, b) => a.name.localeCompare(b.name, "de"));

  prodListBody.innerHTML = "";
  for (const it of entries) {
    const tr = document.createElement("tr");
    tr.style.cursor = "pointer";
    tr.title = "Klicken zum Laden";

    const tdE = document.createElement("td");
    tdE.textContent = it.ean;

    const tdN = document.createElement("td");
    tdN.textContent = it.name;

    const tdP = document.createElement("td");
    tdP.className = "right";
    tdP.textContent = eur(it.price);

    tr.appendChild(tdE);
    tr.appendChild(tdN);
    tr.appendChild(tdP);

    tr.onclick = () => {
      if (prodEanInput) prodEanInput.value = it.ean;
      if (prodNameInput) prodNameInput.value = it.name;

      // Anzeige im Feld:
      if (prodPriceInput) {
        if (settings.decimals === "off") {
          prodPriceInput.value = String(Math.round(it.price / 100));
        } else {
          prodPriceInput.value = (it.price / 100).toFixed(2).replace(".", ",");
        }
      }
      setProdHint("Artikel geladen. Du kannst ihn ändern und speichern.");
    };

    prodListBody.appendChild(tr);
  }
}

function render() {
  applyUiMode();
  renderCart();
  renderTotalsAndButtons();
  renderMoneyButtons();
  renderMoneyCounters();
  renderProductsList(prodSearchInput?.value || "");

  if (settings.uiMode === "standard") {
    setTimeout(() => scanInput?.focus(), 60);
  }
}

// --- Admin modal logic ---
function openAdmin() {
  if (!adminBackdrop) return;
  adminBackdrop.classList.remove("hidden");
  adminLocked?.classList.remove("hidden");
  adminUnlocked?.classList.add("hidden");
  if (pinInput) pinInput.value = "";
  pinInput?.focus();
}

function closeAdminModal() {
  adminBackdrop?.classList.add("hidden");
}

function loginAdmin() {
  if (!pinInput) return;
  if (pinInput.value === ADMIN_PIN) {
    adminLocked?.classList.add("hidden");
    adminUnlocked?.classList.remove("hidden");

    if (uiModeSelect) uiModeSelect.value = settings.uiMode;
    if (centModeSelect) centModeSelect.value = settings.centMode;
    if (bigNotesSelect) bigNotesSelect.value = settings.bigNotes;
    if (confirmBigNotesSelect) confirmBigNotesSelect.value = settings.confirmBigNotes;
    if (soundSelect) soundSelect.value = settings.sound;
    if (decimalsSelect) decimalsSelect.value = settings.decimals;

    renderProductsList("");
    setProdHint("Bereit. Code scannen/eintippen, Name + Preis eingeben, speichern.");
    setCsvHint("CSV-Format: ean;name;preis");
  } else {
    alert("Falscher PIN");
    pinInput.focus();
  }
}

function logoutAdmin() {
  adminLocked?.classList.remove("hidden");
  adminUnlocked?.classList.add("hidden");
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
  if (!prodEanInput) return;
  const digits = onlyDigits(prodEanInput.value);

  // EAN-8: erlauben wir ohne Prüfziffer-berechnen
  if (digits.length === 8) {
    setProdHint("EAN-8 erkannt ✅ (wird so gespeichert)");
    return;
  }

  if (digits.length === 13) {
    if (isValidEan13(digits)) setProdHint("EAN-13 ist gültig ✅");
    else { setProdHint("EAN-13 Prüfziffer ist ungültig ❌", false); soundError(); }
    return;
  }

  if (digits.length !== 12) {
    setProdHint("Bitte 8 / 12 / 13 Stellen eingeben", false);
    soundError();
    return;
  }

  const full = normalizeEanInputTo13(digits);
  prodEanInput.value = full || digits;
  setProdHint(`Prüfziffer berechnet: ${prodEanInput.value}`);
}

async function adminSaveProduct() {
  const code = normalizeEanInputTo13(prodEanInput?.value || "");
  if (!code) { setProdHint("Code muss 8 / 12 / 13-stellig sein", false); soundError(); return; }

  if (code.length === 13 && !isValidEan13(code)) {
    setProdHint("EAN-13 Prüfziffer ist ungültig", false);
    soundError();
    return;
  }

  const name = String(prodNameInput?.value || "").trim();
  if (!name) { setProdHint("Artikelname fehlt", false); soundError(); return; }

  const priceCents = parseEuroToCents(prodPriceInput?.value || "");
  if (priceCents === null) { setProdHint("Preis ungültig (z. B. 1,20)", false); soundError(); return; }

  PRODUCTS[code] = { name, price: priceCents };

  const ok = await saveProductsToServer();
  if (!ok) {
    setProdHint("Speichern fehlgeschlagen (Server nicht erreichbar)", false);
    soundError();
    return;
  }

  if (prodEanInput) prodEanInput.value = code;
  setProdHint(`Gespeichert ✅ (${code})`);
  renderProductsList(prodSearchInput?.value || "");
  render(); // damit Kassa sofort aktuelle Preise hat
}

async function adminDeleteProduct() {
  const code = normalizeEanInputTo13(prodEanInput?.value || "");
  if (!code) { setProdHint("Gültigen Code zum Löschen eingeben", false); soundError(); return; }

  if (code.length === 13 && !isValidEan13(code)) {
    setProdHint("EAN-13 ungültig", false);
    soundError();
    return;
  }

  if (!PRODUCTS[code]) { setProdHint("Code nicht vorhanden", false); soundError(); return; }

  const ok = confirm(`Artikel ${code} wirklich löschen?`);
  if (!ok) return;

  delete PRODUCTS[code];

  const saved = await saveProductsToServer();
  if (!saved) {
    setProdHint("Löschen fehlgeschlagen (Server nicht erreichbar)", false);
    soundError();
    return;
  }

  setProdHint("Gelöscht ✅");
  if (prodNameInput) prodNameInput.value = "";
  if (prodPriceInput) prodPriceInput.value = "";
  renderProductsList(prodSearchInput?.value || "");
  render();
}

// --- CSV Export/Import (arbeitet auf PRODUCTS + speichert via Server) ---
function exportProductsToCsv() {
  const rows = [["ean", "name", "preis"]];
  Object.entries(PRODUCTS).forEach(([ean, p]) => {
    const price = settings.decimals === "off"
      ? String(Math.round(p.price / 100))
      : (p.price / 100).toFixed(2).replace(".", ",");
    rows.push([ean, p.name, price]);
  });

  const csv = rows.map(r => r.join(";")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });

  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "produkte.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  setCsvHint("Export erfolgreich ✅");
}

async function importProductsFromCsv(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    const text = String(reader.result || "");
    const lines = text.split(/\r?\n/).filter(l => l.trim());

    let added = 0;
    let skipped = 0;

    for (const line of lines) {
      const cols = line.split(";").map(c => c.trim());
      if (!cols.length) continue;
      if (cols[0].toLowerCase() === "ean") continue;

      const code = normalizeEanInputTo13(cols[0]);
      const name = cols[1];
      const priceCents = parseEuroToCents(cols[2]);

      if (!code || !name || priceCents === null) {
        skipped++;
        continue;
      }
      if (code.length === 13 && !isValidEan13(code)) {
        skipped++;
        continue;
      }

      PRODUCTS[code] = { name, price: priceCents };
      added++;
    }

    const ok = await saveProductsToServer();
    if (!ok) {
      setCsvHint("Import fehlgeschlagen (Server nicht erreichbar)", false);
      soundError();
      return;
    }

    renderProductsList(prodSearchInput?.value || "");
    render();
    setCsvHint(`Import fertig ✅ ${added} hinzugefügt, ${skipped} übersprungen`);
  };

  reader.readAsText(file, "UTF-8");
}

// --- Optional: Bezahlt (kindgerecht) ---
function markPaid() {
  const total = cartTotalCents();
  if (total <= 0) {
    setMsg("Warenkorb ist leer", false);
    soundError();
    return;
  }
  if (givenCents < total) {
    setMsg("Noch zu wenig Geld 😊", false);
    soundError();
    return;
  }
  setMsg("BEZAHLT ✅", true);
}

// --- SSE Scanner Bridge ---
function setupScannerSSE() {
  try {
    const es = new EventSource("/events");

    es.addEventListener("hello", () => {
      console.log("Scanner-Bridge ready");
    });

    es.onmessage = (ev) => {
      const code = String(ev.data || "").replace(/\D/g, "");
      if (!code) return;

      if (scanInput) scanInput.value = code;

      // Auto hinzufügen:
      addItemByEan(code);

      // Input sauber machen:
      if (scanInput) scanInput.value = "";
    };

    es.onerror = () => {
      // reconnect passiert automatisch
    };
  } catch (e) {
    console.error("SSE not supported?", e);
  }
}

// --- Events / Hooks ---
document.addEventListener("pointerdown", unlockAudioOnce, { once: true });
document.addEventListener("keydown", unlockAudioOnce, { once: true });

adminBtn && (adminBtn.onclick = openAdmin);
closeAdmin && (closeAdmin.onclick = closeAdminModal);

adminBackdrop && adminBackdrop.addEventListener("click", (e) => {
  if (e.target === adminBackdrop) closeAdminModal();
});

pinLoginBtn && (pinLoginBtn.onclick = loginAdmin);
pinInput && pinInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") loginAdmin();
});

logoutAdminBtn && (logoutAdminBtn.onclick = logoutAdmin);
saveSettingsBtn && (saveSettingsBtn.onclick = saveAdminSettings);

clearCartBtn && (clearCartBtn.onclick = clearCart);
stornoLastBtn && (stornoLastBtn.onclick = stornoLast);
newReceiptBtn && (newReceiptBtn.onclick = newReceipt);

btnExact && (btnExact.onclick = setExact);
btnUndo && (btnUndo.onclick = undoLastMoneyTap);
btnResetGiven && (btnResetGiven.onclick = resetGiven);

printBtn && (printBtn.onclick = printReceipt);
paidBtn && (paidBtn.onclick = markPaid);

addByEanBtn && (addByEanBtn.onclick = () => addItemByEan(scanInput?.value || ""));
scanInput && scanInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    addItemByEan(scanInput.value);
    scanInput.value = "";
  }
});

prodCalcCheckBtn && (prodCalcCheckBtn.onclick = adminCalcCheckDigit);
prodSaveBtn && (prodSaveBtn.onclick = adminSaveProduct);
prodDeleteBtn && (prodDeleteBtn.onclick = adminDeleteProduct);

prodSearchInput && prodSearchInput.addEventListener("input", () => {
  renderProductsList(prodSearchInput.value);
});

exportCsvBtn && (exportCsvBtn.onclick = exportProductsToCsv);
importCsvInput && (importCsvInput.onchange = () => {
  if (importCsvInput.files && importCsvInput.files.length > 0) {
    importProductsFromCsv(importCsvInput.files[0]);
    importCsvInput.value = "";
  }
});

// clock
if (clockEl) {
  setInterval(() => (clockEl.textContent = nowClock()), 500);
  clockEl.textContent = nowClock();
}

// --- INIT ---
(async function init() {
  await loadProductsFromServer();
  render();
  setupScannerSSE();
})();
