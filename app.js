// =====================
// Kinderkassa – Web App
// =====================
const ADMIN_PIN = "1234";

const LS_SETTINGS = "kinderkassa_settings";

// Default Settings
const defaultSettings = {
  uiMode: "standard",
  centMode: "all",
  bigNotes: "off",
  confirmBigNotes: "on",
  sound: "on",
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

// Helpers
function onlyDigits(s) { return String(s || "").replace(/\D/g, ""); }
function clampInt(n) { n = Number(n); return Number.isFinite(n) ? Math.trunc(n) : 0; }
function eur(cents) {
  const v = (cents / 100).toFixed(2).replace(".", ",");
  return `${v} €`;
}
function nowClock() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function parseEuroToCents(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const norm = raw.replace(/\s/g, "").replace(",", ".");
  const num = Number(norm);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.round(num * 100);
}

// EAN validation: akzeptiere EAN-8 ODER EAN-13 (nur Ziffern, Länge passt)
function normalizeEan(eanInput) {
  const s = onlyDigits(eanInput);
  if (s.length === 8 || s.length === 13) return s;
  return null;
}

// Sound
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
function soundScanOk() { playTone(1800, 70, 0.08, "square"); }
function soundError()  { playTone(220, 180, 0.10, "sawtooth"); }
function soundPrintOk(){ playTone(1200, 60, 0.07, "sine"); setTimeout(() => playTone(1500, 60, 0.07, "sine"), 70); }

// Denominations
const COINS_ALL = [1, 2, 5, 10, 20, 50, 100, 200];
const COINS_COARSE = [10, 20, 50, 100, 200];
const NOTES_BASE = [500, 1000, 2000, 5000];
const NOTES_BIG  = [10000, 20000, 50000];

// State
let PRODUCTS = {}; // kommt vom Server (products.json)
let cart = []; // {ean,name,unitCents,qty}
let givenCents = 0;
let moneyTapHistory = [];
let moneyCounters = new Map();

// Elements
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

// Product admin
const prodEanInput = document.getElementById("prodEanInput");
const prodNameInput = document.getElementById("prodNameInput");
const prodPriceInput = document.getElementById("prodPriceInput");
const prodSaveBtn = document.getElementById("prodSaveBtn");
const prodDeleteBtn = document.getElementById("prodDeleteBtn");
const prodHint = document.getElementById("prodHint");
const prodSearchInput = document.getElementById("prodSearchInput");
const prodListBody = document.getElementById("prodListBody");

// CSV
const exportCsvBtn = document.getElementById("exportCsvBtn");
const importCsvInput = document.getElementById("importCsvInput");
const csvHint = document.getElementById("csvHint");

// UI messages
function setMsg(text, ok = true) {
  msgEl.textContent = text || "";
  msgEl.style.color = ok ? "var(--muted)" : "#ffb4b4";
}
function setProdHint(text, ok = true) {
  prodHint.textContent = text || "";
  prodHint.style.color = ok ? "var(--muted)" : "#ffb4b4";
}
function setCsvHint(text, ok = true) {
  csvHint.textContent = text || "";
  csvHint.style.color = ok ? "var(--muted)" : "#ffb4b4";
}

// Server API: products.json via bridge.py
async function apiLoadProducts() {
  const r = await fetch("/api/products", { cache: "no-store" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const data = await r.json();
  return (data && typeof data === "object") ? data : {};
}
async function apiSaveProducts(p) {
  const r = await fetch("/api/products", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(p || {})
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error("Save failed: " + r.status + " " + t);
  }
}
async function apiPrint(payload) {
  const r = await fetch("/api/print", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {})
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error("Print failed: " + r.status + " " + t);
  }
}

// Cart computations
function cartTotalCents() {
  return cart.reduce((sum, it) => sum + it.unitCents * it.qty, 0);
}

// Cart ops
function addItemByEan(eanRaw) {
  const ean = normalizeEan(eanRaw);
  if (!ean) {
    setMsg("EAN muss 8 oder 13-stellig sein", false);
    soundError();
    return;
  }

  const p = PRODUCTS[ean];
  if (!p) {
    setMsg(`EAN nicht gefunden: ${ean}`, false);
    soundError();
    return;
  }

  const existing = cart.find(x => x.ean === ean);
  if (existing) existing.qty += 1;
  else cart.push({ ean, name: p.name, unitCents: p.price, qty: 1 });

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

// Payment
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

// Printing via Pi
async function printReceiptPi() {
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

  const items = cart.map(it => ({
    name: it.name,
    qty: it.qty,
    sumCents: it.unitCents * it.qty
  }));

  const payload = {
    title: "KINDERLADEN",
    datetime: `${dateStr} ${timeStr}`,
    items,
    totalCents: total,
    givenCents: givenCents,
    changeCents: givenCents - total
  };

  try {
    await apiPrint(payload);
    soundPrintOk();
    setMsg("Bon gedruckt 🧾");
  } catch (e) {
    setMsg("Druckfehler: " + (e.message || e), false);
    soundError();
  }
}

// Rendering
function renderCart() {
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
  posCountEl.textContent = String(pos);
}

function renderTotalsAndButtons() {
  const total = cartTotalCents();
  sumTotalEl.textContent = eur(total);
  sumBoxValue.textContent = eur(total);
  givenBoxValue.textContent = eur(givenCents);
  changeBoxValue.textContent = eur(Math.max(0, givenCents - total));

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
  coinsGrid.innerHTML = "";
  notesGrid.innerHTML = "";

  let coins = COINS_ALL;
  if (settings.centMode === "coarse") coins = COINS_COARSE;
  if (settings.centMode === "none") coins = [100, 200];

  const notes = [...NOTES_BASE, ...(settings.bigNotes === "on" ? NOTES_BIG : [])];

  bigNotesHint.textContent =
    settings.bigNotes === "on"
      ? "Große Scheine aktiv ✅"
      : "Große Scheine aus (100/200/500 versteckt)";

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

// Products list render
function renderProductsList(filter = "") {
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
      prodEanInput.value = it.ean;
      prodNameInput.value = it.name;
      prodPriceInput.value = (it.price / 100).toFixed(2).replace(".", ",");
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

// Admin modal
function openAdmin() {
  adminBackdrop.classList.remove("hidden");
  adminLocked.classList.remove("hidden");
  adminUnlocked.classList.add("hidden");
  pinInput.value = "";
  pinInput.focus();
}
function closeAdminModal() { adminBackdrop.classList.add("hidden"); }
function loginAdmin() {
  if (pinInput.value === ADMIN_PIN) {
    adminLocked.classList.add("hidden");
    adminUnlocked.classList.remove("hidden");

    uiModeSelect.value = settings.uiMode;
    centModeSelect.value = settings.centMode;
    bigNotesSelect.value = settings.bigNotes;
    confirmBigNotesSelect.value = settings.confirmBigNotes;
    soundSelect.value = settings.sound;

    setProdHint("Bereit. EAN(8/13) scannen, Name + Preis eingeben, speichern.");
    setCsvHint("CSV-Format: ean;name;preis");
    renderProductsList("");
  } else {
    alert("Falscher PIN");
    pinInput.focus();
  }
}
function logoutAdmin() {
  adminLocked.classList.remove("hidden");
  adminUnlocked.classList.add("hidden");
  pinInput.value = "";
}
function saveAdminSettings() {
  settings.uiMode = uiModeSelect.value;
  settings.centMode = centModeSelect.value;
  settings.bigNotes = bigNotesSelect.value;
  settings.confirmBigNotes = confirmBigNotesSelect.value;
  settings.sound = soundSelect.value;

  saveSettings(settings);
  render();
  alert("Gespeichert ✅");
}

// Admin products
async function adminSaveProduct() {
  const ean = normalizeEan(prodEanInput.value);
  if (!ean) { setProdHint("EAN muss 8 oder 13-stellig sein", false); soundError(); return; }

  const name = String(prodNameInput.value || "").trim();
  if (!name) { setProdHint("Artikelname fehlt", false); soundError(); return; }

  const priceCents = parseEuroToCents(prodPriceInput.value);
  if (priceCents === null) { setProdHint("Preis ungültig (z. B. 1,20)", false); soundError(); return; }

  PRODUCTS[ean] = { name, price: priceCents };

  try {
    await apiSaveProducts(PRODUCTS);
    setProdHint(`Gespeichert ✅ (${ean})`);
    renderProductsList(prodSearchInput?.value || "");
  } catch (e) {
    setProdHint("Speichern am Pi fehlgeschlagen ❌ " + (e.message || e), false);
    soundError();
  }
}

async function adminDeleteProduct() {
  const ean = normalizeEan(prodEanInput.value);
  if (!ean || !PRODUCTS[ean]) { setProdHint("Gültige EAN zum Löschen eingeben", false); soundError(); return; }

  const ok = confirm(`Artikel ${ean} wirklich löschen?`);
  if (!ok) return;

  delete PRODUCTS[ean];

  try {
    await apiSaveProducts(PRODUCTS);
    setProdHint("Gelöscht ✅");
    prodNameInput.value = "";
    prodPriceInput.value = "";
    renderProductsList(prodSearchInput?.value || "");
  } catch (e) {
    setProdHint("Löschen am Pi fehlgeschlagen ❌ " + (e.message || e), false);
    soundError();
  }
}

// CSV
function exportProductsToCsv() {
  const rows = [["ean", "name", "preis"]];
  Object.entries(PRODUCTS).forEach(([ean, p]) => {
    const price = (p.price / 100).toFixed(2).replace(".", ",");
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

function importProductsFromCsv(file) {
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

      const ean = normalizeEan(cols[0]);
      const name = cols[1];
      const priceCents = parseEuroToCents(cols[2]);

      if (!ean || !name || priceCents === null) { skipped++; continue; }
      PRODUCTS[ean] = { name, price: priceCents };
      added++;
    }

    try {
      await apiSaveProducts(PRODUCTS);
      renderProductsList(prodSearchInput?.value || "");
      setCsvHint(`Import fertig ✅ ${added} hinzugefügt, ${skipped} übersprungen`);
    } catch (e) {
      setCsvHint("Import: Speichern am Pi fehlgeschlagen ❌ " + (e.message || e), false);
      soundError();
    }
  };

  reader.readAsText(file, "UTF-8");
}

// Landscape overlay
function enforceLandscape() {
  const overlay = document.getElementById("rotateOverlay");
  if (!overlay) return;
  const isPortrait = window.matchMedia("(orientation: portrait)").matches;
  overlay.classList.toggle("hidden", !isPortrait);
}
window.addEventListener("resize", enforceLandscape);
window.addEventListener("orientationchange", enforceLandscape);

// Events
document.addEventListener("pointerdown", unlockAudioOnce, { once: true });
document.addEventListener("keydown", unlockAudioOnce, { once: true });

adminBtn.onclick = openAdmin;
closeAdmin.onclick = closeAdminModal;
adminBackdrop.addEventListener("click", (e) => { if (e.target === adminBackdrop) closeAdminModal(); });

pinLoginBtn.onclick = loginAdmin;
pinInput.addEventListener("keydown", (e) => { if (e.key === "Enter") loginAdmin(); });

logoutAdminBtn.onclick = logoutAdmin;
saveSettingsBtn.onclick = saveAdminSettings;

clearCartBtn.onclick = clearCart;
stornoLastBtn.onclick = stornoLast;
newReceiptBtn.onclick = newReceipt;

btnExact.onclick = setExact;
btnUndo.onclick = undoLastMoneyTap;
btnResetGiven.onclick = resetGiven;

printBtn.onclick = printReceiptPi;

addByEanBtn.onclick = () => { addItemByEan(scanInput.value); scanInput.value = ""; };
scanInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    addItemByEan(scanInput.value);
    scanInput.value = "";
  }
});

prodSaveBtn.onclick = adminSaveProduct;
prodDeleteBtn.onclick = adminDeleteProduct;

prodSearchInput.addEventListener("input", () => renderProductsList(prodSearchInput.value));

exportCsvBtn.onclick = exportProductsToCsv;
importCsvInput.onchange = () => {
  if (importCsvInput.files && importCsvInput.files.length > 0) {
    importProductsFromCsv(importCsvInput.files[0]);
    importCsvInput.value = "";
  }
};

// Clock
setInterval(() => (clockEl.textContent = nowClock()), 500);
clockEl.textContent = nowClock();

// SSE scanner bridge
(function setupScannerSSE() {
  try {
    const es = new EventSource("/events");
    es.addEventListener("hello", () => console.log("Scanner-Bridge ready"));
    es.onmessage = (ev) => {
      const code = normalizeEan(ev.data);
      if (!code) return;
      const input = document.getElementById("scanInput");
      if (input) input.value = code;
      addItemByEan(code);
      if (input) input.value = "";
    };
  } catch (e) {
    console.error("SSE not supported?", e);
  }
})();

// INIT: load products from Pi (products.json)
(async () => {
  try {
    PRODUCTS = await apiLoadProducts();
    setMsg(Object.keys(PRODUCTS).length ? "Produkte geladen ✅" : "Noch keine Produkte – bitte im Admin anlegen 🙂", true);
  } catch (e) {
    PRODUCTS = {};
    setMsg("Produkte konnten nicht geladen werden ❌", false);
    console.warn(e);
  }
  render();
  enforceLandscape();
})();
