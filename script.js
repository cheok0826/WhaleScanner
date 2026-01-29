(() => {
  // ----------------------------
  // Static snapshot JSON
  // ----------------------------
  const SNAPSHOT_URL = "data/latest.json";

  // ----------------------------
  // Live polling endpoints
  // ----------------------------
  const INFO_URL = "https://api.hyperliquid.xyz/info";

  // ----------------------------
  // Safety throttles
  // ----------------------------
  const DEFAULT_TIMEOUT_MS = 20000;
  const DEFAULT_RETRIES = 2;
  const BACKOFF_BASE_MS = 650;
  const MAX_BACKOFF_MS = 6000;
  const GLOBAL_THROTTLE_MS = 300; // ms between any API calls
  const LIVE_BATCH_SIZE = 10;     // only for selected wallets

  // ----------------------------
  // State
  // ----------------------------
  let snapshot = null;                 // last loaded JSON
  let walletsByAddr = new Map();       // address -> wallet object (snapshot + live fields)
  let visibleAddrs = [];               // current filtered/sorted addresses
  let midsCache = null;                // { coin: mid }
  let midsFetchedAt = 0;
  let liveTimer = null;
  let liveInFlight = false;

  // persisted user selections/settings
  const LS_KEY = "whalescanner.selected";
  const LS_SETTINGS = "whalescanner.settings";

  let selected = new Set(loadSelectedFromStorage()); // addresses
  let settings = loadSettings(); // { rankView, search, liveToggle, pollInterval }

  // ----------------------------
  // DOM
  // ----------------------------
  const $ = (id) => document.getElementById(id);

  function setStatus(msg, isError = false) {
    const el = $("status");
    if (!el) return;
    el.textContent = msg;
    el.style.borderColor = isError ? "#7a1b1b" : "#232a36";
  }

  function shortAddr(a) {
    if (!a || a.length < 12) return a || "";
    return `${a.slice(0, 6)}…${a.slice(-4)}`;
  }

  function fmtMoney(x) {
    const n = Number(x ?? 0);
    return "$" + n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // ----------------------------
  // LocalStorage
  // ----------------------------
  function loadSelectedFromStorage() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function saveSelectedToStorage() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify([...selected]));
    } catch {}
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(LS_SETTINGS);
      const s = raw ? JSON.parse(raw) : {};
      return {
        rankView: s.rankView || "risk",
        search: s.search || "",
        liveToggle: !!s.liveToggle,
        pollInterval: Number(s.pollInterval || 30),
      };
    } catch {
      return { rankView: "risk", search: "", liveToggle: false, pollInterval: 30 };
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
    } catch {}
  }

  // ----------------------------
  // Fetch helpers (retry + throttle)
  // ----------------------------
  let lastReqAt = 0;

  async function throttle() {
    const now = Date.now();
    const wait = Math.max(0, lastReqAt + GLOBAL_THROTTLE_MS - now);
    if (wait > 0) await sleep(wait);
    lastReqAt = Date.now();
  }

  async function backoffSleep(attempt) {
    const exp = Math.min(MAX_BACKOFF_MS, BACKOFF_BASE_MS * 2 ** attempt);
    const jitter = Math.floor(Math.random() * 250);
    await sleep(exp + jitter);
  }

  async function fetchJsonWithRetry(url, options, retries = DEFAULT_RETRIES, timeoutMs = DEFAULT_TIMEOUT_MS) {
    let lastErr = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      await throttle();

      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);

      try {
        const resp = await fetch(url, { ...options, signal: ac.signal });

        if ([429, 500, 502, 503, 504].includes(resp.status)) {
          const txt = await safeReadText(resp);
          lastErr = new Error(`HTTP ${resp.status} ${resp.statusText}: ${txt.slice(0, 200)}`);
          if (attempt < retries) {
            await backoffSleep(attempt);
            continue;
          }
          throw lastErr;
        }

        if (!resp.ok) {
          const txt = await safeReadText(resp);
          throw new Error(`HTTP ${resp.status} ${resp.statusText}: ${txt.slice(0, 300)}`);
        }

        return await resp.json();
      } catch (e) {
        lastErr = e;
        if (attempt < retries) {
          await backoffSleep(attempt);
          continue;
        }
        throw e;
      } finally {
        clearTimeout(t);
      }
    }

    throw lastErr || new Error("Unknown fetch error");
  }

  async function safeReadText(resp) {
    try { return await resp.text(); } catch { return ""; }
  }

  async function postInfo(payload, retries = DEFAULT_RETRIES) {
    return await fetchJsonWithRetry(
      INFO_URL,
      {
        method: "POST",
        mode: "cors",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      retries
    );
  }

  // ----------------------------
  // Snapshot loading
  // ----------------------------
  async function loadSnapshot() {
    setStatus("Loading snapshot…");

    const url = `${SNAPSHOT_URL}?t=${Date.now()}`; // cache-bust
    const data = await fetchJsonWithRetry(url, { method: "GET", cache: "no-store" }, 1);

    snapshot = data;
    walletsByAddr.clear();

    for (const w of (snapshot.wallets || [])) {
      const addr = (w.address || "").toLowerCase();
      if (!addr) continue;

      // attach live fields (will be updated by polling)
      walletsByAddr.set(addr, {
        ...w,
        address: addr,
        live: {
          account_value: null,
          positions: null,
          last_updated_utc: null,
        },
      });
    }

    // header stats
    if ($("lastUpdated")) $("lastUpdated").textContent = snapshot.scan_finished_at_utc || snapshot.generated_at_utc || "—";
    if ($("duration")) $("duration").textContent = snapshot.duration_seconds != null ? `${Number(snapshot.duration_seconds).toFixed(1)}s` : "—";
    if ($("walletCount")) $("walletCount").textContent = String((snapshot.wallets || []).length);
    if ($("modeRank")) $("modeRank").textContent = `${snapshot.mode || "—"} / default=${snapshot.rank_by_default || "—"}`;

    setStatus(`✅ Snapshot loaded: ${(snapshot.wallets || []).length} wallets.`);
    applyViewAndRender();
  }

  // ----------------------------
  // View (sort/filter)
  // ----------------------------
  function getRankKey() {
    return ($("rankView")?.value || settings.rankView || "risk");
  }

  function getSearchTerm() {
    return ($("searchBox")?.value || settings.search || "").trim().toLowerCase();
  }

  function applyViewAndRender() {
    const rankKey = getRankKey();
    const term = getSearchTerm();

    // build list
    let addrs = [];
    for (const [addr] of walletsByAddr.entries()) {
      if (term && !addr.includes(term)) continue;
      addrs.push(addr);
    }

    // sort by precomputed ranks if present, else by score
    addrs.sort((a, b) => {
      const wa = walletsByAddr.get(a);
      const wb = walletsByAddr.get(b);

      const ra = wa?.ranks?.[rankKey] ?? null;
      const rb = wb?.ranks?.[rankKey] ?? null;

      if (ra != null && rb != null) return ra - rb; // smaller rank = higher
      const sa = wa?.rank_scores?.[rankKey] ?? 0;
      const sb = wb?.rank_scores?.[rankKey] ?? 0;
      return sb - sa;
    });

    visibleAddrs = addrs;
    renderTable();
    updateSelectedCount();
  }

  // ----------------------------
  // Rendering
  // ----------------------------
  function updateSelectedCount() {
    if ($("selectedCount")) $("selectedCount").textContent = `Selected: ${selected.size}`;
  }

  function renderTable() {
    const tbody = document.querySelector("#resultTable tbody");
    if (!tbody) return;

    tbody.innerHTML = "";
    const rankKey = getRankKey();

    for (const addr of visibleAddrs) {
      const w = walletsByAddr.get(addr);
      if (!w) continue;

      const tr = document.createElement("tr");

      const checked = selected.has(addr);
      const snapshotRank = w.ranks?.[rankKey] ?? w.rank ?? "";
      const score = Number(w.rank_scores?.[rankKey] ?? 0).toFixed(2);

      const liveAv = w.live.account_value;
      const liveAvStr = liveAv != null ? fmtMoney(liveAv) : "—";

      const details = document.createElement("details");
      const summary = document.createElement("summary");
      const livePos = w.live.positions;
      const posForView = Array.isArray(livePos) ? livePos : (w.positions || []);
      summary.textContent = `${posForView.length} pos`;
      details.appendChild(summary);

      const ul = document.createElement("ul");
      for (const p of posForView) {
        const li = document.createElement("li");
        const sizeStr = (p.size ?? 0).toFixed(4);
        const entry = (p.entry_px ?? 0).toFixed(2);
        const liq = p.liquidation_px != null ? Number(p.liquidation_px).toFixed(2) : "–";
        const roe = p.roe_pct != null ? `${Number(p.roe_pct).toFixed(2)}%` : "–";
        const age = p.age_days != null ? `${Number(p.age_days).toFixed(1)}d` : "–";
        li.textContent = `${p.coin} ${p.side} ${sizeStr}@${entry} ROE:${roe} Age:${age} LiqPx:${liq}`;
        ul.appendChild(li);
      }
      details.appendChild(ul);

      tr.innerHTML = `
        <td><input type="checkbox" class="rowSelect" data-addr="${addr}" ${checked ? "checked" : ""}></td>
        <td>${snapshotRank}</td>
        <td title="${addr}">${shortAddr(addr)}</td>
        <td>${fmtMoney(w.account_value)}</td>
        <td>${liveAvStr}</td>
        <td>${score}</td>
        <td>${w.style || ""}</td>
      `;

      const tdPos = document.createElement("td");
      tdPos.appendChild(details);
      tr.appendChild(tdPos);

      tbody.appendChild(tr);
    }

    // wire row checkboxes
    tbody.querySelectorAll(".rowSelect").forEach((cb) => {
      cb.addEventListener("change", (e) => {
        const a = e.target.getAttribute("data-addr");
        if (!a) return;
        if (e.target.checked) selected.add(a);
        else selected.delete(a);
        saveSelectedToStorage();
        updateSelectedCount();
      });
    });
  }

  // ----------------------------
  // Live polling for selected wallets only
  // ----------------------------
  function chunkArray(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  function toFloat(x, def = 0.0) {
    const n = parseFloat(x);
    return Number.isFinite(n) ? n : def;
  }

  async function ensureMidsFresh() {
    // refresh mids every 5 minutes
    const now = Date.now();
    if (midsCache && (now - midsFetchedAt) < 5 * 60 * 1000) return;

    try {
      const data = await postInfo({ type: "allMids", dex: "" }, 1);
      const mids = {};
      if (data && typeof data === "object") {
        for (const [k, v] of Object.entries(data)) {
          if (typeof k === "string" && !k.startsWith("@")) mids[k] = toFloat(v, 0);
        }
      }
      midsCache = mids;
      midsFetchedAt = now;
    } catch {
      // keep old mids if exists
    }
  }

  function extractAccountValueFromState(state) {
    const ms = state?.marginSummary || {};
    return toFloat(ms.accountValue, 0.0);
  }

  function extractPositionsFromState(state, accountValue, mids) {
    const out = [];
    const aps = Array.isArray(state?.assetPositions) ? state.assetPositions : [];
    for (const ap of aps) {
      const pos = ap?.position || {};
      const szi = toFloat(pos.szi, 0);
      if (Math.abs(szi) < 1e-12) continue;

      const coin = String(pos.coin || "Unknown");
      const entry = toFloat(pos.entryPx, 0);
      const pv = toFloat(pos.positionValue, 0);
      const upnl = toFloat(pos.unrealizedPnl, 0);

      const roeRaw = pos.returnOnEquity;
      const roePct = (roeRaw != null) ? toFloat(roeRaw, 0) * 100.0 : null;

      const levObj = pos.leverage || {};
      const lev = (levObj && typeof levObj === "object") ? toFloat(levObj.value, 0) : 0;

      const liq = pos.liquidationPx;
      const liqPx = (liq == null || liq === "") ? null : toFloat(liq, 0);

      const marginUsed = toFloat(pos.marginUsed, 0);
      const side = szi > 0 ? "LONG" : "SHORT";

      const mid = mids?.[coin];
      const midPx = (mid && mid > 0) ? mid : null;

      const notionalPctEquity = accountValue > 0 ? (Math.abs(pv) / accountValue) * 100.0 : null;
      const liqDistPct =
        (midPx != null && liqPx != null && midPx > 0) ? (Math.abs(midPx - liqPx) / midPx) * 100.0 : null;

      out.push({
        coin,
        side,
        size: szi,
        entry_px: entry,
        mid_px: midPx,
        position_value: pv,
        unrealized_pnl: upnl,
        roe_pct: roePct,
        leverage: lev,
        liquidation_px: liqPx,
        margin_used: marginUsed,
        notional_pct_equity: notionalPctEquity,
        liq_distance_pct: liqDistPct,
        age_days: null, // snapshot-only unless you want to compute live
      });
    }
    return out;
  }

  async function fetchBatchClearinghouseStates(users) {
    // fail-fast batch: 0 retries; fallback per-user: 2 retries
    try {
      const resp = await postInfo({ type: "batchClearinghouseStates", users, dex: "" }, 0);
      if (Array.isArray(resp) && resp.length === users.length) {
        const out = new Map();
        for (let i = 0; i < users.length; i++) {
          const st = resp[i];
          if (st && typeof st === "object") out.set(users[i], st);
        }
        return out;
      }
    } catch {}

    // fallback per-user
    const out = new Map();
    for (const u of users) {
      try {
        const st = await postInfo({ type: "clearinghouseState", user: u, dex: "" }, 2);
        if (st && typeof st === "object") out.set(u, st);
      } catch {}
    }
    return out;
  }

  async function pollSelectedOnce() {
    if (liveInFlight) return;
    if (!settings.liveToggle) return;
    if (selected.size === 0) return;

    liveInFlight = true;
    try {
      await ensureMidsFresh();

      const addrs = [...selected].filter((a) => walletsByAddr.has(a));
      const parts = chunkArray(addrs, LIVE_BATCH_SIZE);

      setStatus(`🔄 Live update: ${addrs.length} selected…`);

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const map = await fetchBatchClearinghouseStates(part);

        for (const addr of part) {
          const w = walletsByAddr.get(addr);
          const st = map.get(addr);
          if (!w || !st) continue;

          const av = extractAccountValueFromState(st);
          const pos = extractPositionsFromState(st, av, midsCache || {});

          w.live.account_value = av;
          w.live.positions = pos;
          w.live.last_updated_utc = new Date().toISOString();
        }
      }

      // re-render only (simple approach). If you want “diff rendering”, we can optimize later.
      renderTable();
      updateSelectedCount();
      setStatus(`✅ Live updated ${selected.size} selected wallets.`);
    } catch (e) {
      setStatus(`⚠️ Live update error: ${e?.message || e}`, true);
    } finally {
      liveInFlight = false;
    }
  }

  function startLiveTimer() {
    stopLiveTimer();
    const sec = Math.max(10, Number(settings.pollInterval || 30));
    liveTimer = setInterval(pollSelectedOnce, sec * 1000);
  }

  function stopLiveTimer() {
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = null;
  }

  // ----------------------------
  // UI wiring
  // ----------------------------
  function wireUI() {
    // controls
    if ($("rankView")) {
      $("rankView").value = settings.rankView;
      $("rankView").addEventListener("change", () => {
        settings.rankView = $("rankView").value;
        saveSettings();
        applyViewAndRender();
      });
    }

    if ($("searchBox")) {
      $("searchBox").value = settings.search;
      $("searchBox").addEventListener("input", () => {
        settings.search = $("searchBox").value;
        saveSettings();
        applyViewAndRender();
      });
    }

    if ($("refreshBtn")) {
      $("refreshBtn").addEventListener("click", async () => {
        await loadSnapshot();
      });
    }

    if ($("pollInterval")) {
      $("pollInterval").value = String(settings.pollInterval);
      $("pollInterval").addEventListener("change", () => {
        settings.pollInterval = Number($("pollInterval").value || 30);
        saveSettings();
        if (settings.liveToggle) startLiveTimer();
      });
    }

    if ($("liveToggle")) {
      $("liveToggle").checked = settings.liveToggle;
      $("liveToggle").addEventListener("change", () => {
        settings.liveToggle = $("liveToggle").checked;
        saveSettings();
        if (settings.liveToggle) {
          startLiveTimer();
          pollSelectedOnce();
        } else {
          stopLiveTimer();
        }
      });
    }

    if ($("selectAllVisible")) {
      $("selectAllVisible").addEventListener("change", (e) => {
        const on = e.target.checked;
        for (const addr of visibleAddrs) {
          if (on) selected.add(addr);
          else selected.delete(addr);
        }
        saveSelectedToStorage();
        renderTable();
        updateSelectedCount();
      });
    }
  }

  // ----------------------------
  // Init
  // ----------------------------
  async function init() {
    wireUI();
    await loadSnapshot();
    applyViewAndRender();

    if (settings.liveToggle) {
      startLiveTimer();
      pollSelectedOnce();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
