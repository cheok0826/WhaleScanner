/* WhaleScanner Dashboard (no deps)
 * Adds:
 * - independent searches (rankings + positions)
 * - debounce for heavy tables
 * - fixed collapse layout (rank-collapsed class)
 * - live loading status + no overlapping polls
 * - positions table sorting
 * - manual add wallet (not from rankings)
 * - pin wallet + copy wallet
 */

const HL_INFO = "https://api.hyperliquid.xyz/info";

function qs(id){ return document.getElementById(id); }
function esc(s){ return String(s ?? "").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

function debounce(fn, ms){
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function toNum(v){
  if (v == null) return NaN;
  if (typeof v === "number") return v;
  if (typeof v === "string"){
    const x = Number(v.replace(/,/g,"").trim());
    return Number.isFinite(x) ? x : NaN;
  }
  if (typeof v === "object" && v && "value" in v) return toNum(v.value);
  return NaN;
}

function fmtCompact(n, digits=2){
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  const units = [
    { v: 1e12, s: "T" },
    { v: 1e9,  s: "B" },
    { v: 1e6,  s: "M" },
    { v: 1e3,  s: "K" },
  ];
  for (const u of units){
    if (abs >= u.v) return `${sign}${(abs/u.v).toFixed(digits)}${u.s}`;
  }
  if (abs >= 100) return `${sign}${abs.toFixed(0)}`;
  if (abs >= 1) return `${sign}${abs.toFixed(2)}`;
  return `${sign}${abs.toFixed(4)}`;
}
function fmtUSD(n){ return Number.isFinite(n) ? `$${fmtCompact(n, 2)}` : "—"; }

function pickNum(obj, keys){
  for (const k of keys){
    const v = obj?.[k];
    const n = toNum(v);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

function flatten(obj, prefix="", out={}){
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj)){
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)){
      flatten(v, key, out);
    } else if (Array.isArray(v)){
      out[`${key}.length`] = v.length;
    } else {
      out[key] = v;
    }
  }
  return out;
}

function normalizeWallet(s){
  const t = String(s || "").trim();

  // accept 0x + 40 hex
  if (/^0x[a-fA-F0-9]{40}$/.test(t)) return t.toLowerCase();

  // accept 40 hex without 0x
  if (/^[a-fA-F0-9]{40}$/.test(t)) return ("0x" + t).toLowerCase();

  return null;
}

function tryAddress(rowFlat){
  const candidates = [
    rowFlat.wallet, rowFlat.address, rowFlat.user, rowFlat.owner,
    rowFlat["wallet.address"], rowFlat["user.address"], rowFlat["account.address"],
    rowFlat["meta.wallet"], rowFlat["meta.address"],
  ].filter(Boolean);
  for (const c of candidates){
    const w = normalizeWallet(c);
    if (w) return w;
  }
  for (const v of Object.values(rowFlat)){
    if (typeof v === "string" && v.startsWith("0x")){
      const w = normalizeWallet(v);
      if (w) return w;
    }
  }
  return "";
}

function keyLabel(k){
  return k
    .replace(/^__/, "")
    .replace(/\.length$/," (len)")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .trim();
}

async function fetchJson(url){
  const bust = url.includes("?") ? "&v=" : "?v=";
  const r = await fetch(url + bust + Date.now(), { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return await r.json();
}

async function hlPost(payload){
  const maxRetries = 3;
  let lastErr = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++){
    try{
      const r = await fetch(HL_INFO, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (r.ok) return await r.json();

      const text = await r.text();
      const retryable = r.status === 429 || r.status >= 500;
      lastErr = new Error(`HL HTTP ${r.status}${text ? `: ${text}` : ""}`);
      if (!retryable || attempt === maxRetries) throw lastErr;

      const delay = 400 * Math.pow(2, attempt) + Math.random() * 200;
      await new Promise(resolve => setTimeout(resolve, delay));
    }catch(err){
      lastErr = err;
      if (attempt === maxRetries) throw err;
      const delay = 400 * Math.pow(2, attempt) + Math.random() * 200;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastErr || new Error("HL request failed");
}

/* ---------- layout collapse ---------- */
function setRankCollapsed(collapsed){
  const root = qs("appRoot");
  root.classList.toggle("rank-collapsed", !!collapsed);
  localStorage.setItem("ws_rankCollapsed", collapsed ? "1" : "0");
}
function isRankCollapsed(){
  return qs("appRoot").classList.contains("rank-collapsed");
}

/* ---------- state ---------- */
const state = {
  datasets: [],
  datasetId: null,
  rawData: null,

  rows: [],
  columns: [],
  visibleCols: null,

  sort: { key: null, dir: -1 }, // rankings
  search: "",

  selected: new Set(),
  pinned: new Set(),

  posSearch: "",
  posSort: { key: "notional", dir: -1 }, // positions default: notional desc

  live: {
    mids: null,
    states: new Map(),
    lastTs: null,
    timer: null,
    intervalSec: 20,
    loading: false,
    inflight: null,
  },
};

const LS_SELECTED = "ws_selected";
const LS_PINNED   = "ws_pinned";
const LS_DATASET  = "ws_datasetId";
const LS_POLL     = "ws_poll";

/* ---------- manifest ---------- */
function normalizeManifest(m){
  if (!m) return [];
  if (Array.isArray(m)){
    return m.filter(x => typeof x === "string" && x.endsWith(".json"))
      .map(f => ({ id: f.replace(/\.json$/,""), title: f.replace(/\.json$/,""), file: `data/${f}` }));
  }
  if (Array.isArray(m.files)){
    return m.files.filter(f => typeof f === "string" && f.endsWith(".json"))
      .map(f => ({ id: f.replace(/\.json$/,""), title: f.replace(/\.json$/,""), file: `data/${f}` }));
  }
  if (Array.isArray(m.datasets)){
    return m.datasets.filter(d => d && d.file)
      .map(d => ({
        id: d.id || String(d.file).replace(/^.*\//,"").replace(/\.json$/,""),
        title: d.title || d.id || String(d.file).replace(/^.*\//,"").replace(/\.json$/,""),
        file: d.file
      }));
  }
  return [];
}

async function loadManifest(){
  const m = await fetchJson("data/manifest.json");
  const ds = normalizeManifest(m);
  if (!ds.length) throw new Error("manifest.json has no datasets");
  state.datasets = ds;
}

/* ---------- dataset parsing ---------- */
function normalizeDatasetData(data){
  // Goal: return { meta, rows } where rows is an array of objects

  // 1) already an array
  if (Array.isArray(data)) {
    return { meta: {}, rows: data };
  }

  // 2) object with known array keys
  if (data && typeof data === "object") {
    const knownKeys = ["rows", "data", "items", "rankings", "results", "wallets", "whales", "list"];
    for (const k of knownKeys) {
      if (Array.isArray(data[k])) {
        const meta = { ...data };
        delete meta[k];
        return { meta, rows: data[k] };
      }
    }

    // 3) object is a wallet->object map (very common)
    // Example: { "0xabc": {...}, "0xdef": {...} }
    const keys = Object.keys(data);
    const looksLikeMap =
      keys.length > 0 &&
      keys.length <= 5000 &&
      keys.every(k => normalizeWallet(k)) &&
      keys.every(k => data[k] && typeof data[k] === "object" && !Array.isArray(data[k]));

    if (looksLikeMap) {
      const rows = keys.map(k => ({ wallet: k, ...data[k] }));
      return { meta: {}, rows };
    }

    // 4) fallback: pick the largest array-of-objects among first-level props
    let bestKey = null;
    let bestLen = 0;
    for (const [k, v] of Object.entries(data)) {
      if (Array.isArray(v) && v.length > bestLen && (v.length === 0 || (v[0] && typeof v[0] === "object"))) {
        bestKey = k;
        bestLen = v.length;
      }
    }
    if (bestKey) {
      const meta = { ...data };
      delete meta[bestKey];
      return { meta, rows: data[bestKey] };
    }
  }

  return { meta: {}, rows: [] };
}


function inferColumns(rowsFlat){
  const freq = new Map();
  for (const r of rowsFlat.slice(0, 500)){
    for (const k of Object.keys(r)){
      if (k.startsWith("__")) continue;
      freq.set(k, (freq.get(k) || 0) + 1);
    }
  }

  const priority = [
    "__check","__rank","__wallet",
    "accountValue","metrics.accountValue","marginSummary.accountValue",
    "riskScore","metrics.riskScore","risk_score",
    "pnl","pnlPct","roi",
    "lastTradeTime","lastTradeTs",
    "positions.length","assetPositions.length"
  ];

  const all = Array.from(freq.entries()).sort((a,b)=> b[1]-a[1]).map(([k])=>k);

  const chosen = [];
  const set = new Set();
  for (const k of priority){
    if (freq.has(k) && !set.has(k)){ chosen.push(k); set.add(k); }
  }
  for (const k of all){
    if (set.has(k)) continue;
    chosen.push(k);
    set.add(k);
    if (chosen.length >= 36) break;
  }
  return chosen;
}

function loadVisibleColsFromStorage(datasetId, columns){
  const key = `ws_cols_${datasetId}`;
  try{
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    const valid = arr.filter(c => columns.includes(c));
    return new Set(valid);
  }catch(_){ return null; }
}

function saveVisibleColsToStorage(datasetId, visibleSet){
  const key = `ws_cols_${datasetId}`;
  localStorage.setItem(key, JSON.stringify(Array.from(visibleSet)));
}

/* ---------- rankings table ---------- */
function getCellValue(row, col){
  if (col === "__wallet") return row.__wallet || "";
  if (col === "__rank") return row.__rank ?? "";
  if (col === "__check") return "";
  return row[col];
}

function formatCell(v){
  if (v == null) return `<span class="muted">—</span>`;
  if (typeof v === "number"){
    if (!Number.isFinite(v)) return `<span class="muted">—</span>`;
    return esc(Math.abs(v) >= 1000 ? fmtCompact(v, 2) : String(v));
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string"){
    const n = toNum(v);
    if (Number.isFinite(n) && v.trim() !== "") return esc(fmtCompact(n, 2));
    const s = v.length > 72 ? v.slice(0, 68) + "…" : v;
    return `<span title="${esc(v)}">${esc(s)}</span>`;
  }
  return `<span class="muted" title="${esc(JSON.stringify(v))}">{…}</span>`;
}

function compareValues(a, b){
  const na = toNum(a), nb = toNum(b);
  const aNum = Number.isFinite(na), bNum = Number.isFinite(nb);
  if (aNum && bNum) return na - nb;
  return String(a ?? "").localeCompare(String(b ?? ""));
}

function filteredSortedRows(){
  const q = state.search.trim().toLowerCase();
  let out = state.rows;

  if (q){
    out = out.filter(r => {
      if ((r.__wallet || "").toLowerCase().includes(q)) return true;
      for (const k of state.columns){
        if (k === "__check") continue;
        const v = getCellValue(r, k);
        if (v == null) continue;
        if (String(v).toLowerCase().includes(q)) return true;
      }
      return false;
    });
  }

  if (state.sort.key){
    const k = state.sort.key;
    const dir = state.sort.dir;
    out = [...out].sort((r1,r2)=> compareValues(getCellValue(r1,k), getCellValue(r2,k)) * dir);
  }

  return out;
}

function renderRankTable(){
  const table = qs("rankTable");
  const rows = filteredSortedRows();
  if (!state.rows.length) {
    table.innerHTML = `
      <thead><tr><th>Rankings</th></tr></thead>
      <tbody><tr><td class="muted">
        No rows parsed from this dataset file.<br/>
        Your JSON may be a map (wallet→object) or use a different key than rows/data/items.<br/>
        (The loader now supports map + auto-detect; refresh once after updating script.js)
      </td></tr></tbody>
    `;
    qs("rankMeta").textContent = "(0 rows)";
    return;
  }
  const visible = state.visibleCols
    ? state.columns.filter(c => state.visibleCols.has(c))
    : state.columns;

  const cols = [];
  cols.push("__check");
  cols.push("__rank");
  cols.push("__wallet");
  for (const c of visible){
    if (c === "__check" || c === "__wallet" || c === "__rank") continue;
    cols.push(c);
  }

  const head = `
    <thead>
      <tr>
        ${cols.map(c => {
          const lbl = (c === "__check") ? "" : keyLabel(c);
          const arrow = (state.sort.key === c) ? (state.sort.dir === 1 ? " ▲" : " ▼") : "";
          const noSort = (c === "__check");
          return `<th data-col="${esc(c)}" ${noSort ? 'style="cursor:default"' : ""}>${esc(lbl)}${esc(arrow)}</th>`;
        }).join("")}
      </tr>
    </thead>
  `;

  const body = `
    <tbody>
      ${rows.map((r, idx) => {
        const w = r.__wallet || "";
        const checked = state.selected.has(w);
        const trCls = checked ? "selected" : "";
        const short = w ? (w.slice(0, 6) + "…" + w.slice(-4)) : "";
        return `
          <tr class="${trCls}" data-wallet="${esc(w)}">
            ${cols.map(c => {
              if (c === "__check"){
                return `<td><input type="checkbox" class="rowcheck" ${checked ? "checked" : ""} aria-label="select wallet" /></td>`;
              }
              if (c === "__wallet"){
                return `<td class="mono" title="${esc(w)}">${esc(short || "—")}</td>`;
              }
              if (c === "__rank"){
                return `<td class="muted">${esc(String(r.__rank ?? (idx+1)))}</td>`;
              }
              return `<td>${formatCell(getCellValue(r,c))}</td>`;
            }).join("")}
          </tr>
        `;
      }).join("")}
    </tbody>
  `;

  table.innerHTML = head + body;

  table.querySelectorAll("thead th").forEach(th => {
    const col = th.getAttribute("data-col");
    if (!col || col === "__check") return;
    th.addEventListener("click", () => {
      if (state.sort.key === col) state.sort.dir *= -1;
      else { state.sort.key = col; state.sort.dir = -1; }
      renderRankTable();
    });
  });

  // Row click toggles checkbox
  table.querySelectorAll("tbody tr").forEach(tr => {
    tr.addEventListener("click", (e) => {
      if (e.target.closest("input") || e.target.closest("a") || e.target.closest("button")) return;
      const cb = tr.querySelector("input.rowcheck");
      if (cb) cb.click();
    });
  });

  table.querySelectorAll("input.rowcheck").forEach(cb => {
    cb.addEventListener("click", (e) => {
      e.stopPropagation();
      const tr = cb.closest("tr");
      const wallet = tr?.getAttribute("data-wallet") || "";
      if (!wallet) return;
      if (cb.checked) state.selected.add(wallet);
      else {
        state.selected.delete(wallet);
        state.pinned.delete(wallet); // keep pinned clean
        persistPinned();
      }
      persistSelected();
      syncSelectedRowStyles();
      onSelectionChanged();
    });
  });

  qs("rankMeta").textContent = `(${rows.length.toLocaleString()} shown)`;
}

function renderRankTableError(message){
  const table = qs("rankTable");
  table.innerHTML = `
    <thead><tr><th>Rankings</th></tr></thead>
    <tbody><tr><td class="muted">${esc(message)}</td></tr></tbody>
  `;
  qs("rankMeta").textContent = "(load failed)";
}

function syncSelectedRowStyles(){
  const table = qs("rankTable");
  table.querySelectorAll("tbody tr").forEach(tr => {
    const w = tr.getAttribute("data-wallet") || "";
    const checked = state.selected.has(w);
    const cb = tr.querySelector("input.rowcheck");
    if (cb) cb.checked = checked;
    tr.classList.toggle("selected", checked);
  });
}

/* ---------- columns modal ---------- */
function openColumnsModal(){
  const backdrop = qs("colModalBackdrop");
  const modal = qs("colModal");
  const list = qs("colChecklist");

  const cols = state.columns.filter(c => c !== "__check");
  const visible = state.visibleCols || new Set(cols);

  list.innerHTML = cols.map(c => {
    const mustShow = (c === "__wallet" || c === "__rank");
    const checked = mustShow || visible.has(c);
    return `
      <label class="col-item">
        <input type="checkbox" data-col="${esc(c)}" ${checked ? "checked" : ""} ${mustShow ? "disabled" : ""} />
        <span>${esc(keyLabel(c))}</span>
        <span class="muted small mono">${esc(c)}</span>
      </label>
    `;
  }).join("");

  backdrop.classList.remove("hidden");
  modal.classList.remove("hidden");
}
function closeColumnsModal(){
  qs("colModalBackdrop").classList.add("hidden");
  qs("colModal").classList.add("hidden");
}
function applyColumnsFromModal(){
  const checks = Array.from(qs("colChecklist").querySelectorAll("input[type=checkbox]"));
  const visible = new Set();
  for (const cb of checks){
    const col = cb.getAttribute("data-col");
    if (col && cb.checked) visible.add(col);
  }
  visible.add("__wallet"); visible.add("__rank");
  state.visibleCols = visible;
  saveVisibleColsToStorage(state.datasetId, visible);
  closeColumnsModal();
  renderRankTable();
}

/* ---------- persistence ---------- */
function persistSelected(){
  localStorage.setItem(LS_SELECTED, JSON.stringify(Array.from(state.selected)));
}
function loadSelected(){
  try{
    const raw = localStorage.getItem(LS_SELECTED);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) state.selected = new Set(arr.map(normalizeWallet).filter(Boolean));
  }catch(_){}
}

function persistPinned(){
  localStorage.setItem(LS_PINNED, JSON.stringify(Array.from(state.pinned)));
}
function loadPinned(){
  try{
    const raw = localStorage.getItem(LS_PINNED);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) state.pinned = new Set(arr.map(normalizeWallet).filter(Boolean));
  }catch(_){}
}

/* ---------- live update (with guard + loading UI) ---------- */
function setLiveStatus(text){
  qs("liveStatus").textContent = text || "";
}

function sleep(ms){
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function updateLive(){
  const wallets = Array.from(state.selected);
  if (!wallets.length){
    state.live.states.clear();
    state.live.lastTs = null;
    state.live.mids = null;
    renderWatchPanel();
    return;
  }

  if (state.live.loading) return;
  state.live.loading = true;
  setLiveStatus("Updating live data…");
  let liveWarning = null;

  try{
    try{
      const mids = await hlPost({ type: "allMids" });
      state.live.mids = mids;
    }catch(err){
      liveWarning = `failed to load mids (${err?.message || err})`;
      state.live.mids = null;
    }

    const results = [];
    let chunkSize = 60;
    let idx = 0;

    while (idx < wallets.length){
      const chunk = wallets.slice(idx, idx + chunkSize);
      try{
        const resp = await hlPost({ type: "batchClearinghouseStates", users: chunk });
        for (let j=0; j<chunk.length; j++){
          results.push([chunk[j], resp[j]]);
        }
        idx += chunk.length;
      }catch(err){
        if (chunk.length > 1){
          const smaller = Math.max(1, Math.floor(chunk.length / 2));
          chunkSize = Math.max(10, smaller);
          await sleep(200);
          continue;
        }

        try{
          const single = await hlPost({ type: "clearinghouseState", user: chunk[0] });
          results.push([chunk[0], single]);
        }catch(singleErr){
          results.push([chunk[0], null]);
          liveWarning = singleErr?.message || String(singleErr);
        }
        idx += 1;
      }
      await sleep(120);
    }

    state.live.states = new Map(results);
    state.live.lastTs = Date.now();
  } finally {
    state.live.loading = false;
    const t = state.live.lastTs ? new Date(state.live.lastTs).toLocaleTimeString() : "—";
    const warningText = liveWarning ? ` (warning: ${liveWarning})` : "";
    setLiveStatus(`Live updated: ${t}${warningText}`);
    renderWatchPanel();
  }
}

function extractMarginSummary(st){
  const ms =
    st?.marginSummary ||
    st?.crossMarginSummary ||
    st?.summary ||
    st?.accountSummary ||
    null;

  // accountValue + notional + margin used often in ms
  const accountValue = pickNum(ms, ["accountValue", "accountValueUsd", "account_value"]);
  const totalNtlPos  = pickNum(ms, ["totalNtlPos", "totalNotional", "notional", "totalNtlPosUsd"]);
  const marginUsed   = pickNum(ms, ["totalMarginUsed", "marginUsed", "margin_used", "totalMargin"]);

  // withdrawable commonly at top-level "withdrawable"
  const withdrawableTop = pickNum(st, ["withdrawable", "withdrawableUsd", "availableToWithdraw", "maxWithdrawable"]);
  const withdrawableMs  = pickNum(ms, ["withdrawable", "availableToWithdraw", "maxWithdrawable", "withdrawableUsd"]);
  const withdrawable = Number.isFinite(withdrawableTop) ? withdrawableTop : withdrawableMs;

  const leverage = pickNum(ms, ["leverage", "crossLeverage"]);

  return { ms, accountValue, totalNtlPos, marginUsed, withdrawable, leverage };
}

function extractPositions(st, mids){
  const aps = Array.isArray(st?.assetPositions) ? st.assetPositions : [];
  const out = [];
  for (const ap of aps){
    const p = ap?.position || ap;
    if (!p) continue;

    const coin = p.coin || p.symbol || p.asset || "";
    const szi = toNum(p.szi ?? p.size ?? p.positionSize);
    if (!Number.isFinite(szi) || szi === 0) continue;

    const entryPx = toNum(p.entryPx ?? p.entryPrice);
    const unrealizedPnl = toNum(p.unrealizedPnl ?? p.upnl ?? p.pnlUnrealized ?? p.pnl);
    const lev = toNum(p.leverage?.value ?? p.leverage);
    const liqPx = toNum(p.liquidationPx ?? p.liqPx ?? p.liquidation_price);
    const roeRaw = toNum(p.returnOnEquity ?? p.roe);

    const mark = toNum(mids?.[coin]);
    const notional = Number.isFinite(mark) ? Math.abs(szi) * mark : toNum(p.positionValue ?? p.notional);

    const side = szi > 0 ? "LONG" : "SHORT";
    const roePct = Number.isFinite(roeRaw) ? roeRaw * 100 : NaN; // HL usually gives decimal

    out.push({
      coin,
      side,
      size: szi,
      entryPx,
      markPx: mark,
      notional,
      upnl: unrealizedPnl,
      lev,
      liqPx,
      roePct,
    });
  }
  return out;
}

/* ---------- positions sorting ---------- */
function posValue(r, key){
  if (key === "wallet") return r.wallet;
  return r[key];
}
function comparePos(a, b){
  const na = toNum(a), nb = toNum(b);
  const aNum = Number.isFinite(na), bNum = Number.isFinite(nb);
  if (aNum && bNum) return na - nb;
  return String(a ?? "").localeCompare(String(b ?? ""));
}

/* ---------- watch panel render (pins + copy) ---------- */
async function copyText(text){
  try{
    await navigator.clipboard.writeText(text);
    setLiveStatus("Copied wallet.");
    setTimeout(() => setLiveStatus(""), 1200);
  }catch(_){
    // fallback
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    setLiveStatus("Copied wallet.");
    setTimeout(() => setLiveStatus(""), 1200);
  }
}

function renderWatchPanel(){
  const empty = qs("watchEmpty");
  const cards = qs("walletCards");
  const posTable = qs("posTable");
  const watchMeta = qs("watchMeta");

  const walletsAll = Array.from(state.selected);

  if (!walletsAll.length){
    empty.classList.remove("hidden");
    cards.innerHTML = "";
    posTable.innerHTML = "";
    watchMeta.textContent = "";
    return;
  }

  empty.classList.add("hidden");

  // sort wallets: pinned first, then rest
  const wallets = [...walletsAll].sort((a,b) => {
    const ap = state.pinned.has(a) ? 0 : 1;
    const bp = state.pinned.has(b) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return a.localeCompare(b);
  });

  const last = state.live.lastTs ? new Date(state.live.lastTs).toLocaleTimeString() : "—";
  watchMeta.textContent = `(selected ${wallets.length}, last ${last}${state.live.loading ? ", updating…" : ""})`;

  cards.innerHTML = wallets.map(w => {
    const st = state.live.states.get(w);
    const msx = extractMarginSummary(st);
    const short = w.slice(0,6) + "…" + w.slice(-4);

    const pinned = state.pinned.has(w);
    const pinCls = pinned ? "pinned" : "";

    const badge =
      Number.isFinite(msx.withdrawable) ? `<span class="badge ok">withdrawable ${esc(fmtUSD(msx.withdrawable))}</span>` :
      `<span class="badge">watching</span>`;

    return `
      <div class="card">
        <div class="card-head">
          <div class="card-title">
            <span class="mono" title="${esc(w)}">${esc(short)}</span>
            ${badge}
          </div>
          <div class="card-actions">
            <button class="btn-icon ${pinCls}" data-pin="${esc(w)}" title="Pin">${pinned ? "📌" : "📍"}</button>
            <button class="btn-icon" data-copy="${esc(w)}" title="Copy wallet">⧉</button>
            <button class="btn btn-ghost" data-unwatch="${esc(w)}">Remove</button>
          </div>
        </div>
        <div class="card-body">
          <div class="kv">
            <div><div class="k">Account value</div><div class="v">${esc(fmtUSD(msx.accountValue))}</div></div>
            <div><div class="k">Notional</div><div class="v">${esc(fmtUSD(msx.totalNtlPos))}</div></div>
            <div><div class="k">Margin used</div><div class="v">${esc(fmtUSD(msx.marginUsed))}</div></div>
            <div><div class="k">Withdrawable</div><div class="v">${esc(fmtUSD(msx.withdrawable))}</div></div>
          </div>
        </div>
      </div>
    `;
  }).join("");

  // card actions
  cards.querySelectorAll("[data-unwatch]").forEach(btn => {
    btn.addEventListener("click", () => {
      const w = btn.getAttribute("data-unwatch");
      if (!w) return;
      state.selected.delete(w);
      state.pinned.delete(w);
      persistSelected();
      persistPinned();
      syncSelectedRowStyles();
      onSelectionChanged();
    });
  });

  cards.querySelectorAll("[data-pin]").forEach(btn => {
    btn.addEventListener("click", () => {
      const w = btn.getAttribute("data-pin");
      if (!w) return;
      if (state.pinned.has(w)) state.pinned.delete(w);
      else state.pinned.add(w);
      persistPinned();
      renderWatchPanel();
    });
  });

  cards.querySelectorAll("[data-copy]").forEach(btn => {
    btn.addEventListener("click", () => {
      const w = btn.getAttribute("data-copy");
      if (w) copyText(w);
    });
  });

  // Positions table
  const mids = state.live.mids || {};
  let posRows = [];
  for (const w of walletsAll){
    const st = state.live.states.get(w);
    const ps = extractPositions(st, mids).map(p => ({ wallet: w, ...p }));
    posRows.push(...ps);
  }

  const q = state.posSearch.trim().toLowerCase();
  if (q){
    posRows = posRows.filter(r => {
      if (r.wallet.toLowerCase().includes(q)) return true;
      if ((r.coin || "").toLowerCase().includes(q)) return true;
      if ((r.side || "").toLowerCase().includes(q)) return true;
      return false;
    });
  }

  // sort by positions sort state
  const sk = state.posSort.key;
  const sd = state.posSort.dir;
  posRows.sort((a,b)=> comparePos(posValue(a,sk), posValue(b,sk)) * sd);

  const head = `
    <thead>
      <tr>
        ${[
          ["wallet","Wallet"],
          ["coin","Coin"],
          ["side","Side"],
          ["size","Size"],
          ["entryPx","Entry"],
          ["markPx","Mark"],
          ["notional","Notional"],
          ["upnl","uPnL"],
          ["roePct","ROE%"],
          ["liqPx","Liq"],
          ["lev","Lev"],
        ].map(([k,lab]) => {
          const arrow = (state.posSort.key === k) ? (state.posSort.dir === 1 ? " ▲" : " ▼") : "";
          return `<th data-psort="${esc(k)}">${esc(lab + arrow)}</th>`;
        }).join("")}
      </tr>
    </thead>
  `;

  const body = `
    <tbody>
      ${posRows.map(r => {
        const short = r.wallet.slice(0,6) + "…" + r.wallet.slice(-4);
        const up = toNum(r.upnl);
        const upBadge =
          Number.isFinite(up) ? (up >= 0 ? `<span class="badge ok">+${esc(fmtCompact(up,2))}</span>` : `<span class="badge bad">${esc(fmtCompact(up,2))}</span>`)
          : `<span class="muted">—</span>`;
        const roe = toNum(r.roePct);
        return `
          <tr>
            <td class="mono" title="${esc(r.wallet)}">${esc(short)}</td>
            <td>${esc(r.coin || "—")}</td>
            <td>${esc(r.side || "—")}</td>
            <td class="mono">${esc(fmtCompact(toNum(r.size), 4))}</td>
            <td class="mono">${esc(fmtCompact(toNum(r.entryPx), 4))}</td>
            <td class="mono">${esc(fmtCompact(toNum(r.markPx), 4))}</td>
            <td>${esc(fmtUSD(toNum(r.notional)))}</td>
            <td>${upBadge}</td>
            <td class="mono">${Number.isFinite(roe) ? esc(roe.toFixed(2)) : "—"}</td>
            <td class="mono">${esc(fmtCompact(toNum(r.liqPx), 4))}</td>
            <td class="mono">${esc(fmtCompact(toNum(r.lev), 2))}</td>
          </tr>
        `;
      }).join("")}
    </tbody>
  `;

  posTable.innerHTML = head + body;

  // positions header sort click
  posTable.querySelectorAll("thead th[data-psort]").forEach(th => {
    th.addEventListener("click", () => {
      const k = th.getAttribute("data-psort");
      if (!k) return;
      if (state.posSort.key === k) state.posSort.dir *= -1;
      else {
        state.posSort.key = k;
        // default direction: numbers descending except wallet/coin asc
        state.posSort.dir = (k === "wallet" || k === "coin" || k === "side") ? 1 : -1;
      }
      renderWatchPanel();
    });
  });
}

/* ---------- splitter + focus ---------- */
function initSplitter(){
  const root = qs("appRoot");
  const splitter = qs("splitter");
  let dragging = false;

  splitter.addEventListener("mousedown", (e) => {
    dragging = true;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    if (isRankCollapsed()) return; // ignore when collapsed
    const rect = root.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = (x / rect.width) * 100;
    const clamped = clamp(pct, 24, 78);
    document.documentElement.style.setProperty("--leftW", `${clamped}%`);
    localStorage.setItem("ws_leftW", String(clamped));
  });

  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  });

  const saved = toNum(localStorage.getItem("ws_leftW"));
  if (Number.isFinite(saved)) document.documentElement.style.setProperty("--leftW", `${clamp(saved, 24, 78)}%`);
}

function stopPolling(){
  if (state.live.timer){
    clearInterval(state.live.timer);
    state.live.timer = null;
  }
}

function startPolling(){
  stopPolling();
  const sec = state.live.intervalSec;
  if (!sec || sec <= 0) return;
  state.live.timer = setInterval(() => {
    // do not overlap
    if (state.live.loading) return;
    updateLive().catch(console.error);
  }, sec * 1000);
}

async function onSelectionChanged(){
  await updateLive().catch(console.error);
}

/* ---------- dataset load ---------- */
async function loadDatasetById(id){
  const ds = state.datasets.find(d => d.id === id) || state.datasets[0];
  if (!ds) throw new Error("No dataset found");
  state.datasetId = ds.id;

  let data;
  try{
    data = await fetchJson(ds.file);
  }catch(err){
    const hint = location.protocol === "file:" ? "Tip: open index.html via a local web server (e.g. python -m http.server)." : "";
    const msg = `Failed to load ${ds.file}. ${err?.message || err}. ${hint}`.trim();
    renderRankTableError(msg);
    throw err;
  }
  state.rawData = data;

  const { meta, rows } = normalizeDatasetData(data);

  // Build flattened rows
  const built = rows.map((r, i) => {
    const base = (r && typeof r === "object") ? r : { value: r };
    const flat = flatten(base);

    // wallet from row fields
    let wallet = tryAddress(flat);

    // if still not found, try common direct keys on original object
    if (!wallet && base) {
      wallet = normalizeWallet(base.wallet) || normalizeWallet(base.address) || normalizeWallet(base.user);
    }

    flat.__wallet = wallet || ""; // keep row, even if wallet missing
    flat.__rank   = base.rank ?? base.__rank ?? (i + 1);
    return flat;
  });

  // If many rows have wallet missing, DON'T drop everything silently.
  // Only filter out rows if they are totally unusable (no object + no wallet).
  state.rows = built.filter(r => r && typeof r === "object");

  // Columns inferred from full data
  state.columns = inferColumns(state.rows);

  // restore visible columns
  state.visibleCols = loadVisibleColsFromStorage(state.datasetId, state.columns);

  // meta display
  const metaParts = [];
  if (meta?.generatedAt) metaParts.push(`updated ${new Date(meta.generatedAt).toLocaleString()}`);
  if (meta?.count) metaParts.push(`count ${meta.count}`);

  const walletCount = state.rows.filter(r => r.__wallet).length;
  metaParts.push(`wallets ${walletCount}/${state.rows.length}`);

  qs("rankMeta").textContent = metaParts.length ? `(${metaParts.join(" • ")})` : "";

  renderRankTable();
  renderWatchPanel();
}

/* ---------- UI bindings ---------- */
function fillDatasetSelect(){
  const sel = qs("datasetSelect");
  sel.innerHTML = state.datasets.map(d => `<option value="${esc(d.id)}">${esc(d.title)}</option>`).join("");

  const last = localStorage.getItem(LS_DATASET);
  const pick = (last && state.datasets.some(d => d.id === last)) ? last : state.datasets[0]?.id;
  if (pick){
    sel.value = pick;
    state.datasetId = pick;
  }
}

function bindUI(){
  const debouncedRankRender = debounce(() => renderRankTable(), 120);
  const debouncedPosRender  = debounce(() => renderWatchPanel(), 120);

  qs("rankSearch").addEventListener("input", (e) => {
    state.search = e.target.value || "";
    debouncedRankRender();
  });

  qs("posSearch").addEventListener("input", (e) => {
    state.posSearch = e.target.value || "";
    debouncedPosRender();
  });

  qs("datasetSelect").addEventListener("change", async (e) => {
    const id = e.target.value;
    localStorage.setItem(LS_DATASET, id);
    await loadDatasetById(id);
    await updateLive().catch(console.error);
  });

  qs("btnRefresh").addEventListener("click", async () => {
    await loadDatasetById(qs("datasetSelect").value);
    await updateLive().catch(console.error);
  });

  qs("btnRefreshLive").addEventListener("click", () => updateLive().catch(console.error));

  qs("pollInterval").addEventListener("change", (e) => {
    state.live.intervalSec = toNum(e.target.value);
    localStorage.setItem(LS_POLL, String(state.live.intervalSec));
    startPolling();
  });

  qs("btnClearSelection").addEventListener("click", () => {
    state.selected.clear();
    state.pinned.clear();
    persistSelected();
    persistPinned();
    renderRankTable();
    onSelectionChanged();
  });

  qs("btnColumns").addEventListener("click", openColumnsModal);
  qs("btnCloseColumns").addEventListener("click", closeColumnsModal);
  qs("colModalBackdrop").addEventListener("click", closeColumnsModal);

  qs("btnColsAll").addEventListener("click", () => {
    const checks = qs("colChecklist").querySelectorAll("input[type=checkbox]:not([disabled])");
    checks.forEach(cb => cb.checked = true);
  });
  qs("btnColsNone").addEventListener("click", () => {
    const checks = qs("colChecklist").querySelectorAll("input[type=checkbox]:not([disabled])");
    checks.forEach(cb => cb.checked = false);
  });
  qs("btnColsApply").addEventListener("click", applyColumnsFromModal);

  qs("btnCollapseRank").addEventListener("click", () => {
    setRankCollapsed(!isRankCollapsed());
  });

  qs("btnFocus").addEventListener("click", () => {
    setRankCollapsed(true);
  });

  qs("btnCollapseWatch").addEventListener("click", () => qs("watchBody").classList.toggle("hidden"));

  // Manual add wallet
  qs("btnAddWallet").addEventListener("click", async () => {
    const raw = qs("manualWallet").value;
    const w = normalizeWallet(raw);
    if (!w){
      alert("Invalid wallet. Expected 0x + 40 hex chars.");
      return;
    }
    state.selected.add(w);
    persistSelected();
    qs("manualWallet").value = "";
    renderRankTable(); // checkboxes update if wallet exists in ranking
    await onSelectionChanged();
  });

  qs("manualWallet").addEventListener("keydown", (e) => {
    if (e.key === "Enter") qs("btnAddWallet").click();
  });
}

/* ---------- init ---------- */
async function init(){
  loadSelected();
  loadPinned();

  // restore collapse state
  setRankCollapsed(localStorage.getItem("ws_rankCollapsed") === "1");

  // restore poll interval
  const savedPoll = toNum(localStorage.getItem(LS_POLL));
  if (Number.isFinite(savedPoll)){
    state.live.intervalSec = savedPoll;
    qs("pollInterval").value = String(savedPoll);
  } else {
    state.live.intervalSec = toNum(qs("pollInterval").value);
  }

  initSplitter();
  bindUI();

  try{
    await loadManifest();
    fillDatasetSelect();
    await loadDatasetById(qs("datasetSelect").value);

    await updateLive().catch(console.error);
    startPolling();
  }catch(err){
    const hint = location.protocol === "file:" ? "Tip: open index.html via a local web server (e.g. python -m http.server)." : "";
    renderRankTableError(`Unable to initialize datasets. ${err?.message || err}. ${hint}`.trim());
    console.error(err);
  }
}

document.addEventListener("DOMContentLoaded", init);
