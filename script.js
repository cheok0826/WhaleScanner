"use strict";

/**
 * WhaleScanner Dashboard
 * - Loads /data/*.json from GitHub repo (via contents API)
 * - Extracts ranking tables from JSON (rankings.* OR any array-of-objects)
 * - Renders interactive table: search + sort + pagination
 * - Watchlist: poll Hyperliquid info endpoint (clearinghouseState) for selected addresses
 */

const state = {
  owner: null,
  repo: null,
  branch: "main",

  dataFiles: [],          // [{name, download_url, size, sha}, ...]
  datasetName: null,
  datasetJson: null,

  tables: new Map(),      // methodName -> rows[]
  methodName: null,

  sortKey: null,
  sortDir: "desc",        // asc | desc
  search: "",
  pageSize: 50,
  page: 1,

  selectedAddresses: new Set(),   // watched
  watchRunning: false,
  watchTimer: null,
  lastAllMids: null,
  lastAllMidsAt: 0,
};

const els = {};
const LS_KEY = "whalescanner_ui_v2";

document.addEventListener("DOMContentLoaded", () => {
  bindEls();
  restoreLocalState();
  init().catch(err => {
    console.error(err);
    setMeta(`Error: ${err.message || err}`);
  });
});

function bindEls() {
  els.datasetSelect = document.getElementById("datasetSelect");
  els.reloadBtn = document.getElementById("reloadBtn");
  els.datasetMeta = document.getElementById("datasetMeta");

  els.methodTabs = document.getElementById("methodTabs");
  els.tableWrap = document.getElementById("tableWrap");
  els.tableFooter = document.getElementById("tableFooter");

  els.tableSearch = document.getElementById("tableSearch");
  els.pageSize = document.getElementById("pageSize");

  els.pollInterval = document.getElementById("pollInterval");
  els.watchToggleBtn = document.getElementById("watchToggleBtn");
  els.watchStatus = document.getElementById("watchStatus");
  els.watchlist = document.getElementById("watchlist");

  els.manualAddress = document.getElementById("manualAddress");
  els.addAddressBtn = document.getElementById("addAddressBtn");

  els.reloadBtn.addEventListener("click", () => init(true));

  els.datasetSelect.addEventListener("change", () => {
    state.datasetName = els.datasetSelect.value;
    state.methodName = null;
    state.page = 1;
    persistLocalState();
    loadDatasetAndRender().catch(console.error);
  });

  els.tableSearch.addEventListener("input", () => {
    state.search = els.tableSearch.value.trim();
    state.page = 1;
    persistLocalState();
    renderTable();
  });

  els.pageSize.addEventListener("change", () => {
    state.pageSize = parseInt(els.pageSize.value, 10);
    state.page = 1;
    persistLocalState();
    renderTable();
  });

  els.watchToggleBtn.addEventListener("click", () => {
    state.watchRunning ? stopWatch() : startWatch();
  });

  els.addAddressBtn.addEventListener("click", () => {
    const addr = (els.manualAddress.value || "").trim();
    if (!addr) return;
    const norm = normalizeAddress(addr);
    if (!norm) return toast("Invalid address.");
    state.selectedAddresses.add(norm);
    els.manualAddress.value = "";
    persistLocalState();
    renderTable();     // update checkboxes if address exists in table
    renderWatchlist(); // show card
  });
}

async function init(force = false) {
  detectRepoFromLocation();
  setMeta(`Repo: ${state.owner}/${state.repo} · loading datasets…`);

  await loadDataFiles(force);

  // Pick dataset
  if (!state.datasetName || !state.dataFiles.some(f => f.name === state.datasetName)) {
    // default: latest-ish by name or first json
    const preferred = state.dataFiles.find(f => /latest/i.test(f.name)) || state.dataFiles[0];
    state.datasetName = preferred ? preferred.name : null;
  }

  populateDatasetSelect();

  if (!state.datasetName) {
    setMeta("No JSON files found in /data.");
    els.tableWrap.innerHTML = `<div class="empty">Put your action output JSON files into <code>/data</code> (committed), then reload.</div>`;
    return;
  }

  await loadDatasetAndRender();
}

function detectRepoFromLocation() {
  // GitHub Pages pattern: https://{owner}.github.io/{repo}/
  const host = window.location.hostname;
  const path = window.location.pathname.replace(/^\/+/, "");
  if (host.endsWith("github.io")) {
    const owner = host.split(".")[0];
    const repo = path.split("/")[0] || "";
    state.owner = owner;
    state.repo = repo || "WhaleScanner";
    return;
  }

  // fallback: hardcode (your repo)
  state.owner = "cheok0826";
  state.repo = "WhaleScanner";
}

async function loadDataFiles(force = false) {
  if (state.dataFiles.length && !force) return;

  const url = `https://api.github.com/repos/${state.owner}/${state.repo}/contents/data?ref=${encodeURIComponent(state.branch)}`;
  const items = await fetchJson(url, { cache: force ? "no-store" : "default" });

  const files = (Array.isArray(items) ? items : [])
    .filter(x => x && x.type === "file" && typeof x.name === "string" && x.name.toLowerCase().endsWith(".json"))
    .map(x => ({
      name: x.name,
      download_url: x.download_url,
      size: x.size,
      sha: x.sha,
    }))
    // keep stable order (latest-ish first if name suggests it)
    .sort((a, b) => {
      const al = /latest/i.test(a.name) ? 0 : 1;
      const bl = /latest/i.test(b.name) ? 0 : 1;
      if (al !== bl) return al - bl;
      return a.name.localeCompare(b.name);
    });

  state.dataFiles = files;
}

function populateDatasetSelect() {
  els.datasetSelect.innerHTML = "";
  for (const f of state.dataFiles) {
    const opt = document.createElement("option");
    opt.value = f.name;
    opt.textContent = `${f.name} (${formatBytes(f.size)})`;
    if (f.name === state.datasetName) opt.selected = true;
    els.datasetSelect.appendChild(opt);
  }
}

async function loadDatasetAndRender() {
  const file = state.dataFiles.find(f => f.name === state.datasetName);
  if (!file) return;

  setMeta(`Loading ${file.name}…`);

  // Prefer same-origin first (GitHub Pages): ./data/<file>
  let json = null;
  try {
    json = await fetchJson(`./data/${encodeURIComponent(file.name)}`, { cache: "no-store" });
  } catch (e) {
    // fallback to raw download_url
    json = await fetchJson(file.download_url, { cache: "no-store" });
  }

  state.datasetJson = json;
  const { tables, meta } = extractTables(json);
  state.tables = tables;

  const methodNames = [...tables.keys()];
  if (!methodNames.length) {
    setMeta(`Loaded ${file.name} · no ranking arrays found`);
    els.methodTabs.innerHTML = "";
    els.tableWrap.innerHTML = `<div class="empty">No array-of-objects found in this JSON. If your JSON has <code>rankings</code> arrays, they will appear here.</div>`;
    els.tableFooter.innerHTML = "";
    return;
  }

  if (!state.methodName || !tables.has(state.methodName)) {
    state.methodName = methodNames[0];
  }

  renderMethodTabs(methodNames);

  // Show meta
  const metaParts = [];
  if (meta.generatedAt) metaParts.push(`generated: ${meta.generatedAt}`);
  metaParts.push(`methods: ${methodNames.length}`);
  setMeta(`Loaded ${file.name} · ${metaParts.join(" · ")}`);

  persistLocalState();
  renderTable();
  renderWatchlist();
}

function renderMethodTabs(methodNames) {
  els.methodTabs.innerHTML = "";
  for (const name of methodNames) {
    const btn = document.createElement("button");
    btn.className = "tab" + (name === state.methodName ? " tab--active" : "");
    btn.textContent = name;
    btn.addEventListener("click", () => {
      state.methodName = name;
      state.page = 1;
      persistLocalState();
      renderMethodTabs(methodNames);
      renderTable();
    });
    els.methodTabs.appendChild(btn);
  }
}

function renderTable() {
  const rows = state.tables.get(state.methodName) || [];
  const prepared = rows.map((r, i) => prepareRow(r, i));

  // Filter by search
  const q = (state.search || "").toLowerCase();
  const filtered = q
    ? prepared.filter(r => rowToSearchText(r).includes(q))
    : prepared;

  // Determine columns
  const columns = inferColumns(filtered);

  // Default sort: rank desc? Usually rank asc.
  if (!state.sortKey) {
    state.sortKey = columns.find(c => c.key === "rank") ? "rank" : columns.find(c => c.key === "score") ? "score" : columns[0]?.key;
    state.sortDir = state.sortKey === "rank" ? "asc" : "desc";
  }

  // Sort
  const sorted = [...filtered].sort((a, b) => compareForSort(a, b, state.sortKey, state.sortDir));

  // Pagination
  const pageSize = state.pageSize || 50;
  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  state.page = Math.min(state.page, totalPages);

  const start = (state.page - 1) * pageSize;
  const pageRows = sorted.slice(start, start + pageSize);

  // Render
  els.tableWrap.innerHTML = "";
  const table = document.createElement("table");
  table.className = "dataTable";

  // Header
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");

  for (const col of columns) {
    const th = document.createElement("th");
    th.title = "Click to sort";
    th.className = "sortable" + (col.key === state.sortKey ? " sorted" : "");

    th.innerHTML = `<span>${escapeHtml(col.label)}</span>
      <span class="sortIcon">${col.key === state.sortKey ? (state.sortDir === "asc" ? "▲" : "▼") : ""}</span>`;

    th.addEventListener("click", () => {
      if (state.sortKey === col.key) {
        state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      } else {
        state.sortKey = col.key;
        state.sortDir = col.key === "rank" ? "asc" : "desc";
      }
      persistLocalState();
      renderTable();
    });

    hr.appendChild(th);
  }

  thead.appendChild(hr);
  table.appendChild(thead);

  // Body
  const tbody = document.createElement("tbody");

  for (const r of pageRows) {
    const tr = document.createElement("tr");

    for (const col of columns) {
      const td = document.createElement("td");

      if (col.key === "__watch") {
        const addr = r.__address;
        const checked = addr && state.selectedAddresses.has(addr);
        td.className = "watchCell";
        td.innerHTML = `
          <label class="chk">
            <input type="checkbox" ${checked ? "checked" : ""} ${addr ? "" : "disabled"}>
            <span></span>
          </label>
        `;
        const input = td.querySelector("input");
        input?.addEventListener("change", (e) => {
          if (!addr) return;
          if (e.target.checked) state.selectedAddresses.add(addr);
          else state.selectedAddresses.delete(addr);
          persistLocalState();
          renderWatchlist();
        });
      } else if (col.key === "address") {
        const addr = r.__address || "";
        td.innerHTML = addr
          ? `<a class="addr" href="https://app.hyperliquid.xyz/explorer/address/${addr}" target="_blank" rel="noreferrer">${shortAddr(addr)}</a>`
          : `<span class="muted">—</span>`;
      } else {
        td.innerHTML = formatCell(r[col.key]);
      }

      tr.appendChild(td);
    }

    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  els.tableWrap.appendChild(table);

  // Footer / pager
  els.tableFooter.innerHTML = renderPager(total, totalPages);

  // pager handlers
  els.tableFooter.querySelectorAll("[data-page]").forEach(btn => {
    btn.addEventListener("click", () => {
      const p = parseInt(btn.getAttribute("data-page"), 10);
      if (!Number.isFinite(p)) return;
      state.page = p;
      persistLocalState();
      renderTable();
    });
  });
}

function renderPager(total, totalPages) {
  const cur = state.page;
  const from = total ? ((cur - 1) * state.pageSize + 1) : 0;
  const to = Math.min(total, cur * state.pageSize);

  const mkBtn = (p, label, disabled = false) =>
    `<button class="btn btn--sm" data-page="${p}" ${disabled ? "disabled" : ""}>${label}</button>`;

  const btns = [];
  btns.push(mkBtn(1, "⟪", cur === 1));
  btns.push(mkBtn(Math.max(1, cur - 1), "‹", cur === 1));

  // window pages
  const windowSize = 3;
  const start = Math.max(1, cur - windowSize);
  const end = Math.min(totalPages, cur + windowSize);
  for (let p = start; p <= end; p++) {
    btns.push(`<button class="btn btn--sm ${p === cur ? "btn--active" : ""}" data-page="${p}">${p}</button>`);
  }

  btns.push(mkBtn(Math.min(totalPages, cur + 1), "›", cur === totalPages));
  btns.push(mkBtn(totalPages, "⟫", cur === totalPages));

  return `
    <div class="pager">
      <div class="pager__left">
        Showing <b>${from}</b>–<b>${to}</b> of <b>${total}</b>
      </div>
      <div class="pager__right">
        ${btns.join("")}
      </div>
    </div>
  `;
}

/* ---------------------------
 * Watchlist
 * --------------------------- */

function startWatch() {
  if (state.watchRunning) return;
  state.watchRunning = true;
  els.watchToggleBtn.textContent = "Stop";
  els.watchToggleBtn.classList.add("btn--danger");

  tickWatchNow();
  const sec = Math.max(5, parseInt(els.pollInterval.value, 10) || 20);
  state.watchTimer = setInterval(tickWatchNow, sec * 1000);
  persistLocalState();
}

function stopWatch() {
  state.watchRunning = false;
  els.watchToggleBtn.textContent = "Start";
  els.watchToggleBtn.classList.remove("btn--danger");
  if (state.watchTimer) clearInterval(state.watchTimer);
  state.watchTimer = null;
  els.watchStatus.textContent = "Not running.";
  persistLocalState();
}

async function tickWatchNow() {
  const addrs = [...state.selectedAddresses];
  if (!addrs.length) {
    els.watchStatus.textContent = "No watched addresses.";
    return;
  }

  els.watchStatus.textContent = `Updating ${addrs.length} address(es)…`;

  // Refresh allMids occasionally (mark prices)
  try {
    if (!state.lastAllMids || (Date.now() - state.lastAllMidsAt) > 20_000) {
      state.lastAllMids = await hlInfo({ type: "allMids" });
      state.lastAllMidsAt = Date.now();
    }
  } catch (e) {
    // still proceed; we can render without mark
  }

  // Concurrency limit
  const limit = 3;
  const results = new Map();

  for (let i = 0; i < addrs.length; i += limit) {
    const chunk = addrs.slice(i, i + limit);
    const chunkRes = await Promise.all(chunk.map(async (a) => {
      try {
        const cs = await hlInfo({ type: "clearinghouseState", user: a });
        return [a, { ok: true, data: cs }];
      } catch (e) {
        return [a, { ok: false, error: e.message || String(e) }];
      }
    }));
    for (const [a, r] of chunkRes) results.set(a, r);
  }

  // Render watch cards
  renderWatchlist(results);

  const okCount = [...results.values()].filter(x => x.ok).length;
  els.watchStatus.textContent = `Updated ${okCount}/${addrs.length} · ${new Date().toLocaleTimeString()}`;
}

function renderWatchlist(liveMap = null) {
  const addrs = [...state.selectedAddresses];

  if (!addrs.length) {
    els.watchlist.innerHTML = `<div class="empty">No addresses selected.</div>`;
    return;
  }

  // Keep existing cards; update if liveMap present
  const cards = addrs.map(addr => {
    const live = liveMap?.get(addr);
    if (!live) {
      return `
        <div class="card">
          <div class="card__head">
            <div class="card__title">
              <a href="https://app.hyperliquid.xyz/explorer/address/${addr}" target="_blank" rel="noreferrer">${shortAddr(addr)}</a>
            </div>
            <button class="iconBtn" data-unwatch="${addr}" title="Remove">✕</button>
          </div>
          <div class="card__body muted">Waiting for update…</div>
        </div>
      `;
    }

    if (!live.ok) {
      return `
        <div class="card">
          <div class="card__head">
            <div class="card__title">
              <a href="https://app.hyperliquid.xyz/explorer/address/${addr}" target="_blank" rel="noreferrer">${shortAddr(addr)}</a>
            </div>
            <button class="iconBtn" data-unwatch="${addr}" title="Remove">✕</button>
          </div>
          <div class="card__body">
            <div class="badge badge--bad">Error</div>
            <div class="muted">${escapeHtml(live.error)}</div>
          </div>
        </div>
      `;
    }

    return renderWatchCard(addr, live.data);
  });

  els.watchlist.innerHTML = cards.join("");

  els.watchlist.querySelectorAll("[data-unwatch]").forEach(btn => {
    btn.addEventListener("click", () => {
      const addr = btn.getAttribute("data-unwatch");
      if (!addr) return;
      state.selectedAddresses.delete(addr);
      persistLocalState();
      renderTable();
      renderWatchlist();
      if (state.watchRunning && state.selectedAddresses.size === 0) stopWatch();
    });
  });
}

function renderWatchCard(addr, cs) {
  const ms = pickTimeMs(cs?.time);
  const when = ms ? new Date(ms).toLocaleString() : "—";

  const msu = cs?.marginSummary || {};
  const withdrawable = cs?.withdrawable;

  const summary = [
    ["Account", fmtNum(msu.accountValue)],
    ["Notional", fmtNum(msu.totalNtlPos)],
    ["Margin Used", fmtNum(msu.totalMarginUsed)],
    ["Withdrawable", fmtNum(withdrawable)],
    ["Updated", when],
  ];

  const positions = Array.isArray(cs?.assetPositions) ? cs.assetPositions : [];
  const posRows = positions
    .map(p => p?.position)
    .filter(Boolean)
    .filter(p => toNum(p.szi) !== 0);

  const mids = state.lastAllMids || {};

  const posTable = posRows.length
    ? `
      <table class="miniTable">
        <thead>
          <tr>
            <th>Coin</th>
            <th>Side</th>
            <th class="num">Size</th>
            <th class="num">Entry</th>
            <th class="num">Mark</th>
            <th class="num">uPnL</th>
            <th class="num">ROE</th>
            <th class="num">Liq</th>
            <th class="num">Lev</th>
          </tr>
        </thead>
        <tbody>
          ${posRows.map(p => {
            const coin = p.coin || "—";
            const szi = toNum(p.szi);
            const side = szi > 0 ? `<span class="badge badge--good">LONG</span>` : `<span class="badge badge--bad">SHORT</span>`;
            const entry = toNum(p.entryPx);
            const mark = toNum(mids[coin]); // allMids returns strings keyed by coin
            const upnl = toNum(p.unrealizedPnl);
            const roe = toNum(p.returnOnEquity);
            const liq = toNum(p.liquidationPx);
            const lev = p?.leverage?.value ?? p?.leverage?.rawUsd ?? "";

            return `
              <tr>
                <td>${escapeHtml(coin)}</td>
                <td>${side}</td>
                <td class="num">${fmtNum(szi)}</td>
                <td class="num">${fmtNum(entry)}</td>
                <td class="num">${mark ? fmtNum(mark) : `<span class="muted">—</span>`}</td>
                <td class="num">${fmtSigned(upnl)}</td>
                <td class="num">${roe ? fmtPct(roe) : `<span class="muted">—</span>`}</td>
                <td class="num">${liq ? fmtNum(liq) : `<span class="muted">—</span>`}</td>
                <td class="num">${escapeHtml(String(lev || "—"))}</td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    `
    : `<div class="muted">No open positions.</div>`;

  return `
    <div class="card">
      <div class="card__head">
        <div class="card__title">
          <a href="https://app.hyperliquid.xyz/explorer/address/${addr}" target="_blank" rel="noreferrer">${shortAddr(addr)}</a>
        </div>
        <button class="iconBtn" data-unwatch="${addr}" title="Remove">✕</button>
      </div>

      <div class="card__body">
        <div class="kv">
          ${summary.map(([k, v]) => `
            <div class="kv__row">
              <div class="kv__k">${escapeHtml(k)}</div>
              <div class="kv__v">${v}</div>
            </div>
          `).join("")}
        </div>

        <div class="divider"></div>

        ${posTable}
      </div>
    </div>
  `;
}

/* ---------------------------
 * JSON -> tables extraction
 * --------------------------- */

function extractTables(json) {
  const tables = new Map();
  const meta = {
    generatedAt: pickGeneratedAt(json),
  };

  if (Array.isArray(json)) {
    tables.set("default", json.filter(x => x && typeof x === "object"));
    return { tables, meta };
  }

  if (!json || typeof json !== "object") {
    return { tables, meta };
  }

  // Common: { rankings: { risk: [...], pnl: [...] } }
  if (json.rankings && typeof json.rankings === "object") {
    for (const [k, v] of Object.entries(json.rankings)) {
      if (Array.isArray(v) && v.length && typeof v[0] === "object") tables.set(k, v);
    }
  }

  // If empty, find any arrays-of-objects (depth-limited)
  if (!tables.size) {
    const found = [];
    findArrayTables(json, "", 0, 4, found);
    // Heuristic: prefer ones that look like ranking rows (have address/user/wallet)
    const scored = found
      .map(x => ({ ...x, score: scoreTableRows(x.rows) }))
      .sort((a, b) => b.score - a.score);

    for (const t of scored) {
      tables.set(t.name, t.rows);
      if (tables.size >= 12) break; // keep UI sane
    }
  }

  return { tables, meta };
}

function findArrayTables(obj, path, depth, maxDepth, out) {
  if (!obj || typeof obj !== "object" || depth > maxDepth) return;

  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k;

    if (Array.isArray(v) && v.length && v.every(x => x && typeof x === "object" && !Array.isArray(x))) {
      out.push({ name: p, rows: v });
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      findArrayTables(v, p, depth + 1, maxDepth, out);
    }
  }
}

function scoreTableRows(rows) {
  // higher if many rows contain address-like keys
  let score = 0;
  const keys = new Set();
  for (const r of rows.slice(0, 20)) {
    for (const k of Object.keys(r)) keys.add(k);
    const a = guessAddressFromRow(r);
    if (a) score += 3;
  }
  // bonus for rank/score presence
  if (hasKey(keys, ["rank", "score", "risk", "pnl", "accountValue", "account_value"])) score += 2;
  return score + Math.min(rows.length / 10, 5);
}

/* ---------------------------
 * Table helpers
 * --------------------------- */

function prepareRow(row, i) {
  const r = { ...row };

  // watch column
  r.__watch = "";

  // address detection
  const addr = guessAddressFromRow(r);
  if (addr) r.__address = addr;

  // Ensure rank exists (fallback to index+1)
  if (r.rank == null) r.rank = (i + 1);

  return r;
}

function inferColumns(rows) {
  // Always start with watch checkbox, rank, address if possible
  const keys = new Set();
  for (const r of rows.slice(0, 100)) {
    for (const k of Object.keys(r)) {
      if (k.startsWith("__")) continue;
      keys.add(k);
    }
  }

  const keyList = [...keys];

  const addrKey = keyList.find(k => k.toLowerCase() === "address") || null;
  const hasAddr = rows.some(r => !!r.__address) || !!addrKey;

  // Priority ordering
  const priority = [
    "__watch",
    "rank",
    hasAddr ? "address" : null,
    "score",
    "risk_score",
    "risk",
    "pnl_pct",
    "pnl",
    "growth_pct",
    "accountValue",
    "account_value",
    "totalValue",
    "value",
    "inactive_days",
    "active_days",
    "last_trade",
    "lastTrade",
  ].filter(Boolean);

  // Remaining keys (excluding internals and any address/user/wallet keys since we map to "address")
  const addrLike = new Set(["address", "user", "wallet", "wallet_address", "addr"]);
  const rest = keyList
    .filter(k => !priority.includes(k) && !addrLike.has(k.toLowerCase()))
    .sort((a, b) => a.localeCompare(b));

  const finalKeys = [...priority, ...rest].slice(0, 16); // cap columns for readability

  const cols = [];
  for (const k of finalKeys) {
    if (k === "address") {
      cols.push({ key: "address", label: "Address" });
    } else if (k === "__watch") {
      cols.push({ key: "__watch", label: "" });
    } else {
      cols.push({ key: k, label: prettifyKey(k) });
    }
  }

  // If we didn't include "address" but we have __address, inject it after rank
  if (!cols.some(c => c.key === "address") && hasAddr) {
    const idx = cols.findIndex(c => c.key === "rank");
    cols.splice(Math.max(0, idx + 1), 0, { key: "address", label: "Address" });
  }

  return cols;
}

function rowToSearchText(r) {
  const parts = [];
  if (r.__address) parts.push(r.__address);
  for (const [k, v] of Object.entries(r)) {
    if (k.startsWith("__")) continue;
    if (v == null) continue;
    parts.push(String(v));
  }
  return parts.join(" ").toLowerCase();
}

function compareForSort(a, b, key, dir) {
  const av = a[key];
  const bv = b[key];

  const an = toNum(av);
  const bn = toNum(bv);

  let cmp = 0;

  // numeric if both parse
  if (Number.isFinite(an) && Number.isFinite(bn)) {
    cmp = an - bn;
  } else {
    cmp = String(av ?? "").localeCompare(String(bv ?? ""), undefined, { numeric: true, sensitivity: "base" });
  }

  return dir === "asc" ? cmp : -cmp;
}

/* ---------------------------
 * Hyperliquid API
 * --------------------------- */

async function hlInfo(body) {
  // Info endpoint is POST https://api.hyperliquid.xyz/info with type-based schemas :contentReference[oaicite:3]{index=3}
  const res = await fetchJsonWithTimeout("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, 12_000);

  return res;
}

/* ---------------------------
 * Utils
 * --------------------------- */

async function fetchJson(url, init = {}) {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

async function fetchJsonWithTimeout(url, init = {}, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    return r.json();
  } finally {
    clearTimeout(t);
  }
}

function setMeta(text) {
  els.datasetMeta.textContent = text;
}

function persistLocalState() {
  const obj = {
    datasetName: state.datasetName,
    methodName: state.methodName,
    search: state.search,
    pageSize: state.pageSize,
    selectedAddresses: [...state.selectedAddresses],
    pollSec: parseInt(els.pollInterval?.value, 10) || 20,
    watchRunning: state.watchRunning,
    sortKey: state.sortKey,
    sortDir: state.sortDir,
  };
  try { localStorage.setItem(LS_KEY, JSON.stringify(obj)); } catch {}
}

function restoreLocalState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);

    state.datasetName = obj.datasetName ?? state.datasetName;
    state.methodName = obj.methodName ?? state.methodName;
    state.search = obj.search ?? "";
    state.pageSize = obj.pageSize ?? 50;

    state.sortKey = obj.sortKey ?? null;
    state.sortDir = obj.sortDir ?? "desc";

    if (Array.isArray(obj.selectedAddresses)) {
      state.selectedAddresses = new Set(obj.selectedAddresses.map(normalizeAddress).filter(Boolean));
    }
    if (obj.pollSec && els.pollInterval) els.pollInterval.value = String(obj.pollSec);

    // set UI inputs if available later
    setTimeout(() => {
      if (els.tableSearch) els.tableSearch.value = state.search;
      if (els.pageSize) els.pageSize.value = String(state.pageSize);
    }, 0);

    // watch state restored later after init
    setTimeout(() => {
      if (obj.watchRunning) startWatch();
    }, 500);
  } catch {}
}

function guessAddressFromRow(r) {
  const candidates = [
    r.address, r.user, r.wallet, r.wallet_address, r.addr,
    r?.account, r?.owner,
  ].filter(Boolean);

  for (const c of candidates) {
    const a = normalizeAddress(String(c));
    if (a) return a;
  }

  // sometimes row contains "0x..." embedded
  for (const v of Object.values(r)) {
    if (typeof v !== "string") continue;
    const m = v.match(/0x[a-fA-F0-9]{40}/);
    if (m) return normalizeAddress(m[0]);
  }

  return null;
}

function normalizeAddress(s) {
  const m = String(s).trim().match(/^0x[a-fA-F0-9]{40}$/);
  return m ? m[0].toLowerCase() : null;
}

function shortAddr(addr) {
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

function prettifyKey(k) {
  return k
    .replace(/^_+/, "")
    .replace(/__/g, " ")
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatCell(v) {
  if (v == null) return `<span class="muted">—</span>`;

  // numbers or numeric strings
  const n = toNum(v);
  if (Number.isFinite(n)) {
    // heuristics: percent-ish keys already handled by caller sometimes; keep generic
    return fmtNum(n);
  }

  // booleans
  if (typeof v === "boolean") return v ? `<span class="badge badge--good">YES</span>` : `<span class="badge">NO</span>`;

  // objects
  if (typeof v === "object") return `<span class="muted">{…}</span>`;

  // string
  const s = String(v);
  if (/^0x[a-fA-F0-9]{40}$/.test(s)) {
    const a = normalizeAddress(s);
    return a
      ? `<a class="addr" href="https://app.hyperliquid.xyz/explorer/address/${a}" target="_blank" rel="noreferrer">${shortAddr(a)}</a>`
      : escapeHtml(s);
  }
  return escapeHtml(s);
}

function toNum(v) {
  if (v == null) return NaN;
  if (typeof v === "number") return v;
  const s = String(v).trim();
  if (!s) return NaN;
  // remove commas
  const cleaned = s.replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

function fmtNum(n) {
  if (!Number.isFinite(n)) return `<span class="muted">—</span>`;
  const abs = Math.abs(n);
  const decimals = abs >= 1000 ? 0 : abs >= 10 ? 2 : 4;
  return n.toLocaleString(undefined, { maximumFractionDigits: decimals });
}

function fmtSigned(n) {
  if (!Number.isFinite(n)) return `<span class="muted">—</span>`;
  const cls = n >= 0 ? "pos" : "neg";
  return `<span class="${cls}">${n >= 0 ? "+" : ""}${fmtNum(n)}</span>`;
}

function fmtPct(n) {
  if (!Number.isFinite(n)) return `<span class="muted">—</span>`;
  // returnOnEquity looks like decimal percent or already percent depending on API; display as % with 2 decimals
  const val = n;
  return `${val.toFixed(2)}%`;
}

function pickTimeMs(t) {
  const n = toNum(t);
  if (!Number.isFinite(n)) return null;
  // if it's seconds, convert
  return n > 1e12 ? n : n * 1000;
}

function pickGeneratedAt(json) {
  if (!json || typeof json !== "object") return null;
  const candidates = [
    json.generated_at, json.generatedAt, json.created_at, json.createdAt,
    json.time, json.timestamp,
  ].filter(Boolean);

  for (const c of candidates) {
    const ms = pickTimeMs(c);
    if (ms) return new Date(ms).toLocaleString();
    // if already ISO string
    if (typeof c === "string" && c.includes("T")) return c;
  }
  return null;
}

function hasKey(set, keys) {
  for (const k of keys) if (set.has(k)) return true;
  return false;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}

function toast(msg) {
  // lightweight: reuse datasetMeta area for now
  setMeta(msg);
  setTimeout(() => setMeta(""), 2500);
}
