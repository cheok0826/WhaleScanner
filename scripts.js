/*
 * Hyperliquid Whale Scanner (client-side)
 *
 * This script implements a browser-based version of the Python whale
 * scanner.  It uses the public Hyperliquid API endpoints to fetch
 * clearinghouse state, user fills, portfolio data and leaderboard
 * addresses.  After gathering data for a set of addresses it computes
 * risk, performance and stability metrics, ranks wallets according to
 * the selected criterion, and renders the results in a table.
 */

// Configuration for Hyperliquid endpoints
const INFO_URL = "https://api.hyperliquid.xyz/info";
const LEADERBOARD_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";

// Select DOM elements
const scanButton = document.getElementById("scanButton");
const exportJsonButton = document.getElementById("exportJson");
const statusDiv = document.getElementById("status");
const resultTableBody = document.querySelector("#resultTable tbody");

// Entry point: attach event listener to Scan button
scanButton.addEventListener("click", () => {
  // Disable the scan button while processing
  scanButton.disabled = true;
  exportJsonButton.disabled = true;
  statusDiv.textContent = "Starting scan…";
  // Kick off the scan
  runScan().catch((err) => {
    console.error(err);
    statusDiv.textContent = `Error: ${err.message || err}`;
    scanButton.disabled = false;
  });
});

// Export JSON functionality: download current results
exportJsonButton.addEventListener("click", () => {
  if (!window.currentResults) return;
  const dataStr =
    "data:application/json;charset=utf-8," +
    encodeURIComponent(JSON.stringify(window.currentResults, null, 2));
  const dl = document.createElement("a");
  dl.setAttribute("href", dataStr);
  dl.setAttribute("download", `whale_scan_${new Date().toISOString()}.json`);
  dl.click();
});

/* Helper functions */

function isEthAddress(addr) {
  return /^0x[a-fA-F0-9]{40}$/.test(addr.trim());
}

function dedupeKeepOrder(arr) {
  const seen = new Set();
  return arr.filter((item) => {
    if (seen.has(item)) return false;
    seen.add(item);
    return true;
  });
}

function chunks(array, size) {
  const result = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}

function toFloat(x, def = 0.0) {
  const n = parseFloat(x);
  return isFinite(n) ? n : def;
}

// Standard deviation of an array of numbers
function stdev(values) {
  if (!values || values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) /
    (values.length - 1);
  return Math.sqrt(variance);
}

// Maximum drawdown: returns fraction (e.g. 0.25 => -25%)
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

// Risk score calculation (0..100).  Based on margin ratio,
// maximum leverage and closest liquidation distance.  Same
// weights as the Python implementation: 40% margin, 30% leverage,
// 30% liquidation distance.  Higher = riskier.
function riskScore(accountValue, positions) {
  if (!accountValue || accountValue <= 0 || !positions || positions.length === 0)
    return 0.0;
  const totalMargin = positions.reduce(
    (sum, p) => sum + (p.margin_used || 0),
    0
  );
  const marginRatio = Math.min(1.0, totalMargin / accountValue);
  const maxLev = Math.max(...positions.map((p) => p.leverage || 0));
  const levScore = Math.min(1.0, maxLev / 50.0);
  const liqDists = positions
    .map((p) => p.liq_distance_pct)
    .filter((d) => d !== null && d !== undefined);
  let liqScore;
  if (liqDists.length > 0) {
    const closest = Math.min(...liqDists);
    liqScore = 1.0 - Math.min(1.0, closest / 50.0);
  } else {
    liqScore = 0.25;
  }
  const score = 100.0 * (0.4 * marginRatio + 0.3 * levScore + 0.3 * liqScore);
  return Math.max(0.0, Math.min(100.0, score));
}

// Style label: maps risk, volatility and drawdown into human-readable
// categories.  Rough thresholds are taken from the Python code.
function styleLabel(risk, volPctDaily, maxDrawdownPct) {
  const v = volPctDaily || 0;
  const d = maxDrawdownPct || 0;
  if (risk >= 70 || v >= 5.0 || d >= 25.0) return "aggressive";
  if (risk >= 40 || v >= 2.0 || d >= 12.0) return "balanced";
  return "stable";
}

// Parse a portfolio response from Hyperliquid into arrays of [ts, value]
function parsePortfolioWindows(portfolioResp) {
  const out = {};
  if (!Array.isArray(portfolioResp)) return out;
  for (const item of portfolioResp) {
    if (!Array.isArray(item) || item.length !== 2) continue;
    const [window, data] = item;
    if (typeof window !== "string" || typeof data !== "object" || !data) continue;
    const avh = Array.isArray(data.accountValueHistory) ? data.accountValueHistory : [];
    const pnls = Array.isArray(data.pnlHistory) ? data.pnlHistory : [];
    const avPoints = avh.map(([ts, val]) => [parseInt(ts), toFloat(val, 0)]);
    const pnlPoints = pnls.map(([ts, val]) => [parseInt(ts), toFloat(val, 0)]);
    out[window] = {
      account_values: avPoints,
      pnls: pnlPoints,
      volume: toFloat(data.volume, 0),
    };
  }
  return out;
}

// Compute return metrics for a window
function windowReturnMetrics(win) {
  if (!win || !Array.isArray(win.account_values) || win.account_values.length < 2) {
    return { growth_pct: null, pnl_pct: null, vol_pct_daily: null, max_drawdown_pct: null };
  }
  const av = win.account_values.map(([, v]) => v);
  const startAv = av[0];
  const endAv = av[av.length - 1];

  let growthPct = null;
  if (startAv > 0) growthPct = ((endAv - startAv) / startAv) * 100.0;

  let pnlPct = null;
  if (Array.isArray(win.pnls) && win.pnls.length >= 2 && startAv > 0) {
    const startPnl = win.pnls[0][1];
    const endPnl = win.pnls[win.pnls.length - 1][1];
    pnlPct = ((endPnl - startPnl) / startAv) * 100.0;
  }

  // Point-to-point returns for volatility
  const rets = [];
  for (let i = 1; i < av.length; i++) {
    const prev = av[i - 1];
    const cur = av[i];
    if (prev > 0) rets.push((cur - prev) / prev);
  }
  const vol = stdev(rets);
  const volPctDaily = vol !== null ? vol * 100.0 : null;

  const mdd = maxDrawdown(av);
  const maxDrawdownPct = mdd !== null ? mdd * 100.0 : null;

  return {
    growth_pct: growthPct,
    pnl_pct: pnlPct,
    vol_pct_daily: volPctDaily,
    max_drawdown_pct: maxDrawdownPct,
  };
}

// Fetch wrapper for Hyperliquid info endpoint
async function postInfo(payload) {
  const resp = await fetch(INFO_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // NOTE: browsers do not allow setting User-Agent; it will be ignored/blocked.
      "User-Agent": "Mozilla/5.0 (WhaleScanner/1.0)",
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
  }
  return await resp.json();
}

// GET wrapper for leaderboard
async function fetchLeaderboard() {
  const resp = await fetch(LEADERBOARD_URL);
  if (!resp.ok) {
    throw new Error(`Leaderboard HTTP ${resp.status}: ${resp.statusText}`);
  }
  return await resp.json();
}

// Extract addresses from leaderboard data
function extractAddressesFromLeaderboard(lb, topN) {
  let entries = null;
  if (Array.isArray(lb)) entries = lb;
  else if (lb && typeof lb === "object") {
    for (const key of ["leaderboard", "data", "traders", "users", "result"]) {
      if (Array.isArray(lb[key])) {
        entries = lb[key];
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
      for (const k of ["ethAddress", "address", "user", "wallet"]) {
        if (typeof e[k] === "string") {
          addr = e[k];
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

// Fetch all mid prices
async function fetchAllMids() {
  const data = await postInfo({ type: "allMids", dex: "" });
  const mids = {};
  if (data && typeof data === "object") {
    for (const k in data) {
      if (!k.startsWith("@")) {
        mids[k] = toFloat(data[k], 0.0);
      }
    }
  }
  return mids;
}

// Fetch clearinghouse state for a single user
async function fetchClearinghouseState(user) {
  const data = await postInfo({ type: "clearinghouseState", user, dex: "" });
  return typeof data === "object" && data ? data : null;
}

// Fetch batch clearinghouse states with fallback
async function fetchBatchClearinghouseStates(users, batchSize = 25) {
  const states = {};
  const failed = [];

  for (const chunk of chunks(users, batchSize)) {
    const resp = await postInfo({ type: "batchClearinghouseStates", users: chunk, dex: "" });

    if (Array.isArray(resp) && resp.length === chunk.length) {
      for (let i = 0; i < chunk.length; i++) {
        const addr = chunk[i];
        const st = resp[i];
        if (st && typeof st === "object") {
          states[addr] = st;
        } else {
          failed.push(addr);
        }
      }
    } else {
      // Fallback: per-user calls
      for (const addr of chunk) {
        try {
          const st = await fetchClearinghouseState(addr);
          if (st) states[addr] = st;
          else failed.push(addr);
        } catch {
          failed.push(addr);
        }
      }
    }
  }

  return { states, failed };
}

// Fetch user fills
async function fetchUserFills(user) {
  const data = await postInfo({ type: "userFills", user });
  return Array.isArray(data) ? data : [];
}

// Fetch portfolio
async function fetchPortfolio(user) {
  const data = await postInfo({ type: "portfolio", user });
  return data;
}

// Extract account value from clearinghouse state
function extractAccountValue(state) {
  const ms = state.marginSummary || {};
  return toFloat(ms.accountValue, 0.0);
}

// Extract positions from clearinghouse state
function extractPositions(state, accountValue, mids) {
  const out = [];
  const aps = Array.isArray(state.assetPositions) ? state.assetPositions : [];

  for (const ap of aps) {
    if (!ap || typeof ap !== "object") continue;

    const pos = ap.position || {};
    const szi = toFloat(pos.szi, 0.0);
    if (Math.abs(szi) < 1e-12) continue;

    const coin = String(pos.coin || "Unknown");
    const entry = toFloat(pos.entryPx, 0.0);
    const pv = toFloat(pos.positionValue, 0.0);
    const upnl = toFloat(pos.unrealizedPnl, 0.0);

    const roeRaw = pos.returnOnEquity;
    let roePct = null;
    if (roeRaw !== undefined && roeRaw !== null) roePct = toFloat(roeRaw, 0.0) * 100.0;

    let lev = 0.0;
    const levObj = pos.leverage || {};
    if (typeof levObj === "object") lev = toFloat(levObj.value, 0.0);

    const liq = pos.liquidationPx;
    const liqPx = liq === null || liq === undefined || liq === "" ? null : toFloat(liq, 0.0);

    const marginUsed = toFloat(pos.marginUsed, 0.0);

    const side = szi > 0 ? "LONG" : "SHORT";
    const mid = mids[coin];
    const midPx = mid && mid > 0 ? mid : null;

    let notionalPctEquity = null;
    if (accountValue > 0) notionalPctEquity = (Math.abs(pv) / accountValue) * 100.0;

    let liqDistPct = null;
    if (midPx !== null && liqPx !== null && midPx > 0) {
      liqDistPct = (Math.abs(midPx - liqPx) / midPx) * 100.0;
    }

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

// Extract last trade time from fills
function lastTradeTimeFromFills(fills) {
  if (!fills || fills.length === 0) return null;
  const tMs = fills[0].time;
  if (tMs === undefined || tMs === null) return null;
  return new Date(parseInt(tMs));
}

// Infer position ages from fills: returns a mapping coin => days open
function inferPositionAgesFromFills(fills, currentPositions) {
  const now = Date.now();

  const curByCoin = {};
  for (const p of currentPositions) curByCoin[p.coin] = p.size;

  const needed = new Set(currentPositions.map((p) => p.coin));

  const byCoin = {};
  for (const f of fills) {
    const coin = f.coin;
    if (typeof coin !== "string" || !needed.has(coin)) continue;
    if (!byCoin[coin]) byCoin[coin] = [];
    byCoin[coin].push(f);
  }

  const ages = {};
  const eps = 1e-10;

  for (const coin of Object.keys(byCoin)) {
    const fs = byCoin[coin].slice().sort((a, b) => a.time - b.time);
    let openTime = null;

    for (const f of fs) {
      const ts = new Date(parseInt(f.time));
      const startPos = toFloat(f.startPosition, 0.0);
      const side = f.side;
      const sz = toFloat(f.sz, 0.0);

      const delta = side === "B" ? sz : -sz;
      const endPos = startPos + delta;

      if (Math.abs(startPos) < eps && Math.abs(endPos) > eps) openTime = ts; // opened from flat
      if (Math.abs(endPos) < eps) openTime = null; // closed to flat
      if (startPos * endPos < 0) openTime = ts; // flipped sign
    }

    const curSize = curByCoin[coin] || 0;
    if (Math.abs(curSize) < eps) continue;

    if (!openTime && fs.length) {
      openTime = new Date(parseInt(fs[0].time));
    }

    if (openTime) {
      ages[coin] = (now - openTime.getTime()) / 86400000.0;
    }
  }

  return ages;
}

// Main scan function
async function runScan() {
  statusDiv.textContent = "Collecting parameters…";
  resultTableBody.innerHTML = "";

  const addrTextarea = document.getElementById("addresses");
  const autoDiscover = document.getElementById("autoDiscover").checked;
  const topN = parseInt(document.getElementById("topN").value) || 200;
  const minValue = parseFloat(document.getElementById("minValue").value) || 50000;
  const activeDays = parseInt(document.getElementById("activeDays").value) || 14;
  const mode = document.getElementById("mode").value;
  const rankBy = document.getElementById("rankBy").value;

  let addresses = addrTextarea.value
    .split(/\n/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s);

  addresses = addresses.filter(isEthAddress);

  if (autoDiscover) {
    statusDiv.textContent = "Fetching leaderboard…";
    try {
      const lb = await fetchLeaderboard();
      const lbAddrs = extractAddressesFromLeaderboard(lb, topN);
      addresses = addresses.concat(lbAddrs);
    } catch (err) {
      console.warn("Leaderboard fetch failed", err);
      statusDiv.textContent = `Leaderboard fetch failed: ${err.message || err}`;
    }
  }

  addresses = dedupeKeepOrder(addresses);

  if (addresses.length === 0) {
    statusDiv.textContent = "No valid addresses specified.";
    scanButton.disabled = false;
    return;
  }

  statusDiv.textContent = `Scanning ${addresses.length} wallets…`;

  // Fetch all mids once
  const mids = await fetchAllMids();

  // Batch fetch clearinghouse states
  const { states, failed: failedStates } = await fetchBatchClearinghouseStates(addresses, 25);

  statusDiv.textContent = `Fetched states: ${Object.keys(states).length}/${addresses.length}`;

  // Filter by min account value and positions
  const whalePositions = {};
  const whaleAccountValue = {};

  for (const addr of Object.keys(states)) {
    const state = states[addr];
    const av = extractAccountValue(state);

    if (av >= minValue) {
      const pos = extractPositions(state, av, mids);
      if (pos.length > 0) {
        whalePositions[addr] = pos;
        whaleAccountValue[addr] = av;
      }
    }
  }

  statusDiv.textContent = `After filters: ${Object.keys(whalePositions).length} candidates`;

  if (Object.keys(whalePositions).length === 0) {
    statusDiv.textContent = "No wallets passed the filters.";
    scanButton.disabled = false;
    return;
  }

  // Activity filter: fetch fills and determine last trade time
  const fillsCache = {};
  const lastTradeCache = {};
  const nowMs = Date.now();
  const activeCutoff = nowMs - activeDays * 86400000.0;

  let count = 0;
  for (const addr of Object.keys(whalePositions)) {
    try {
      const fills = await fetchUserFills(addr);
      fillsCache[addr] = fills;
      const lt = lastTradeTimeFromFills(fills);
      lastTradeCache[addr] = lt;
    } catch (err) {
      fillsCache[addr] = [];
      lastTradeCache[addr] = null;
    }

    count++;
    if (count % 20 === 0) {
      statusDiv.textContent = `Fetched fills: ${count}/${Object.keys(whalePositions).length}`;
    }
  }

  // Select active/inactive
  const selected = [];
  for (const addr of Object.keys(whalePositions)) {
    const lt = lastTradeCache[addr];
    const isActive = lt ? lt.getTime() >= activeCutoff : false;

    if (mode === "active" && isActive) selected.push(addr);
    if (mode === "inactive" && !isActive) selected.push(addr);
  }

  statusDiv.textContent = `Selected ${selected.length} wallets (${mode})`;

  // Fetch portfolio for selected
  const portfolioCache = {};
  let pfCount = 0;
  for (const addr of selected) {
    try {
      const pr = await fetchPortfolio(addr);
      portfolioCache[addr] = parsePortfolioWindows(pr);
    } catch {
      portfolioCache[addr] = {};
    }

    pfCount++;
    if (pfCount % 20 === 0) {
      statusDiv.textContent = `Fetched portfolios: ${pfCount}/${selected.length}`;
    }
  }

  // Build wallet views
  const walletsOut = [];

  for (const addr of selected) {
    const av = whaleAccountValue[addr] || 0;
    const pos = whalePositions[addr] || [];

    // Fill ages
    const fills = fillsCache[addr] || [];
    const ages = fills.length ? inferPositionAgesFromFills(fills, pos) : {};
    const pos2 = pos.map((p) => ({
      ...p,
      age_days: ages[p.coin] || null,
    }));

    // Portfolio metrics
    const wins = portfolioCache[addr] || {};
    const monthMetrics = wins.month ? windowReturnMetrics(wins.month) : {};
    const weekMetrics = wins.week ? windowReturnMetrics(wins.week) : {};
    const allMetrics = wins.allTime ? windowReturnMetrics(wins.allTime) : {};

    const r = riskScore(av, pos2);
    const style = styleLabel(r, monthMetrics.vol_pct_daily, monthMetrics.max_drawdown_pct);

    const totalPv = pos2.reduce((sum, p) => sum + Math.abs(p.position_value || 0), 0);
    const totalUpnl = pos2.reduce((sum, p) => sum + (p.unrealized_pnl || 0), 0);
    const totalMargin = pos2.reduce((sum, p) => sum + (p.margin_used || 0), 0);

    const exposurePct = av > 0 ? (totalPv / av) * 100.0 : null;
    const marginPct = av > 0 ? (totalMargin / av) * 100.0 : null;

    const maxLev = pos2.reduce((maxL, p) => Math.max(maxL, p.leverage || 0), 0);

    let minLiqDist = null;
    for (const p of pos2) {
      if (p.liq_distance_pct !== null && p.liq_distance_pct !== undefined) {
        if (minLiqDist === null) minLiqDist = p.liq_distance_pct;
        else minLiqDist = Math.min(minLiqDist, p.liq_distance_pct);
      }
    }

    // Ranking score depending on criterion
    let rankScore = 0;

    if (rankBy === "risk") {
      rankScore = r;
    } else if (rankBy === "pnl") {
      rankScore = monthMetrics.pnl_pct ?? weekMetrics.pnl_pct ?? allMetrics.pnl_pct ?? 0;
    } else if (rankBy === "stability") {
      const v = monthMetrics.vol_pct_daily ?? 0;
      const d = monthMetrics.max_drawdown_pct ?? 0;
      rankScore = Math.max(0, 100.0 - v * 10.0 - d * 2.0);
    } else if (rankBy === "conviction") {
      const ageList = pos2
        .map((p) => p.age_days)
        .filter((x) => x !== null && x !== undefined);
      const avgAge = ageList.length ? ageList.reduce((a, b) => a + b, 0) / ageList.length : 0;
      const exp = exposurePct || 0;
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
      style: style,
      portfolio: {
        month: monthMetrics || null,
        week: weekMetrics || null,
        allTime: allMetrics || null,
      },
      rank_score: rankScore,
    });
  }

  // Sort by rank score descending
  walletsOut.sort((a, b) => {
    const aIsNull = a.rank_score === null || a.rank_score === undefined;
    const bIsNull = b.rank_score === null || b.rank_score === undefined;
    if (aIsNull && bIsNull) return 0;
    if (aIsNull) return 1;
    if (bIsNull) return -1;
    return b.rank_score - a.rank_score;
  });

  // Assign rank numbers
  walletsOut.forEach((w, i) => (w.rank = i + 1));

  // Render table
  renderResults(walletsOut);

  // Save for JSON export
  window.currentResults = {
    generated_at_utc: new Date().toISOString(),
    mode,
    active_days: activeDays,
    min_value: minValue,
    rank_by: rankBy,
    wallets: walletsOut,
    failed_states: failedStates,
    notes: {
      pnl_pct_and_growth_pct_are_approx: true,
      reason:
        "Computed from portfolio accountValueHistory/pnlHistory deltas divided by start account value.",
    },
  };

  statusDiv.textContent = `Scan complete: ranked ${walletsOut.length} wallets.`;
  exportJsonButton.disabled = false;
  scanButton.disabled = false;
}

// Render results into the table
function renderResults(wallets) {
  resultTableBody.innerHTML = "";

  for (const w of wallets) {
    const tr = document.createElement("tr");

    const addrShort = `${w.address.slice(0, 6)}…${w.address.slice(-4)}`;
    const avStr = w.account_value.toLocaleString(undefined, { maximumFractionDigits: 2 });
    const scoreStr = (w.rank_score ?? 0).toFixed(2);

    const positionsDetail = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = `${w.num_positions} pos`;
    positionsDetail.appendChild(summary);

    const ul = document.createElement("ul");
    for (const p of w.positions) {
      const li = document.createElement("li");

      const sizeStr = p.size.toFixed(4);
      const entry = p.entry_px.toFixed(2);
      const liq =
        p.liquidation_px !== null && p.liquidation_px !== undefined
          ? p.liquidation_px.toFixed(2)
          : "–";
      const roe =
        p.roe_pct !== null && p.roe_pct !== undefined ? p.roe_pct.toFixed(2) + "%" : "–";
      const age =
        p.age_days !== null && p.age_days !== undefined ? p.age_days.toFixed(1) + "d" : "–";

      li.textContent = `${p.coin} ${p.side} ${sizeStr}@${entry} ROE:${roe} Age:${age} LiqPx:${liq}`;
      ul.appendChild(li);
    }
    positionsDetail.appendChild(ul);

    tr.innerHTML = `
      <td>${w.rank}</td>
      <td title="${w.address}">${addrShort}</td>
      <td>$${avStr}</td>
      <td>${scoreStr}</td>
      <td>${w.style}</td>
    `;

    const tdPos = document.createElement("td");
    tdPos.appendChild(positionsDetail);
    tr.appendChild(tdPos);

    resultTableBody.appendChild(tr);
  }
}
