/*
 * Hyperliquid Whale Scanner (client-side, hardened)
 *
 * Fixes / improvements:
 * - Remove forbidden "User-Agent" header
 * - Add timeout + retry/backoff (+ jitter) for all API calls
 * - Add rate-limiting throttling to reduce 429
 * - Better status/error reporting so “not working” shows WHY
 * - Safer DOM binding (clear errors if IDs mismatch)
 */

(() => {
  // ----------------------------
  // Endpoints
  // ----------------------------
  const INFO_URL = "https://api.hyperliquid.xyz/info";
  const LEADERBOARD_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
  const DEFAULT_RETRIES = 2;         // keep retries for normal calls
  const GLOBAL_THROTTLE_MS = 400;    // slow down, fewer 429/500
  const PER_WALLET_CONCURRENCY = 2;  // reduce parallel load
  const BATCH_SIZE = 10;             // smaller batch tends to 500 less

  // ----------------------------
  // Tunables (safe defaults)
  // ----------------------------
  const DEFAULT_TIMEOUT_MS = 20000;
  const DEFAULT_RETRIES = 3;
  const DEFAULT_BACKOFF_BASE_MS = 650; // base for exponential backoff
  const MAX_BACKOFF_MS = 6000;

  // Global throttle to avoid hammering API (ms between requests).
  // Browser fetch concurrency + no throttle = easy to get 429.
  const GLOBAL_THROTTLE_MS = 180;

  // Concurrency for per-wallet endpoints (fills, portfolio)
  const PER_WALLET_CONCURRENCY = 3;

  // batchClearinghouseStates chunk size
  const BATCH_SIZE = 25;

  // ----------------------------
  // DOM helpers (safe binding)
  // ----------------------------
  function $(id) {
    return document.getElementById(id);
  }

  function setStatus(msg) {
    const el = $("status");
    if (el) el.textContent = msg;
    console.log("[status]", msg);
  }

  function setStatusError(msg) {
    const el = $("status");
    if (el) {
      el.textContent = msg;
      el.style.color = "#b00020";
      el.style.fontWeight = "600";
    }
    console.error("[status]", msg);
  }

  function clearStatusErrorStyle() {
    const el = $("status");
    if (el) {
      el.style.color = "";
      el.style.fontWeight = "";
    }
  }

  function ensureDomOrFail() {
    const required = [
      "scanButton",
      "exportJson",
      "status",
      "addresses",
      "autoDiscover",
      "topN",
      "minValue",
      "activeDays",
      "mode",
      "rankBy",
      "resultTable",
    ];
    const missing = required.filter((id) => !$(id));
    if (missing.length) {
      setStatusError(
        `❌ HTML missing required element IDs: ${missing.join(
          ", "
        )}. Make sure your index.html matches the expected IDs.`
      );
      return false;
    }
    return true;
  }

  // ----------------------------
  // Utility helpers
  // ----------------------------
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function toFloat(x, def = 0.0) {
    const n = parseFloat(x);
    return Number.isFinite(n) ? n : def;
  }

  function isEthAddress(addr) {
    return /^0x[a-fA-F0-9]{40}$/.test((addr || "").trim());
  }

  function dedupeKeepOrder(arr) {
    const seen = new Set();
    const out = [];
    for (const x of arr) {
      if (!seen.has(x)) {
        seen.add(x);
        out.push(x);
      }
    }
    return out;
  }

  function chunkArray(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  function stdev(values) {
    if (!values || values.length < 2) return null;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance =
      values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
    return Math.sqrt(variance);
  }

  function maxDrawdown(series) {
    if (!series || series.length < 2) return null;
    let peak = series[0];
    let mdd = 0;
    for (const v of series) {
      if (v > peak) peak = v;
      const dd = peak !== 0 ? (peak - v) / peak : 0;
      if (dd > mdd) mdd = dd;
    }
    return mdd;
  }

  // ----------------------------
  // Global throttle (simple)
  // ----------------------------
  let _lastReqAt = 0;
  async function throttle() {
    const now = Date.now();
    const wait = Math.max(0, _lastReqAt + GLOBAL_THROTTLE_MS - now);
    if (wait > 0) await sleep(wait);
    _lastReqAt = Date.now();
  }

  // ----------------------------
  // Robust fetch JSON with retries
  // ----------------------------
  async function fetchJsonWithRetry(url, options, cfg = {}) {
    const retries = cfg.retries ?? DEFAULT_RETRIES;
    const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const backoffBaseMs = cfg.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;

    let lastErr = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      await throttle();

      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);

      try {
        const resp = await fetch(url, { ...options, signal: ac.signal });

        // Retry-worthy HTTP status codes
        if ([429, 500, 502, 503, 504].includes(resp.status)) {
          const txt = await safeReadText(resp);
          lastErr = new Error(`HTTP ${resp.status} ${resp.statusText}: ${txt?.slice(0, 200) || ""}`);
          if (attempt < retries) {
            await backoffSleep(attempt, backoffBaseMs);
            continue;
          }
          throw lastErr;
        }

        if (!resp.ok) {
          const txt = await safeReadText(resp);
          throw new Error(`HTTP ${resp.status} ${resp.statusText}: ${txt?.slice(0, 400) || ""}`);
        }

        // parse json
        return await resp.json();
      } catch (err) {
        lastErr = err;

        // "TypeError: Failed to fetch" can happen from:
        // - network error / DNS
        // - CORS blocked
        // - request aborted
        // Retrying helps for flaky network / rate limiting.
        if (attempt < retries) {
          await backoffSleep(attempt, backoffBaseMs);
          continue;
        }
        throw err;
      } finally {
        clearTimeout(t);
      }
    }

    // should never reach here
    throw lastErr || new Error("Unknown fetch error");
  }

  async function safeReadText(resp) {
    try {
      return await resp.text();
    } catch {
      return "";
    }
  }

  async function backoffSleep(attempt, baseMs) {
    // exponential backoff + jitter
    const exp = Math.min(MAX_BACKOFF_MS, baseMs * 2 ** attempt);
    const jitter = Math.floor(Math.random() * 250);
    await sleep(exp + jitter);
  }

  // ----------------------------
  // Hyperliquid API wrappers
  // ----------------------------
  async function postInfo(payload, cfg = {}) {
    return await fetchJsonWithRetry(
      INFO_URL,
      {
        method: "POST",
        mode: "cors",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      {
        retries: cfg.retries ?? DEFAULT_RETRIES,
        timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        backoffBaseMs: cfg.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
      }
    );
  }

  async function fetchLeaderboard() {
    return await fetchJsonWithRetry(
      LEADERBOARD_URL,
      { method: "GET", mode: "cors", credentials: "omit" },
      { retries: DEFAULT_RETRIES, timeoutMs: DEFAULT_TIMEOUT_MS }
    );
  }

  async function fetchAllMids() {
    const data = await postInfo({ type: "allMids", dex: "" });
    const mids = {};
    if (data && typeof data === "object") {
      for (const [k, v] of Object.entries(data)) {
        if (typeof k === "string" && !k.startsWith("@")) mids[k] = toFloat(v, 0);
      }
    }
    return mids;
  }

  async function fetchClearinghouseState(user) {
    const data = await postInfo({ type: "clearinghouseState", user, dex: "" });
    return data && typeof data === "object" ? data : null;
  }
  
  async function fetchBatchClearinghouseStates(users, batchSize = BATCH_SIZE) {
    const states = {};
    const failed = [];
  
    const parts = chunkArray(users, batchSize);
  
    for (let idx = 0; idx < parts.length; idx++) {
      const part = parts[idx];
      setStatus(`📦 batchClearinghouseStates ${idx + 1}/${parts.length} ...`);
  
      let resp = null;
      let batchOk = false;
  
      // FAIL FAST on batch (prevents spammy repeated 500s)
      try {
        resp = await postInfo(
          { type: "batchClearinghouseStates", users: part, dex: "" },
          { retries: 0 }
        );
        batchOk = Array.isArray(resp) && resp.length === part.length;
      } catch {
        batchOk = false;
      }
  
      if (batchOk) {
        for (let i = 0; i < part.length; i++) {
          const addr = part[i];
          const st = resp[i];
          if (st && typeof st === "object") states[addr] = st;
          else failed.push(addr);
        }
        continue;
      }
  
      // Fallback per-user (usually survives when batch is flaky)
      setStatus(`⚠️ batch failed, fallback per-user ${idx + 1}/${parts.length}...`);
      for (const addr of part) {
        try {
          const st = await postInfo(
            { type: "clearinghouseState", user: addr, dex: "" },
            { retries: 2 }
          );
          if (st && typeof st === "object") states[addr] = st;
          else failed.push(addr);
        } catch {
          failed.push(addr);
        }
      }
    }
  
    const uniqueFailed = dedupeKeepOrder(failed).filter((a) => !states[a]);
    return { states, failed: uniqueFailed };
  }


  async function fetchUserFills(user) {
    const data = await postInfo({ type: "userFills", user });
    return Array.isArray(data) ? data : [];
  }

  async function fetchPortfolio(user) {
    return await postInfo({ type: "portfolio", user });
  }

  // ----------------------------
  // Data extraction / metrics
  // ----------------------------
  function extractAccountValue(state) {
    const ms = state?.marginSummary || {};
    return toFloat(ms.accountValue, 0.0);
  }

  function extractPositions(state, accountValue, mids) {
    const out = [];
    const aps = Array.isArray(state?.assetPositions) ? state.assetPositions : [];

    for (const ap of aps) {
      const pos = ap?.position || {};
      const szi = toFloat(pos.szi, 0.0);
      if (Math.abs(szi) < 1e-12) continue;

      const coin = String(pos.coin || "Unknown");
      const entry = toFloat(pos.entryPx, 0.0);
      const pv = toFloat(pos.positionValue, 0.0);
      const upnl = toFloat(pos.unrealizedPnl, 0.0);

      const roeRaw = pos.returnOnEquity;
      const roePct = roeRaw !== null && roeRaw !== undefined ? toFloat(roeRaw, 0) * 100.0 : null;

      const levObj = pos.leverage || {};
      const lev = typeof levObj === "object" ? toFloat(levObj.value, 0.0) : 0.0;

      const liq = pos.liquidationPx;
      const liqPx = liq === null || liq === undefined || liq === "" ? null : toFloat(liq, 0);

      const marginUsed = toFloat(pos.marginUsed, 0.0);

      const side = szi > 0 ? "LONG" : "SHORT";
      const mid = mids[coin];
      const midPx = mid && mid > 0 ? mid : null;

      const notionalPctEquity =
        accountValue > 0 ? (Math.abs(pv) / accountValue) * 100.0 : null;

      const liqDistPct =
        midPx !== null && liqPx !== null && midPx > 0
          ? (Math.abs(midPx - liqPx) / midPx) * 100.0
          : null;

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
        age_days: null,
      });
    }
    return out;
  }

  function lastTradeTimeFromFills(fills) {
    if (!fills || fills.length === 0) return null;
    const tMs = fills[0]?.time;
    if (tMs === null || tMs === undefined) return null;
    // Hyperliquid uses ms timestamps
    return new Date(parseInt(tMs, 10));
  }

  function inferPositionAgesFromFills(fills, currentPositions) {
    const now = Date.now();
    const needed = new Set(currentPositions.map((p) => p.coin));
    const curByCoin = Object.fromEntries(currentPositions.map((p) => [p.coin, p.size]));

    const byCoin = {};
    for (const f of fills) {
      const coin = f?.coin;
      if (typeof coin !== "string" || !needed.has(coin)) continue;
      (byCoin[coin] ||= []).push(f);
    }

    const ages = {};
    const eps = 1e-10;

    for (const coin of Object.keys(byCoin)) {
      const fs = byCoin[coin].slice().sort((a, b) => (a.time || 0) - (b.time || 0));

      let openTime = null;

      for (const f of fs) {
        const tMs = f?.time;
        if (tMs === null || tMs === undefined) continue;

        const ts = new Date(parseInt(tMs, 10));
        const startPos = toFloat(f?.startPosition, 0.0);
        const side = f?.side; // "B" buy, "A" sell
        const sz = toFloat(f?.sz, 0.0);

        const delta = side === "B" ? sz : -sz;
        const endPos = startPos + delta;

        if (Math.abs(startPos) < eps && Math.abs(endPos) > eps) openTime = ts;
        if (Math.abs(endPos) < eps) openTime = null;
        if (startPos * endPos < 0) openTime = ts;
      }

      const curSize = curByCoin[coin] || 0.0;
      if (Math.abs(curSize) < eps) continue;

      if (!openTime && fs.length) {
        openTime = new Date(parseInt(fs[0].time, 10));
      }

      if (openTime) ages[coin] = (now - openTime.getTime()) / 86400000.0;
    }

    return ages;
  }

  function parsePortfolioWindows(portfolioResp) {
    const out = {};
    if (!Array.isArray(portfolioResp)) return out;

    for (const item of portfolioResp) {
      if (!Array.isArray(item) || item.length !== 2) continue;
      const [window, data] = item;
      if (typeof window !== "string" || !data || typeof data !== "object") continue;

      const avh = Array.isArray(data.accountValueHistory) ? data.accountValueHistory : [];
      const pnlh = Array.isArray(data.pnlHistory) ? data.pnlHistory : [];
      const vol = toFloat(data.volume, 0.0);

      const avPoints = [];
      const pnlPoints = [];

      for (const p of avh) {
        if (Array.isArray(p) && p.length === 2) avPoints.push([parseInt(p[0], 10), toFloat(p[1], 0)]);
      }
      for (const p of pnlh) {
        if (Array.isArray(p) && p.length === 2) pnlPoints.push([parseInt(p[0], 10), toFloat(p[1], 0)]);
      }

      out[window] = { account_values: avPoints, pnls: pnlPoints, volume: vol };
    }
    return out;
  }

  function windowReturnMetrics(win) {
    const av = win?.account_values || [];
    const pnls = win?.pnls || [];
    if (!Array.isArray(av) || av.length < 2) {
      return { growth_pct: null, pnl_pct: null, vol_pct_daily: null, max_drawdown_pct: null };
    }

    const avVals = av.map(([, v]) => v);
    const start = avVals[0];
    const end = avVals[avVals.length - 1];

    const growthPct = start > 0 ? ((end - start) / start) * 100.0 : null;

    let pnlPct = null;
    if (Array.isArray(pnls) && pnls.length >= 2 && start > 0) {
      const startPnl = pnls[0][1];
      const endPnl = pnls[pnls.length - 1][1];
      pnlPct = ((endPnl - startPnl) / start) * 100.0;
    }

    const rets = [];
    for (let i = 1; i < avVals.length; i++) {
      const prev = avVals[i - 1];
      const cur = avVals[i];
      if (prev > 0) rets.push((cur - prev) / prev);
    }

    const vol = stdev(rets);
    const volPctDaily = vol !== null ? vol * 100.0 : null;

    const mdd = maxDrawdown(avVals);
    const mddPct = mdd !== null ? mdd * 100.0 : null;

    return { growth_pct: growthPct, pnl_pct: pnlPct, vol_pct_daily: volPctDaily, max_drawdown_pct: mddPct };
  }

  function riskScore(accountValue, positions) {
    if (!accountValue || accountValue <= 0 || !positions || positions.length === 0) return 0.0;

    const totalMargin = positions.reduce((s, p) => s + (p.margin_used || 0), 0);
    const marginRatio = Math.min(1.0, totalMargin / accountValue);

    const maxLev = Math.max(...positions.map((p) => p.leverage || 0));
    const levScore = Math.min(1.0, maxLev / 50.0);

    const liqDists = positions.map((p) => p.liq_distance_pct).filter((d) => d !== null && d !== undefined);
    let liqScore = 0.25;
    if (liqDists.length) {
      const closest = Math.min(...liqDists);
      liqScore = 1.0 - Math.min(1.0, closest / 50.0);
    }

    const score = 100.0 * (0.40 * marginRatio + 0.30 * levScore + 0.30 * liqScore);
    return Math.max(0.0, Math.min(100.0, score));
  }

  function styleLabel(risk, volPctDaily, mddPct) {
    const v = volPctDaily ?? 0.0;
    const d = mddPct ?? 0.0;
    if (risk >= 70 || v >= 5.0 || d >= 25.0) return "aggressive";
    if (risk >= 40 || v >= 2.0 || d >= 12.0) return "balanced";
    return "stable";
  }

  function extractAddressesFromLeaderboard(lb, topN) {
    let entries = null;

    if (Array.isArray(lb)) {
      entries = lb;
    } else if (lb && typeof lb === "object") {
      for (const k of ["leaderboard", "data", "traders", "users", "result"]) {
        if (Array.isArray(lb[k])) {
          entries = lb[k];
          break;
        }
      }
      if (!entries) {
        const vals = Object.values(lb);
        if (vals.length && Array.isArray(vals[0])) entries = vals[0];
      }
    }

    if (!Array.isArray(entries)) return [];

    const out = [];
    for (const e of entries.slice(0, topN)) {
      let addr = null;
      if (typeof e === "string") addr = e;
      else if (e && typeof e === "object") {
        for (const key of ["ethAddress", "address", "user", "wallet"]) {
          const v = e[key];
          if (typeof v === "string") {
            addr = v;
            break;
          }
        }
      }
      if (!addr) continue;

      addr = addr.trim().toLowerCase();
      if (isEthAddress(addr)) out.push(addr);
    }

    return dedupeKeepOrder(out);
  }

  // ----------------------------
  // Concurrency helper
  // ----------------------------
  async function runWithConcurrency(items, concurrency, worker, onProgress) {
    const queue = items.slice();
    let done = 0;

    async function runner() {
      while (queue.length) {
        const item = queue.shift();
        await worker(item);
        done++;
        if (onProgress) onProgress(done, items.length);
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runner());
    await Promise.all(workers);
  }

  // ----------------------------
  // Rendering
  // ----------------------------
  function renderResults(wallets) {
    const tbody = document.querySelector("#resultTable tbody");
    if (!tbody) return;
    tbody.innerHTML = "";

    for (const w of wallets) {
      const tr = document.createElement("tr");

      const addrShort = `${w.address.slice(0, 6)}…${w.address.slice(-4)}`;
      const avStr = (w.account_value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
      const scoreStr = (w.rank_score ?? 0).toFixed(2);

      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = `${w.num_positions} pos`;
      details.appendChild(summary);

      const ul = document.createElement("ul");
      for (const p of w.positions) {
        const li = document.createElement("li");
        const sizeStr = (p.size ?? 0).toFixed(4);
        const entry = (p.entry_px ?? 0).toFixed(2);
        const liq = p.liquidation_px != null ? p.liquidation_px.toFixed(2) : "–";
        const roe = p.roe_pct != null ? `${p.roe_pct.toFixed(2)}%` : "–";
        const age = p.age_days != null ? `${p.age_days.toFixed(1)}d` : "–";
        li.textContent = `${p.coin} ${p.side} ${sizeStr}@${entry} ROE:${roe} Age:${age} LiqPx:${liq}`;
        ul.appendChild(li);
      }
      details.appendChild(ul);

      tr.innerHTML = `
        <td>${w.rank}</td>
        <td title="${w.address}">${addrShort}</td>
        <td>$${avStr}</td>
        <td>${scoreStr}</td>
        <td>${w.style}</td>
      `;

      const tdPos = document.createElement("td");
      tdPos.appendChild(details);
      tr.appendChild(tdPos);

      tbody.appendChild(tr);
    }
  }

  // ----------------------------
  // Main scan pipeline
  // ----------------------------
  async function runScan() {
    clearStatusErrorStyle();

    const scanButton = $("scanButton");
    const exportJsonButton = $("exportJson");

    scanButton.disabled = true;
    exportJsonButton.disabled = true;

    try {
      // Collect params
      const addrTextarea = $("addresses");
      const autoDiscover = $("autoDiscover").checked;
      const topN = parseInt($("topN").value, 10) || 200;
      const minValue = parseFloat($("minValue").value) || 50000;
      const activeDays = parseInt($("activeDays").value, 10) || 14;
      const mode = $("mode").value;
      const rankBy = $("rankBy").value;

      // Addresses
      let addresses = addrTextarea.value
        .split(/\n/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
        .filter(isEthAddress);

      if (autoDiscover) {
        setStatus("🔍 Fetching leaderboard...");
        const lb = await fetchLeaderboard();
        const lbAddrs = extractAddressesFromLeaderboard(lb, topN);
        addresses = addresses.concat(lbAddrs);
      }

      addresses = dedupeKeepOrder(addresses);
      if (!addresses.length) {
        setStatusError("❌ No valid addresses (0x...) provided.");
        return;
      }

      setStatus("💱 Fetching mid prices...");
      const mids = await fetchAllMids();

      setStatus(`📦 Fetching clearinghouse states for ${addresses.length} wallets...`);
      const { states, failed: failedStates } = await fetchBatchClearinghouseStates(addresses, BATCH_SIZE);

      setStatus(`✅ States fetched: ${Object.keys(states).length}/${addresses.length} | Failed: ${failedStates.length}`);

      // Filter whales by min account value + open positions
      const whalePositions = {};
      const whaleAccountValue = {};

      for (const [addr, st] of Object.entries(states)) {
        const av = extractAccountValue(st);
        if (av < minValue) continue;

        const pos = extractPositions(st, av, mids);
        if (pos.length) {
          whalePositions[addr] = pos;
          whaleAccountValue[addr] = av;
        }
      }

      const candidates = Object.keys(whalePositions);
      setStatus(`🐋 Candidates after min-value + position filter: ${candidates.length}`);
      if (!candidates.length) {
        window.currentResults = {
          generated_at_utc: new Date().toISOString(),
          mode,
          active_days: activeDays,
          min_value: minValue,
          rank_by: rankBy,
          wallets: [],
          failed_states: failedStates,
          note: "No wallets passed filters (no open positions or failed state calls).",
        };
        renderResults([]);
        exportJsonButton.disabled = false;
        return;
      }

      // Fetch fills for activity + age
      const fillsCache = {};
      const lastTradeCache = {};
      const failedFills = [];

      setStatus(`🧾 Fetching userFills for ${candidates.length} wallets...`);
      const activeCutoff = Date.now() - activeDays * 86400000;

      await runWithConcurrency(
        candidates,
        PER_WALLET_CONCURRENCY,
        async (addr) => {
          try {
            const fills = await fetchUserFills(addr);
            fillsCache[addr] = fills;
            lastTradeCache[addr] = lastTradeTimeFromFills(fills);
          } catch (e) {
            fillsCache[addr] = [];
            lastTradeCache[addr] = null;
            failedFills.push(addr);
          }
        },
        (done, total) => {
          if (done % 20 === 0 || done === total) setStatus(`🧾 userFills progress: ${done}/${total}`);
        }
      );

      // Active/inactive selection
      const selected = [];
      for (const addr of candidates) {
        const lt = lastTradeCache[addr];
        const isActive = lt ? lt.getTime() >= activeCutoff : false;
        if (mode === "active" && isActive) selected.push(addr);
        if (mode === "inactive" && !isActive) selected.push(addr);
      }

      setStatus(`✅ Selected wallets after ${mode} filter: ${selected.length}`);
      if (!selected.length) {
        window.currentResults = {
          generated_at_utc: new Date().toISOString(),
          mode,
          active_days: activeDays,
          min_value: minValue,
          rank_by: rankBy,
          wallets: [],
          failed_states: failedStates,
          failed_fills: failedFills,
          note: `No wallets match mode=${mode} under active_days=${activeDays}.`,
        };
        renderResults([]);
        exportJsonButton.disabled = false;
        return;
      }

      // Fetch portfolio windows
      const portfolioCache = {};
      setStatus(`📈 Fetching portfolio for ${selected.length} wallets...`);

      await runWithConcurrency(
        selected,
        PER_WALLET_CONCURRENCY,
        async (addr) => {
          try {
            const pr = await fetchPortfolio(addr);
            portfolioCache[addr] = parsePortfolioWindows(pr);
          } catch {
            portfolioCache[addr] = {};
          }
        },
        (done, total) => {
          if (done % 20 === 0 || done === total) setStatus(`📈 portfolio progress: ${done}/${total}`);
        }
      );

      // Build wallet views
      const walletsOut = [];

      for (const addr of selected) {
        const av = whaleAccountValue[addr] || 0;
        const pos = whalePositions[addr] || [];

        // ages
        const fills = fillsCache[addr] || [];
        const ages = fills.length ? inferPositionAgesFromFills(fills, pos) : {};

        const pos2 = pos.map((p) => ({ ...p, age_days: ages[p.coin] ?? null }));

        // portfolio metrics
        const wins = portfolioCache[addr] || {};
        const monthMetrics = wins.month ? windowReturnMetrics(wins.month) : {};
        const weekMetrics = wins.week ? windowReturnMetrics(wins.week) : {};
        const allMetrics = wins.allTime ? windowReturnMetrics(wins.allTime) : {};

        const r = riskScore(av, pos2);
        const style = styleLabel(r, monthMetrics.vol_pct_daily, monthMetrics.max_drawdown_pct);

        const totalPv = pos2.reduce((s, p) => s + Math.abs(p.position_value || 0), 0);
        const totalUpnl = pos2.reduce((s, p) => s + (p.unrealized_pnl || 0), 0);
        const totalMargin = pos2.reduce((s, p) => s + (p.margin_used || 0), 0);

        const exposurePct = av > 0 ? (totalPv / av) * 100.0 : null;
        const marginPct = av > 0 ? (totalMargin / av) * 100.0 : null;

        const maxLev = pos2.reduce((m, p) => Math.max(m, p.leverage || 0), 0);

        const liqDists = pos2.map((p) => p.liq_distance_pct).filter((x) => x != null);
        const minLiqDist = liqDists.length ? Math.min(...liqDists) : null;

        // ranking score
        let rankScore = 0.0;
        if (rankBy === "risk") {
          rankScore = r;
        } else if (rankBy === "pnl") {
          rankScore = monthMetrics.pnl_pct ?? weekMetrics.pnl_pct ?? allMetrics.pnl_pct ?? 0.0;
        } else if (rankBy === "stability") {
          const v = monthMetrics.vol_pct_daily ?? 0.0;
          const d = monthMetrics.max_drawdown_pct ?? 0.0;
          rankScore = Math.max(0.0, 100.0 - v * 10.0 - d * 2.0);
        } else if (rankBy === "conviction") {
          const agesList = pos2.map((p) => p.age_days).filter((x) => x != null);
          const avgAge = agesList.length ? agesList.reduce((a, b) => a + b, 0) / agesList.length : 0.0;
          const exp = exposurePct ?? 0.0;
          rankScore = avgAge * 2.0 + exp * 0.5 - r * 0.5;
        }

        const lt = lastTradeCache[addr];

        walletsOut.push({
          address: addr,
          account_value: av,
          last_trade_utc: lt ? lt.toISOString() : null,
          positions: pos2,
          num_positions: pos2.length,
          total_position_value: totalPv,
          total_unrealized_pnl: totalUpnl,
          total_margin_used: totalMargin,
          exposure_pct: exposurePct,
          margin_pct: marginPct,
          max_leverage: maxLev,
          min_liq_distance_pct: minLiqDist,
          risk_score: r,
          style,
          portfolio: {
            month: monthMetrics || null,
            week: weekMetrics || null,
            allTime: allMetrics || null,
          },
          rank_score: rankScore,
        });
      }

      // sort + rank
      walletsOut.sort((a, b) => (b.rank_score ?? 0) - (a.rank_score ?? 0));
      walletsOut.forEach((w, i) => (w.rank = i + 1));

      renderResults(walletsOut);

      window.currentResults = {
        generated_at_utc: new Date().toISOString(),
        mode,
        active_days: activeDays,
        min_value: minValue,
        rank_by: rankBy,
        wallets: walletsOut,
        failed_states: failedStates,
        failed_fills: failedFills,
        notes: {
          pnl_pct_and_growth_pct_are_approx: true,
          reason: "Computed from portfolio deltas divided by start account value.",
        },
      };

      setStatus(`✅ DONE: ranked ${walletsOut.length} wallets. Failed states=${failedStates.length}, failed fills=${failedFills.length}`);
      exportJsonButton.disabled = false;
    } catch (err) {
      const msg =
        err?.name === "AbortError"
          ? "Request timed out (AbortError). Try increasing timeout or reducing Top N."
          : err?.message || String(err);

      // Big hint for the common case
      if (String(msg).toLowerCase().includes("failed to fetch")) {
        setStatusError(
          `❌ Failed to fetch. Likely causes: (1) script.js path/404, (2) network blocked, (3) API temporarily down, (4) browser blocked request.\n\nOpen DevTools → Console/Network to see if script.js is 404 or if requests are blocked.`
        );
      } else {
        setStatusError(`❌ Error: ${msg}`);
      }
    } finally {
      $("scanButton").disabled = false;
      // export stays disabled if no results
    }
  }

  // ----------------------------
  // Button wiring
  // ----------------------------
  function attachHandlers() {
    if (!ensureDomOrFail()) return;

    const scanButton = $("scanButton");
    const exportJsonButton = $("exportJson");

    scanButton.addEventListener("click", () => runScan());

    exportJsonButton.addEventListener("click", () => {
      if (!window.currentResults) return;
      const blob = new Blob([JSON.stringify(window.currentResults, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `whale_scan_${new Date().toISOString().replaceAll(":", "-")}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

    setStatus("Ready. Click Scan.");
  }

  // Wait DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attachHandlers);
  } else {
    attachHandlers();
  }
})();

