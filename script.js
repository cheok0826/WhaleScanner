/* WhaleScanner Dashboard (no deps)
 * - Loads rankings datasets (flatten nested keys -> filled columns)
 * - Search + sort
 * - Row click toggles checkbox
 * - Select wallets => live polling (batchClearinghouseStates) + positions table
 * - Resizable splitter + collapsible panels
 */

const HL_INFO = "https://api.hyperliquid.xyz/info";

// ---------- small utils ----------
function qs(id){ return document.getElementById(id); }
function esc(s){ return String(s ?? "").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

function toNum(v){
  if (v == null) return NaN;
  if (typeof v === "number") return v;
  if (typeof v === "string"){
    const x = Number(v);
    return Number.isFinite(x) ? x : NaN;
  }
  // sometimes API gives { value: "123" }
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
  // small numbers
  if (abs >= 100) return `${sign}${abs.toFixed(0)}`;
  if (abs >= 1) return `${sign}${abs.toFixed(2)}`;
  return `${sign}${abs.toFixed(4)}`;
}

function fmtUSD(n){ return Number.isFinite(n) ? `$${fmtCompact(n, 2)}` : "—"; }
function fmtPct(n){
  if (!Number.isFinite(n)) return "—";
  return `${(n*100).toFixed(2)}%`;
}

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
      // keep array length (often positions etc)
      out[`${key}.length`] = v.length;
    } else {
      out[key] = v;
    }
  }
  return out;
}

function tryAddress(rowFlat){
  const candidates = [
    rowFlat.wallet, rowFlat.address, rowFlat.user, rowFlat.owner,
    rowFlat["wallet.address"], rowFlat["user.address"], rowFlat["account.address"],
    rowFlat["meta.wallet"], rowFlat["meta.address"],
  ].filter(Boolean);
  if (candidates.length) return String(candidates[0]);
  // last resort: find any field that looks like @ or 0x (but hyperliquid is 0x...)
  for (const [k,v] of Object.entries(rowFlat)){
    if (typeof v === "string" && v.startsWith("0x") && v.length >= 10) return v;
  }
  return "";
}

function keyLabel(k){
  // prettier header labels
  return k
    .replace(/^__/, "")
    .replace(/\.length$/," (len)")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .trim();
}

async function fetchJson(url){
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return await r.json();
}

async function hlPost(payload){
  const r = await fetch(HL_INFO, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`HL HTTP ${r.status}`);
  return await r.json();
}

// ---------- app state ----------
const state = {
  datasets: [],         // from manifest
  datasetId: null,
  rawData: null,        // loaded dataset json
  rows: [],             // flattened rows
  columns: [],          // all inferred columns
  visibleCols: null,    // set of columns to show (persisted)
  sort: { key: null, dir: 1 }, // dir 1 asc, -1 desc
  search: "",
  selected: new Set(),  // wallet addresses selected
  live: {
    mids: null,
    states: new Map(),  // wallet -> clearinghouseState
    lastTs: null,
    timer: null,
    intervalSec: 20,
  },
  posSearch: "",
};

// ---------- manifest / dataset loading ----------
async function loadManifest(){
  // Recommended: data/manifest.json
  // Fallback: try a few common names, else provide minimal default
  const candidates = [
    "data/manifest.json",
    "data/index.json",
    "data/files.json",
  ];

  for (const u of candidates){
    try{
      const m = await fetchJson(u);
      const ds = normalizeManifest(m);
      if (ds.length){
        state.datasets = ds;
        return;
      }
    }catch(_){}
  }

  // fallback (edit if you don’t use manifest yet)
  state.datasets = [
    { id: "rank_risk", title: "rank_risk", file: "data/rank_risk.json" },
    { id: "rank_pnl",  title: "rank_pnl",  file: "data/rank_pnl.json" },
  ];
}

function normalizeManifest(m){
  // Accept:
  // { datasets:[{id,title,file}] }
  // or { files:["a.json","b.json"] }
  // or ["a.json","b.json"]
  if (!m) return [];
  if (Array.isArray(m)){
    return m
      .filter(x => typeof x === "string" && x.endsWith(".json"))
      .map(f => ({ id: f.replace(/\.json$/,""), title: f.replace(/\.json$/,""), file: `data/${f}` }));
  }
  if (Array.isArray(m.files)){
    return m.files
      .filter(f => typeof f === "string" && f.endsWith(".json"))
      .map(f => ({ id: f.replace(/\.json$/,""), title: f.replace(/\.json$/,""), file: `data/${f}` }));
  }
  if (Array.isArray(m.datasets)){
    return m.datasets
      .filter(d => d && d.file)
      .map(d => ({
        id: d.id || String(d.file).replace(/^.*\//,"").replace(/\.json$/,""),
        title: d.title || d.id || String(d.file).replace(/^.*\//,"").replace(/\.json$/,""),
        file: d.file
      }));
  }
  return [];
}

function normalizeDatasetData(data){
  // Accept:
  // - array of rows
  // - { rows:[...] }
  // - { data:[...] }
  // - { items:[...] }
  // also keep metadata if present
  if (Array.isArray(data)) return { meta: {}, rows: data };
  if (data && typeof data === "object"){
    const rows =
      (Array.isArray(data.rows) && data.rows) ||
      (Array.isArray(data.data) && data.data) ||
      (Array.isArray(data.items) && data.items) ||
      (Array.isArray(data.rankings) && data.rankings) ||
      [];
    const meta = { ...data };
    delete meta.rows; delete meta.data; delete meta.items; delete meta.rankings;
    return { meta, rows };
  }
  return { meta: {}, rows: [] };
}

function inferColumns(rowsFlat){
  const freq = new Map();
  for (const r of rowsFlat.slice(0, 400)){
    for (const k of Object.keys(r)){
      if (k.startsWith("__")) continue;
      freq.set(k, (freq.get(k) || 0) + 1);
    }
  }

  const priority = [
    "__check",
    "__rank",
    "__wallet",
    "wallet","address","user",
    "accountValue","metrics.accountValue","marginSummary.accountValue",
    "riskScore","metrics.riskScore","risk_score",
    "pnl","pnlPct","pnlPercent","roi","winRate",
    "lastTradeTime","lastTradeTs",
    "positions.length","assetPositions.length",
    "openPositions","numPositions",
  ];

  const all = Array.from(freq.entries())
    .sort((a,b)=> b[1]-a[1])
    .map(([k])=>k);

  // Keep many columns (table scroll handles it)
  const chosen = [];
  const set = new Set();
  for (const k of priority){
    if (freq.has(k) && !set.has(k)){ chosen.push(k); set.add(k); }
  }
  for (const k of all){
    if (set.has(k)) continue;
    chosen.push(k);
    set.add(k);
    if (chosen.length >= 34) break;
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
  }catch(_){
    return null;
  }
}

function saveVisibleColsToStorage(datasetId, visibleSet){
  const key = `ws_cols_${datasetId}`;
  localStorage.setItem(key, JSON.stringify(Array.from(visibleSet)));
}

// ---------- rankings rendering ----------
function getCellValue(row, col){
  if (col === "__wallet") return row.__wallet || "";
  if (col === "__rank") return row.__rank ?? "";
  if (col === "__check") return "";
  return row[col];
}

function formatCell(v){
  if (v == null) return `<span class="muted">—</span>`;
  if (typeof v === "number"){
    // show raw for small, compact for big
    if (!Number.isFinite(v)) return `<span class="muted">—</span>`;
    if (Math.abs(v) >= 1000) return esc(fmtCompact(v, 2));
    return esc(String(v));
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string"){
    // if looks like number, keep it but prettify
    const n = toNum(v);
    if (Number.isFinite(n) && String(v).trim() !== "") return esc(fmtCompact(n, 2));
    // long string -> ellipsis
    const s = v.length > 72 ? v.slice(0, 68) + "…" : v;
    return `<span title="${esc(v)}">${esc(s)}</span>`;
  }
  return `<span class="muted" title="${esc(JSON.stringify(v))}">{…}</span>`;
}

function compareValues(a, b){
  // numeric sort if possible
  const na = toNum(a);
  const nb = toNum(b);
  const aNum = Number.isFinite(na);
  const bNum = Number.isFinite(nb);
  if (aNum && bNum) return na - nb;

  const sa = (a == null) ? "" : String(a);
  const sb = (b == null) ? "" : String(b);
  return sa.localeCompare(sb);
}

function filteredSortedRows(){
  const q = state.search.trim().toLowerCase();
  let out = state.rows;

  if (q){
    out = out.filter(r => {
      // quick check: wallet + a few common keys
      if ((r.__wallet || "").toLowerCase().includes(q)) return true;
      for (const k of state.columns){
        if (k === "__check") continue;
        const v = getCellValue(r, k);
        if (v == null) continue;
        const s = String(v).toLowerCase();
        if (s.includes(q)) return true;
      }
      return false;
    });
  }

  if (state.sort.key){
    const k = state.sort.key;
    const dir = state.sort.dir;
    out = [...out].sort((r1,r2)=> {
      const v1 = getCellValue(r1, k);
      const v2 = getCellValue(r2, k);
      const c = compareValues(v1, v2);
      return c * dir;
    });
  }

  return out;
}

function renderRankTable(){
  const table = qs("rankTable");
  const rows = filteredSortedRows();

  const visible = state.visibleCols
    ? state.columns.filter(c => state.visibleCols.has(c))
    : state.columns;

  // Always keep checkbox + wallet visible
  const cols = [];
  cols.push("__check");
  if (!visible.includes("__rank")) cols.push("__rank");
  cols.push("__wallet");
  for (const c of visible){
    if (c === "__check" || c === "__wallet") continue;
    if (c === "__rank") continue; // already
    cols.push(c);
  }

  const head = `
    <thead>
      <tr>
        ${cols.map(c => {
          const lbl = (c === "__check") ? "" : keyLabel(c);
          const arrow = (state.sort.key === c) ? (state.sort.dir === 1 ? " ▲" : " ▼") : "";
          const noSort = (c === "__check");
          return `<th data-col="${esc(c)}" ${noSort ? 'style="cursor:default"' : ""}>
            ${esc(lbl)}${esc(arrow)}
          </th>`;
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
        return `
          <tr class="${trCls}" data-wallet="${esc(w)}">
            ${cols.map(c => {
              if (c === "__check"){
                return `<td>
                  <input type="checkbox" class="rowcheck" ${checked ? "checked" : ""} aria-label="select wallet" />
                </td>`;
              }
              if (c === "__wallet"){
                const short = w ? (w.slice(0, 6) + "…" + w.slice(-4)) : "";
                return `<td class="mono" title="${esc(w)}">${esc(short || "—")}</td>`;
              }
              if (c === "__rank"){
                return `<td class="muted">${esc(String(r.__rank ?? (idx+1)))}</td>`;
              }
              const v = getCellValue(r, c);
              return `<td>${formatCell(v)}</td>`;
            }).join("")}
          </tr>
        `;
      }).join("")}
    </tbody>
  `;

  table.innerHTML = head + body;

  // Header sort
  table.querySelectorAll("thead th").forEach(th => {
    const col = th.getAttribute("data-col");
    if (!col || col === "__check") return;
    th.addEventListener("click", () => {
      if (state.sort.key === col) state.sort.dir *= -1;
      else { state.sort.key = col; state.sort.dir = -1; } // default: descending
      renderRankTable();
    });
  });

  // Row click toggles checkbox (except click on inputs/links)
  table.querySelectorAll("tbody tr").forEach(tr => {
    tr.addEventListener("click", (e) => {
      if (e.target.closest("input") || e.target.closest("a") || e.target.closest("button")) return;
      const cb = tr.querySelector("input.rowcheck");
      if (cb) cb.click();
    });
  });

  // Checkbox events
  table.querySelectorAll("input.rowcheck").forEach(cb => {
    cb.addEventListener("click", (e) => {
      e.stopPropagation();
      const tr = cb.closest("tr");
      const wallet = tr?.getAttribute("data-wallet") || "";
      if (!wallet) return;
      if (cb.checked) state.selected.add(wallet);
      else state.selected.delete(wallet);
      persistSelected();
      syncSelectedRowStyles();
      onSelectionChanged();
    });
  });

  qs("rankMeta").textContent = `(${rows.length.toLocaleString()} shown)`;
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

function openColumnsModal(){
  const backdrop = qs("colModalBackdrop");
  const modal = qs("colModal");
  const list = qs("colChecklist");

  const cols = state.columns.filter(c => c !== "__check"); // keep check special
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
    if (!col) continue;
    if (cb.checked) visible.add(col);
  }
  // always keep these
  visible.add("__wallet");
  visible.add("__rank");
  state.visibleCols = visible;
  saveVisibleColsToStorage(state.datasetId, visible);
  closeColumnsModal();
  renderRankTable();
}

// ---------- selection persistence ----------
function persistSelected(){
  localStorage.setItem("ws_selected", JSON.stringify(Array.from(state.selected)));
}
function loadSelected(){
  try{
    const raw = localStorage.getItem("ws_selected");
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)){
      state.selected = new Set(arr.filter(Boolean));
    }
  }catch(_){}
}

// ---------- live positions ----------
async function updateLive(){
  const wallets = Array.from(state.selected);
  if (!wallets.length){
    state.live.states.clear();
    state.live.lastTs = null;
    renderWatchPanel();
    return;
  }

  // fetch mids once per refresh
  const mids = await hlPost({ type: "allMids" });
  state.live.mids = mids;

  // batch states (chunk to be safe)
  const CHUNK = 80;
  const results = [];
  for (let i=0; i<wallets.length; i+=CHUNK){
    const chunk = wallets.slice(i, i+CHUNK);
    const resp = await hlPost({ type: "batchClearinghouseStates", users: chunk });
    // response is ordered list (same as chunk)
    for (let j=0; j<chunk.length; j++){
      results.push([chunk[j], resp[j]]);
    }
  }

  state.live.states = new Map(results);
  state.live.lastTs = Date.now();
  renderWatchPanel();
}

function extractMarginSummary(st){
  // Hyperliquid can change shape; try multiple likely places/keys.
  const ms =
    st?.marginSummary ||
    st?.crossMarginSummary ||
    st?.summary ||
    st?.accountSummary ||
    null;

  const accountValue = pickNum(ms, ["accountValue", "accountValueUsd", "account_value"]);
  const totalNtlPos  = pickNum(ms, ["totalNtlPos", "totalNotional", "notional", "totalNtlPosUsd"]);
  const marginUsed   = pickNum(ms, ["totalMarginUsed", "marginUsed", "margin_used", "totalMargin"]);
  const withdrawable = pickNum(ms, ["withdrawable", "availableToWithdraw", "maxWithdrawable", "withdrawableUsd"]);
  const leverage     = pickNum(ms, ["leverage", "crossLeverage"]);

  return { ms, accountValue, totalNtlPos, marginUsed, withdrawable, leverage };
}

function extractPositions(st, mids){
  const aps = Array.isArray(st?.assetPositions) ? st.assetPositions : [];
  const out = [];
  for (const ap of aps){
    const p = ap?.position || ap;
    if (!p) continue;

    const coin = p.coin || p.symbol || p.asset || p.name || "";
    const szi = toNum(p.szi ?? p.size ?? p.positionSize);
    if (!Number.isFinite(szi) || szi === 0) continue;

    const entryPx = toNum(p.entryPx ?? p.entryPrice);
    const unrealizedPnl = toNum(p.unrealizedPnl ?? p.upnl ?? p.pnlUnrealized ?? p.pnl);
    const lev = toNum(p.leverage?.value ?? p.leverage);
    const mark = toNum(mids?.[coin]);
    const notional = Number.isFinite(mark) ? Math.abs(szi) * mark : toNum(p.positionValue ?? p.notional);
    const side = szi > 0 ? "LONG" : "SHORT";

    out.push({
      coin,
      side,
      size: szi,
      entryPx,
      markPx: mark,
      notional,
      upnl: unrealizedPnl,
      lev,
    });
  }
  return out;
}

function renderWatchPanel(){
  const empty = qs("watchEmpty");
  const cards = qs("walletCards");
  const posTable = qs("posTable");
  const watchMeta = qs("watchMeta");

  const wallets = Array.from(state.selected);
  if (!wallets.length){
    empty.classList.remove("hidden");
    cards.innerHTML = "";
    posTable.innerHTML = "";
    watchMeta.textContent = "";
    return;
  }

  empty.classList.add("hidden");

  const last = state.live.lastTs ? new Date(state.live.lastTs).toLocaleTimeString() : "—";
  watchMeta.textContent = `(selected ${wallets.length}, last update ${last})`;

  // Cards per wallet
  cards.innerHTML = wallets.map(w => {
    const st = state.live.states.get(w);
    const msx = extractMarginSummary(st);
    const short = w.slice(0,6) + "…" + w.slice(-4);

    const badge = Number.isFinite(msx.withdrawable) && msx.withdrawable > 0
      ? `<span class="badge ok">withdrawable</span>`
      : `<span class="badge">watching</span>`;

    // show a small “raw keys” tooltip for debug
    const rawKeys = msx.ms ? Object.keys(msx.ms).slice(0,14).join(", ") : "";

    return `
      <div class="card">
        <div class="card-head">
          <div class="card-title">
            <span class="mono" title="${esc(w)}">${esc(short)}</span>
            ${badge}
            <span class="muted small" title="${esc(rawKeys)}">${msx.ms ? "marginSummary ✓" : "marginSummary ?"} </span>
          </div>
          <div class="panel-actions">
            <button class="btn btn-ghost btn-unwatch" data-wallet="${esc(w)}">Remove</button>
          </div>
        </div>
        <div class="card-body">
          <div class="kv">
            <div>
              <div class="k">Account value</div>
              <div class="v">${esc(fmtUSD(msx.accountValue))}</div>
            </div>
            <div>
              <div class="k">Notional</div>
              <div class="v">${esc(fmtUSD(msx.totalNtlPos))}</div>
            </div>
            <div>
              <div class="k">Margin used</div>
              <div class="v">${esc(fmtUSD(msx.marginUsed))}</div>
            </div>
            <div>
              <div class="k">Withdrawable</div>
              <div class="v">${esc(fmtUSD(msx.withdrawable))}</div>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join("");

  // remove buttons
  cards.querySelectorAll(".btn-unwatch").forEach(btn => {
    btn.addEventListener("click", () => {
      const w = btn.getAttribute("data-wallet");
      if (!w) return;
      state.selected.delete(w);
      persistSelected();
      syncSelectedRowStyles();
      onSelectionChanged();
    });
  });

  // Positions combined table
  const mids = state.live.mids || {};
  let posRows = [];
  for (const w of wallets){
    const st = state.live.states.get(w);
    const ps = extractPositions(st, mids).map(p => ({ wallet: w, ...p }));
    posRows.push(...ps);
  }

  // filter positions search
  const q = state.posSearch.trim().toLowerCase();
  if (q){
    posRows = posRows.filter(r => {
      const w = r.wallet.toLowerCase();
      if (w.includes(q)) return true;
      if ((r.coin || "").toLowerCase().includes(q)) return true;
      if ((r.side || "").toLowerCase().includes(q)) return true;
      return false;
    });
  }

  // sort positions: default by notional desc
  posRows.sort((a,b)=> (toNum(b.notional) - toNum(a.notional)));

  // render
  const head = `
    <thead>
      <tr>
        <th>Wallet</th>
        <th>Coin</th>
        <th>Side</th>
        <th>Size</th>
        <th>Entry</th>
        <th>Mark</th>
        <th>Notional</th>
        <th>uPnL</th>
        <th>Lev</th>
      </tr>
    </thead>
  `;

  const body = `
    <tbody>
      ${posRows.map(r => {
        const short = r.wallet.slice(0,6) + "…" + r.wallet.slice(-4);
        const upnl = toNum(r.upnl);
        const upBadge = Number.isFinite(upnl)
          ? (upnl >= 0 ? `<span class="badge ok">+${fmtCompact(upnl,2)}</span>` : `<span class="badge bad">${fmtCompact(upnl,2)}</span>`)
          : `<span class="muted">—</span>`;
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
            <td class="mono">${esc(Number.isFinite(toNum(r.lev)) ? fmtCompact(toNum(r.lev),2) : "—")}</td>
          </tr>
        `;
      }).join("")}
    </tbody>
  `;

  posTable.innerHTML = head + body;
}

// ---------- layout: splitter + collapse ----------
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

  // restore
  const saved = toNum(localStorage.getItem("ws_leftW"));
  if (Number.isFinite(saved)) document.documentElement.style.setProperty("--leftW", `${clamp(saved, 24, 78)}%`);
}

function togglePanel(panelId){
  const el = qs(panelId);
  el.classList.toggle("hidden");
}

function focusPositions(){
  const rank = qs("rankPanel");
  const splitter = qs("splitter");
  const hidden = rank.classList.toggle("hidden");
  splitter.classList.toggle("hidden", hidden);
  // if we hid rankings, set left width small; if show back, restore
  if (hidden){
    document.documentElement.style.setProperty("--leftW", "0%");
  }else{
    const saved = toNum(localStorage.getItem("ws_leftW"));
    document.documentElement.style.setProperty("--leftW", `${Number.isFinite(saved) ? clamp(saved,24,78) : 58}%`);
  }
}

// ---------- selection change -> start polling ----------
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
  state.live.timer = setInterval(async () => {
    try { await updateLive(); } catch(err){ console.error(err); }
  }, sec * 1000);
}

async function onSelectionChanged(){
  // refresh live immediately when selection changes
  try{
    await updateLive();
  }catch(err){
    console.error(err);
  }
}

// ---------- init ----------
async function loadDatasetById(id){
  const ds = state.datasets.find(d => d.id === id) || state.datasets[0];
  if (!ds) throw new Error("No dataset found");
  state.datasetId = ds.id;

  const data = await fetchJson(ds.file);
  state.rawData = data;

  const { meta, rows } = normalizeDatasetData(data);

  // flatten rows + add __wallet and __rank
  state.rows = rows.map((r, i) => {
    const flat = flatten(r);
    const wallet = tryAddress(flat);
    flat.__wallet = wallet;
    flat.__rank = r.rank ?? r.__rank ?? (i + 1);
    return flat;
  }).filter(r => r.__wallet); // keep only rows with wallet

  state.columns = inferColumns(state.rows);

  // restore visible columns per dataset
  state.visibleCols = loadVisibleColsFromStorage(state.datasetId, state.columns);

  // meta display
  const metaParts = [];
  if (meta?.generatedAt) metaParts.push(`updated ${new Date(meta.generatedAt).toLocaleString()}`);
  if (meta?.count) metaParts.push(`count ${meta.count}`);
  qs("rankMeta").textContent = metaParts.length ? `(${metaParts.join(" • ")})` : "";

  // keep selection persisted
  syncSelectedRowStyles();
  renderRankTable();
}

function fillDatasetSelect(){
  const sel = qs("datasetSelect");
  sel.innerHTML = state.datasets.map(d => `<option value="${esc(d.id)}">${esc(d.title)}</option>`).join("");

  // restore last dataset
  const last = localStorage.getItem("ws_datasetId");
  const pick = (last && state.datasets.some(d => d.id === last)) ? last : state.datasets[0]?.id;
  if (pick){
    sel.value = pick;
    state.datasetId = pick;
  }
}

function bindUI(){
  qs("rankSearch").addEventListener("input", (e) => {
    state.search = e.target.value || "";
    renderRankTable();
  });

  qs("datasetSelect").addEventListener("change", async (e) => {
    const id = e.target.value;
    localStorage.setItem("ws_datasetId", id);
    try{
      await loadDatasetById(id);
    }catch(err){
      console.error(err);
      alert(`Failed to load dataset: ${id}\n\n${err.message}`);
    }
  });

  qs("btnRefresh").addEventListener("click", async () => {
    try{
      await loadDatasetById(qs("datasetSelect").value);
      await updateLive();
    }catch(err){
      console.error(err);
      alert(`Refresh failed.\n\n${err.message}`);
    }
  });

  qs("btnRefreshLive").addEventListener("click", async () => {
    try{ await updateLive(); } catch(err){ console.error(err); alert(err.message); }
  });

  qs("pollInterval").addEventListener("change", (e) => {
    state.live.intervalSec = toNum(e.target.value);
    localStorage.setItem("ws_poll", String(state.live.intervalSec));
    startPolling();
  });

  qs("posSearch").addEventListener("input", (e) => {
    state.posSearch = e.target.value || "";
    renderWatchPanel();
  });

  qs("btnClearSelection").addEventListener("click", () => {
    state.selected.clear();
    persistSelected();
    syncSelectedRowStyles();
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

  qs("btnCollapseRank").addEventListener("click", () => togglePanel("rankPanel"));
  qs("btnCollapseWatch").addEventListener("click", () => qs("watchBody").classList.toggle("hidden"));
  qs("btnFocus").addEventListener("click", focusPositions);
}

async function init(){
  loadSelected();

  // restore poll interval
  const savedPoll = toNum(localStorage.getItem("ws_poll"));
  if (Number.isFinite(savedPoll)){
    state.live.intervalSec = savedPoll;
    qs("pollInterval").value = String(savedPoll);
  }else{
    state.live.intervalSec = toNum(qs("pollInterval").value);
  }

  initSplitter();
  bindUI();

  await loadManifest();
  fillDatasetSelect();
  await loadDatasetById(qs("datasetSelect").value);

  // initial live update + polling
  try{ await updateLive(); }catch(err){ console.error(err); }
  startPolling();
}

document.addEventListener("DOMContentLoaded", init);
