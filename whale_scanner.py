#!/usr/bin/env python3
"""
Hyperliquid Whale Scanner -> GitHub Pages JSON snapshots (server-side via GitHub Actions)

Why this version:
- Browser-side scanning can hit Hyperliquid /info with lots of requests, and you saw repeated HTTP 500s.
  This version is meant to run in GitHub Actions on a schedule, write JSON files to your repo, and your
  GitHub Pages site simply reads those JSONs (fast + reliable).

What it does:
- Auto-discover addresses from the Hyperliquid leaderboard
- Fetch positions/accountValue via batchClearinghouseStates (with adaptive chunking + retry/backoff)
- Fetch userFills for activity + position age inference
- Fetch portfolio for PnL%/growth%/vol/drawdown (approx)
- Compute scores and produce rankings: risk / pnl / stability / conviction
- Writes deterministic JSON files (easy for a static site to load)
  - <out_dir>/meta.json
  - <out_dir>/<mode>_all.json
  - <out_dir>/<mode>_risk.json
  - <out_dir>/<mode>_pnl.json
  - <out_dir>/<mode>_stability.json
  - <out_dir>/<mode>_conviction.json

Usage examples:
  # Active whales, ranked in all ways (default outputs to ./data)
  python whale_scanner_actions.py --auto-find --top-n 200 --min-value 50000 --active-days 14 --mode active

  # Both active+inactive outputs
  python whale_scanner_actions.py --auto-find --mode both

Notes:
- "PnL% / growth%" are approximate, derived from portfolio accountValueHistory/pnlHistory deltas.
- API hiccups (429/5xx) are handled with retries + exponential backoff + jitter.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import re
import sys
import time
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import requests


# ----------------------------
# Small helpers
# ----------------------------

ETH_ADDR_RE = re.compile(r"^0x[a-fA-F0-9]{40}$")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso_utc(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() if dt else None


def to_float(x: Any, default: float = 0.0) -> float:
    try:
        if x is None:
            return default
        return float(x)
    except Exception:
        return default


def is_eth_address(s: str) -> bool:
    return bool(ETH_ADDR_RE.match((s or "").strip()))


def dedupe_keep_order(items: Iterable[str]) -> List[str]:
    seen = set()
    out: List[str] = []
    for x in items:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out


def chunks(lst: List[str], n: int) -> Iterable[List[str]]:
    for i in range(0, len(lst), n):
        yield lst[i : i + n]


def stdev(values: List[float]) -> Optional[float]:
    if len(values) < 2:
        return None
    m = sum(values) / len(values)
    var = sum((v - m) ** 2 for v in values) / (len(values) - 1)
    return math.sqrt(var)


def max_drawdown(series: List[float]) -> Optional[float]:
    if len(series) < 2:
        return None
    peak = series[0]
    mdd = 0.0
    for v in series:
        if v > peak:
            peak = v
        dd = (peak - v) / peak if peak != 0 else 0.0
        mdd = max(mdd, dd)
    return mdd


def atomic_write_json(path: Path, obj: Any, indent: int = 2) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(obj, f, indent=indent, ensure_ascii=False)
    tmp.replace(path)


# ----------------------------
# Core client (robust retries + pacing)
# ----------------------------

@dataclass
class RetryCfg:
    retries: int = 4
    timeout_s: int = 20
    backoff_base_s: float = 0.8
    backoff_cap_s: float = 10.0
    jitter_s: float = 0.25


class RateLimiter:
    """
    A simple global throttle + adaptive cooldown when errors happen.
    Good for avoiding 429 and reducing server stress.
    """

    def __init__(self, min_interval_s: float = 0.15, max_interval_s: float = 1.0):
        self.min_interval_s = min_interval_s
        self.max_interval_s = max_interval_s
        self._last_ts = 0.0
        self._cooldown = 0.0

    def note_error(self) -> None:
        self._cooldown = min(self.max_interval_s, max(self._cooldown * 1.6, self.min_interval_s))

    def note_ok(self) -> None:
        self._cooldown = max(0.0, self._cooldown * 0.85 - 0.01)

    def wait(self) -> None:
        now = time.time()
        target = self._last_ts + self.min_interval_s + self._cooldown
        if now < target:
            time.sleep(target - now)
        self._last_ts = time.time()


class HLClient:
    def __init__(
        self,
        info_url: str = "https://api.hyperliquid.xyz/info",
        leaderboard_url: str = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard",
        retry: RetryCfg = RetryCfg(),
        limiter: Optional[RateLimiter] = None,
        debug: bool = False,
    ):
        self.info_url = info_url
        self.leaderboard_url = leaderboard_url
        self.retry = retry
        self.limiter = limiter or RateLimiter(min_interval_s=0.15, max_interval_s=1.0)
        self.debug = debug

        self.sess = requests.Session()
        self.sess.headers.update({"Content-Type": "application/json", "User-Agent": "WhaleScanner-GHA/1.0"})

    def _sleep_backoff(self, attempt: int) -> None:
        base = min(self.retry.backoff_cap_s, self.retry.backoff_base_s * (2 ** attempt))
        jitter = random.random() * self.retry.jitter_s
        time.sleep(base + jitter)

    def _post_json(self, payload: Dict[str, Any]) -> Optional[Any]:
        for attempt in range(self.retry.retries + 1):
            self.limiter.wait()
            try:
                r = self.sess.post(self.info_url, json=payload, timeout=self.retry.timeout_s)

                if r.status_code == 200:
                    try:
                        out = r.json()
                        self.limiter.note_ok()
                        return out
                    except Exception as e:
                        self.limiter.note_error()
                        if self.debug:
                            print(f"[WARN] JSON parse error on {payload.get('type')}: {e}")
                            print(f"       body={r.text[:200]!r}")
                        if attempt < self.retry.retries:
                            self._sleep_backoff(attempt)
                            continue
                        return None

                if r.status_code in (429, 500, 502, 503, 504):
                    self.limiter.note_error()
                    if self.debug:
                        print(f"[WARN] HTTP {r.status_code} on {payload.get('type')} attempt {attempt+1}/{self.retry.retries+1}")
                        print(f"       {r.text[:200]}")
                    if attempt < self.retry.retries:
                        self._sleep_backoff(attempt)
                        continue
                    return None

                self.limiter.note_ok()
                if self.debug:
                    print(f"[ERROR] HTTP {r.status_code} on {payload.get('type')}")
                    print(f"        {r.text[:300]}")
                return None

            except Exception as e:
                self.limiter.note_error()
                if self.debug:
                    print(f"[WARN] Exception on {payload.get('type')}: {e} attempt {attempt+1}/{self.retry.retries+1}")
                if attempt < self.retry.retries:
                    self._sleep_backoff(attempt)
                    continue
                return None

        return None

    def _get_json(self, url: str) -> Optional[Any]:
        for attempt in range(self.retry.retries + 1):
            self.limiter.wait()
            try:
                r = self.sess.get(url, timeout=self.retry.timeout_s)
                if r.status_code == 200:
                    try:
                        out = r.json()
                        self.limiter.note_ok()
                        return out
                    except Exception:
                        self.limiter.note_error()
                        if attempt < self.retry.retries:
                            self._sleep_backoff(attempt)
                            continue
                        return None

                if r.status_code in (429, 500, 502, 503, 504):
                    self.limiter.note_error()
                    if self.debug:
                        print(f"[WARN] GET {url} HTTP {r.status_code} attempt {attempt+1}/{self.retry.retries+1}")
                    if attempt < self.retry.retries:
                        self._sleep_backoff(attempt)
                        continue
                    return None

                self.limiter.note_ok()
                if self.debug:
                    print(f"[ERROR] GET {url} HTTP {r.status_code}: {r.text[:200]}")
                return None

            except Exception as e:
                self.limiter.note_error()
                if self.debug:
                    print(f"[WARN] GET exception: {e}")
                if attempt < self.retry.retries:
                    self._sleep_backoff(attempt)
                    continue
                return None
        return None

    def get_leaderboard(self) -> Optional[Any]:
        return self._get_json(self.leaderboard_url)

    def all_mids(self) -> Dict[str, float]:
        data = self._post_json({"type": "allMids", "dex": ""})
        mids: Dict[str, float] = {}
        if isinstance(data, dict):
            for k, v in data.items():
                if isinstance(k, str) and not k.startswith("@"):
                    mids[k] = to_float(v, 0.0)
        return mids

    def clearinghouse_state(self, user: str) -> Optional[Dict[str, Any]]:
        data = self._post_json({"type": "clearinghouseState", "user": user, "dex": ""})
        return data if isinstance(data, dict) else None

    def batch_clearinghouse_states_adaptive(
        self,
        users: List[str],
        batch_size: int = 25,
        min_batch_size: int = 5,
        fallback_per_user: bool = True,
        progress: bool = True,
    ) -> Tuple[Dict[str, Dict[str, Any]], List[str]]:
        states: Dict[str, Dict[str, Any]] = {}
        failed: List[str] = []

        parts = list(chunks(users, batch_size))
        for pi, part in enumerate(parts, 1):
            if progress:
                print(f"  - batchClearinghouseStates {pi}/{len(parts)} (n={len(part)})")

            resp = self._post_json({"type": "batchClearinghouseStates", "users": part, "dex": ""})

            if isinstance(resp, list) and len(resp) == len(part):
                for addr, st in zip(part, resp):
                    if isinstance(st, dict):
                        states[addr] = st
                    else:
                        failed.append(addr)
                continue

            # split and retry smaller
            if len(part) > min_batch_size:
                mid = len(part) // 2
                left = part[:mid]
                right = part[mid:]

                sub_states, sub_failed = self.batch_clearinghouse_states_adaptive(
                    left,
                    batch_size=max(min_batch_size, len(left)),
                    min_batch_size=min_batch_size,
                    fallback_per_user=fallback_per_user,
                    progress=False,
                )
                states.update(sub_states)
                failed.extend(sub_failed)

                sub_states, sub_failed = self.batch_clearinghouse_states_adaptive(
                    right,
                    batch_size=max(min_batch_size, len(right)),
                    min_batch_size=min_batch_size,
                    fallback_per_user=fallback_per_user,
                    progress=False,
                )
                states.update(sub_states)
                failed.extend(sub_failed)
                continue

            # smallest chunk: per-user fallback
            if fallback_per_user:
                for addr in part:
                    st = self.clearinghouse_state(addr)
                    if st:
                        states[addr] = st
                    else:
                        failed.append(addr)
            else:
                failed.extend(part)

        failed = [a for a in dedupe_keep_order(failed) if a not in states]
        return states, failed

    def user_fills(self, user: str) -> Optional[List[Dict[str, Any]]]:
        data = self._post_json({"type": "userFills", "user": user})
        return data if isinstance(data, list) else None

    def portfolio(self, user: str) -> Optional[Any]:
        return self._post_json({"type": "portfolio", "user": user})


# ----------------------------
# Data extraction / scoring
# ----------------------------

@dataclass
class PositionView:
    coin: str
    side: str
    size: float
    entry_px: float
    mid_px: Optional[float]
    position_value: float
    unrealized_pnl: float
    roe_pct: Optional[float]
    leverage: float
    liquidation_px: Optional[float]
    margin_used: float
    notional_pct_equity: Optional[float]
    liq_distance_pct: Optional[float]
    age_days: Optional[float] = None


def extract_account_value(state: Dict[str, Any]) -> float:
    ms = state.get("marginSummary") or {}
    return to_float(ms.get("accountValue"), 0.0)


def extract_positions(state: Dict[str, Any], account_value: float, mids: Dict[str, float]) -> List[PositionView]:
    out: List[PositionView] = []
    aps = state.get("assetPositions") or []
    if not isinstance(aps, list):
        return out

    for ap in aps:
        if not isinstance(ap, dict):
            continue
        pos = ap.get("position") or {}
        if not isinstance(pos, dict):
            continue

        szi = to_float(pos.get("szi"), 0.0)
        if abs(szi) < 1e-12:
            continue

        coin = str(pos.get("coin") or "Unknown")
        entry = to_float(pos.get("entryPx"), 0.0)
        pv = to_float(pos.get("positionValue"), 0.0)
        upnl = to_float(pos.get("unrealizedPnl"), 0.0)

        roe_raw = pos.get("returnOnEquity")
        roe_pct = to_float(roe_raw, 0.0) * 100.0 if roe_raw is not None else None

        lev = 0.0
        lev_obj = pos.get("leverage") or {}
        if isinstance(lev_obj, dict):
            lev = to_float(lev_obj.get("value"), 0.0)

        liq = pos.get("liquidationPx")
        liq_px = None if liq in (None, "") else to_float(liq, 0.0)

        margin_used = to_float(pos.get("marginUsed"), 0.0)
        side = "LONG" if szi > 0 else "SHORT"

        mid = mids.get(coin)
        mid_px = mid if mid and mid > 0 else None

        notional_pct_equity = (abs(pv) / account_value * 100.0) if account_value > 0 else None

        liq_distance_pct = None
        if mid_px and liq_px and mid_px > 0:
            liq_distance_pct = abs(mid_px - liq_px) / mid_px * 100.0

        out.append(
            PositionView(
                coin=coin,
                side=side,
                size=szi,
                entry_px=entry,
                mid_px=mid_px,
                position_value=pv,
                unrealized_pnl=upnl,
                roe_pct=roe_pct,
                leverage=lev,
                liquidation_px=liq_px,
                margin_used=margin_used,
                notional_pct_equity=notional_pct_equity,
                liq_distance_pct=liq_distance_pct,
                age_days=None,
            )
        )

    return out


def last_trade_time_from_fills(fills: Optional[List[Dict[str, Any]]]) -> Optional[datetime]:
    # FIX: don’t assume fills are sorted; take max timestamp
    if not fills:
        return None
    best: Optional[int] = None
    for f in fills:
        t_ms = f.get("time")
        if t_ms is None:
            continue
        try:
            t_int = int(t_ms)
        except Exception:
            continue
        if best is None or t_int > best:
            best = t_int
    if best is None:
        return None
    return datetime.fromtimestamp(best / 1000, tz=timezone.utc)


def infer_position_ages_from_fills(fills: List[Dict[str, Any]], positions: List[PositionView]) -> Dict[str, float]:
    now = utcnow()
    needed = {p.coin for p in positions}
    cur_by_coin = {p.coin: p.size for p in positions}
    by_coin: Dict[str, List[Dict[str, Any]]] = {}

    for f in fills:
        coin = f.get("coin")
        if isinstance(coin, str) and coin in needed:
            by_coin.setdefault(coin, []).append(f)

    ages: Dict[str, float] = {}
    eps = 1e-10

    for coin, fs in by_coin.items():
        fs_sorted = sorted(fs, key=lambda x: int(x.get("time", 0)))
        open_time: Optional[datetime] = None

        for f in fs_sorted:
            t_ms = f.get("time")
            if t_ms is None:
                continue
            ts = datetime.fromtimestamp(int(t_ms) / 1000, tz=timezone.utc)

            start_pos = to_float(f.get("startPosition"), 0.0)
            side = f.get("side")  # "B" buy, "A" sell
            sz = to_float(f.get("sz"), 0.0)
            delta = sz if side == "B" else -sz
            end_pos = start_pos + delta

            if abs(start_pos) < eps and abs(end_pos) > eps:
                open_time = ts
            if abs(end_pos) < eps:
                open_time = None
            if start_pos * end_pos < 0:
                open_time = ts

        cur_size = cur_by_coin.get(coin, 0.0)
        if abs(cur_size) < eps:
            continue

        if open_time is None and fs_sorted:
            t_ms = fs_sorted[0].get("time")
            if t_ms is not None:
                open_time = datetime.fromtimestamp(int(t_ms) / 1000, tz=timezone.utc)

        if open_time is not None:
            ages[coin] = (now - open_time).total_seconds() / 86400.0

    return ages


def parse_portfolio_windows(portfolio_resp: Any) -> Dict[str, Dict[str, Any]]:
    """
    portfolio response is typically: [ [window, {accountValueHistory, pnlHistory, vlm}], ... ]
    Windows include: day/week/month/allTime and perpDay/perpWeek/perpMonth/perpAllTime.
    Values are strings. Volume key is `vlm`. (We keep output key name `volume` unchanged.)
    """
    out: Dict[str, Dict[str, Any]] = {}

    # Accept either list-of-tuples OR dict mapping (defensive)
    items: List[Tuple[str, Any]] = []
    if isinstance(portfolio_resp, list):
        for item in portfolio_resp:
            if isinstance(item, (list, tuple)) and len(item) == 2 and isinstance(item[0], str):
                items.append((item[0], item[1]))
    elif isinstance(portfolio_resp, dict):
        for k, v in portfolio_resp.items():
            if isinstance(k, str):
                items.append((k, v))
    else:
        return out

    for window, data in items:
        if not isinstance(window, str) or not isinstance(data, dict):
            continue

        avh = data.get("accountValueHistory") or []
        pnlh = data.get("pnlHistory") or []

        av_points: List[Tuple[int, float]] = []
        pnl_points: List[Tuple[int, float]] = []

        if isinstance(avh, list):
            for p in avh:
                if isinstance(p, list) and len(p) == 2:
                    av_points.append((int(p[0]), to_float(p[1], 0.0)))
        if isinstance(pnlh, list):
            for p in pnlh:
                if isinstance(p, list) and len(p) == 2:
                    pnl_points.append((int(p[0]), to_float(p[1], 0.0)))

        # FIX: Hyperliquid uses `vlm` (string). Keep output key name `volume`.
        vol_raw = data.get("vlm")
        if vol_raw is None:
            vol_raw = data.get("volume")  # fallback if any mirror uses different key

        out[window] = {"account_values": av_points, "pnls": pnl_points, "volume": to_float(vol_raw, 0.0)}

    # Optional aliasing: if allTime missing but perpAllTime exists, expose under allTime
    # (does NOT change your JSON schema; it only helps avoid empty allTime in edge cases)
    if "allTime" not in out and "perpAllTime" in out:
        out["allTime"] = out["perpAllTime"]

    return out


def window_return_metrics(win: Dict[str, Any], baseline_eps: float = 1e-9) -> Dict[str, Optional[float]]:
    """
    FIX: Hyperliquid accountValueHistory can start at 0.0 (strings) — dividing by the first point yields null.
    We compute growth/pnl% using the first positive baseline value instead, preserving output keys.
    """
    av = win.get("account_values") or []
    pnls = win.get("pnls") or []

    if not av or len(av) < 2:
        return {"growth_pct": None, "pnl_pct": None, "vol_pct_daily": None, "max_drawdown_pct": None}

    # Ensure chronological order
    av_sorted = sorted(((int(ts), float(v)) for ts, v in av), key=lambda x: x[0])
    av_vals = [v for _, v in av_sorted]

    # Find first usable (positive) baseline
    base_idx: Optional[int] = None
    for i, v in enumerate(av_vals):
        if math.isfinite(v) and v > baseline_eps:
            base_idx = i
            break

    # Compute vol + drawdown ignoring leading zeros / invalids
    slice_start = base_idx if base_idx is not None else 0
    av_slice = [v for v in av_vals[slice_start:] if math.isfinite(v)]

    vol_pct_daily: Optional[float] = None
    if len(av_slice) >= 2:
        rets: List[float] = []
        for i in range(1, len(av_slice)):
            prev = av_slice[i - 1]
            cur = av_slice[i]
            if prev > baseline_eps:
                rets.append((cur - prev) / prev)
        vol = stdev(rets) if len(rets) >= 2 else None
        vol_pct_daily = (vol * 100.0) if vol is not None else None

    mdd = max_drawdown(av_slice) if len(av_slice) >= 2 else None
    max_drawdown_pct = (mdd * 100.0) if mdd is not None else None

    growth_pct: Optional[float] = None
    pnl_pct: Optional[float] = None

    # Compute growth/pnl% vs baseline (first positive av)
    if base_idx is not None and base_idx < len(av_vals) - 1:
        base_ts, base_av = av_sorted[base_idx]
        end_av = av_vals[-1]

        if base_av > baseline_eps:
            growth_pct = (end_av - base_av) / base_av * 100.0

            if pnls and len(pnls) >= 2:
                pnls_sorted = sorted(((int(ts), float(v)) for ts, v in pnls), key=lambda x: x[0])
                end_pnl = pnls_sorted[-1][1]

                # Align baseline pnl to first pnl sample at/after baseline time
                base_pnl: Optional[float] = None
                for ts, pv in pnls_sorted:
                    if ts >= base_ts:
                        base_pnl = pv
                        break
                if base_pnl is None:
                    base_pnl = pnls_sorted[0][1]

                pnl_pct = (end_pnl - base_pnl) / base_av * 100.0

    return {
        "growth_pct": growth_pct,
        "pnl_pct": pnl_pct,
        "vol_pct_daily": vol_pct_daily,
        "max_drawdown_pct": max_drawdown_pct,
    }


def risk_score(account_value: float, positions: List[PositionView]) -> float:
    if account_value <= 0 or not positions:
        return 0.0

    total_margin = sum(p.margin_used for p in positions)
    margin_ratio = min(1.0, total_margin / account_value)

    max_lev = max((p.leverage for p in positions), default=0.0)
    lev_score = min(1.0, max_lev / 50.0)

    liq_dists = [p.liq_distance_pct for p in positions if p.liq_distance_pct is not None]
    liq_score = 0.25
    if liq_dists:
        closest = min(liq_dists)
        liq_score = 1.0 - min(1.0, closest / 50.0)

    score = 100.0 * (0.40 * margin_ratio + 0.30 * lev_score + 0.30 * liq_score)
    return max(0.0, min(100.0, score))


def style_label(risk: float, vol_pct_daily: Optional[float], mdd_pct: Optional[float]) -> str:
    v = vol_pct_daily if vol_pct_daily is not None else 0.0
    d = mdd_pct if mdd_pct is not None else 0.0
    if risk >= 70 or v >= 5.0 or d >= 25.0:
        return "aggressive"
    if risk >= 40 or v >= 2.0 or d >= 12.0:
        return "balanced"
    return "stable"


def extract_addresses_from_leaderboard(lb: Any, top_n: int) -> List[str]:
    entries: Any = None

    if isinstance(lb, list):
        entries = lb
    elif isinstance(lb, dict):
        for k in ("leaderboard", "data", "traders", "users", "result"):
            if isinstance(lb.get(k), list):
                entries = lb.get(k)
                break
        if entries is None:
            vals = list(lb.values())
            if vals and isinstance(vals[0], list):
                entries = vals[0]

    if not isinstance(entries, list):
        return []

    out: List[str] = []
    for e in entries[:top_n]:
        addr: Optional[str] = None
        if isinstance(e, str):
            addr = e
        elif isinstance(e, dict):
            for key in ("ethAddress", "address", "user", "wallet"):
                v = e.get(key)
                if isinstance(v, str):
                    addr = v
                    break
        if not addr:
            continue
        addr = addr.strip().lower()
        if is_eth_address(addr):
            out.append(addr)

    return dedupe_keep_order(out)


def compute_rank_scores(wallet: Dict[str, Any]) -> Dict[str, float]:
    r = float(wallet.get("risk_score") or 0.0)
    exposure = float(wallet.get("exposure_pct") or 0.0)

    port = wallet.get("portfolio") or {}
    m = port.get("month") if isinstance(port, dict) else None
    w = port.get("week") if isinstance(port, dict) else None
    a = port.get("allTime") if isinstance(port, dict) else None

    m = m if isinstance(m, dict) else {}
    w = w if isinstance(w, dict) else {}
    a = a if isinstance(a, dict) else {}

    pnl_val: Optional[float] = m.get("pnl_pct")
    if pnl_val is None:
        pnl_val = w.get("pnl_pct")
    if pnl_val is None:
        pnl_val = a.get("pnl_pct")
    pnl = float(pnl_val or 0.0)

    vol = float(m.get("vol_pct_daily") or 0.0)
    mdd = float(m.get("max_drawdown_pct") or 0.0)
    stability = max(0.0, 100.0 - (vol * 10.0) - (mdd * 2.0))

    # ensure ages is List[float], never contains None/Unknown
    positions = wallet.get("positions") or []
    ages: List[float] = []
    if isinstance(positions, list):
        for p in positions:
            if not isinstance(p, dict):
                continue
            ad = p.get("age_days")
            if isinstance(ad, (int, float)) and math.isfinite(float(ad)):
                ages.append(float(ad))

    avg_age = (sum(ages) / len(ages)) if ages else 0.0
    conviction = (avg_age * 2.0) + (exposure * 0.5) - (r * 0.5)

    return {"risk": r, "pnl": pnl, "stability": stability, "conviction": conviction}


def apply_ranks(wallets: List[Dict[str, Any]]) -> None:
    for w in wallets:
        w["rank_scores"] = compute_rank_scores(w)

    ranks: Dict[str, Dict[str, int]] = {k: {} for k in ("risk", "pnl", "stability", "conviction")}
    for key in ranks.keys():
        ordered = sorted(wallets, key=lambda x: float((x.get("rank_scores") or {}).get(key) or 0.0), reverse=True)
        for i, w in enumerate(ordered, 1):
            ranks[key][w["address"]] = i

    for w in wallets:
        w["ranks"] = {k: ranks[k].get(w["address"]) for k in ranks.keys()}


def build_output(mode_name: str, wallets: List[Dict[str, Any]], base_meta: Dict[str, Any]) -> Dict[str, Any]:
    return {**base_meta, "mode": mode_name, "wallets": wallets}


def sort_wallets(wallets: List[Dict[str, Any]], by: str) -> List[Dict[str, Any]]:
    by = by.lower()
    if by in ("risk", "pnl", "stability", "conviction"):
        return sorted(wallets, key=lambda w: float((w.get("rank_scores") or {}).get(by) or 0.0), reverse=True)
    if by == "account_value":
        return sorted(wallets, key=lambda w: float(w.get("account_value") or 0.0), reverse=True)
    return wallets


def main() -> int:
    ap = argparse.ArgumentParser(description="Hyperliquid Whale Scanner -> JSON snapshots for GitHub Pages")
    ap.add_argument("--auto-find", action="store_true", help="Auto-discover addresses from leaderboard")
    ap.add_argument("--top-n", type=int, default=200, help="How many leaderboard entries to consider")
    ap.add_argument("--min-value", type=float, default=50_000, help="Minimum account value (USD)")
    ap.add_argument("--active-days", type=int, default=14, help="Active if last trade within N days")
    ap.add_argument("--mode", choices=["active", "inactive", "both"], default="active", help="Which sets to export")
    ap.add_argument("--batch-size", type=int, default=25, help="batchClearinghouseStates users per request")
    ap.add_argument("--min-batch-size", type=int, default=5, help="Adaptive splitting stops at this size")
    ap.add_argument("--addresses", nargs="*", default=[], help="Explicit addresses (0x...) to include")
    ap.add_argument("--file", type=str, help="Text file with addresses (one per line)")
    ap.add_argument("--out-dir", type=str, default="data", help="Output directory (committed to GitHub Pages)")
    ap.add_argument("--limit", type=int, default=0, help="Limit number of candidates after filters (0 = no limit)")
    ap.add_argument("--no-portfolio", action="store_true", help="Skip portfolio endpoint (faster; no pnl/stability)")
    ap.add_argument("--timeout", type=int, default=20, help="HTTP timeout seconds")
    ap.add_argument("--retries", type=int, default=4, help="Retry count for 429/5xx")
    ap.add_argument("--throttle", type=float, default=0.18, help="Min seconds between requests")
    ap.add_argument("--debug", action="store_true", help="Verbose HTTP errors / debug logs")
    args = ap.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    retry_cfg = RetryCfg(retries=args.retries, timeout_s=args.timeout)
    limiter = RateLimiter(min_interval_s=max(0.05, float(args.throttle)), max_interval_s=1.2)
    client = HLClient(retry=retry_cfg, limiter=limiter, debug=args.debug)

    # addresses
    addrs: List[str] = [a.lower().strip() for a in args.addresses if isinstance(a, str)]
    addrs = [a for a in addrs if is_eth_address(a)]

    if args.file:
        try:
            with open(args.file, "r", encoding="utf-8") as f:
                for line in f:
                    s = line.strip()
                    if not s or s.startswith("#"):
                        continue
                    s = s.lower()
                    if is_eth_address(s):
                        addrs.append(s)
        except Exception as e:
            print(f"[ERROR] reading --file: {e}", file=sys.stderr)

    if args.auto_find:
        print(f"🔍 Fetch leaderboard (top {args.top_n})")
        lb = client.get_leaderboard()
        if lb is None:
            print("❌ Failed to fetch leaderboard.", file=sys.stderr)
            return 2
        lb_addrs = extract_addresses_from_leaderboard(lb, args.top_n)
        if not lb_addrs:
            print("❌ Leaderboard returned no valid addresses.", file=sys.stderr)
            return 2
        addrs.extend(lb_addrs)

    addrs = dedupe_keep_order(addrs)
    if not addrs:
        print("❌ No addresses provided. Use --auto-find or --addresses/--file.", file=sys.stderr)
        return 2

    print(f"✅ Addresses collected: {len(addrs)}")

    # mids
    print("💱 Fetch all mids")
    mids = client.all_mids()
    if not mids:
        print("❌ allMids failed or returned empty.", file=sys.stderr)
        return 2

    # states
    print(f"📦 Fetch clearinghouse states (adaptive batch size={args.batch_size})")
    states_by_user, failed_states = client.batch_clearinghouse_states_adaptive(
        addrs,
        batch_size=args.batch_size,
        min_batch_size=args.min_batch_size,
        fallback_per_user=True,
        progress=True,
    )
    print(f"✅ States fetched: {len(states_by_user)}/{len(addrs)} | Failed: {len(failed_states)}")

    # candidates
    candidates: List[str] = []
    positions_by_user: Dict[str, List[PositionView]] = {}
    account_value_by_user: Dict[str, float] = {}

    for addr, st in states_by_user.items():
        av = extract_account_value(st)
        if av < args.min_value:
            continue
        pos = extract_positions(st, av, mids)
        if not pos:
            continue
        candidates.append(addr)
        positions_by_user[addr] = pos
        account_value_by_user[addr] = av

    candidates = dedupe_keep_order(candidates)
    if args.limit and args.limit > 0:
        candidates = candidates[: args.limit]

    print(f"🐋 Candidates after min-value+positions filter: {len(candidates)}")
    if not candidates:
        base_meta = {
            "generated_at_utc": utcnow().isoformat(),
            "generated_at_epoch_ms": int(time.time() * 1000),
            "active_days": args.active_days,
            "min_value": args.min_value,
            "notes": {"no_candidates": True},
            "failed_states": failed_states,
        }
        empty_out = build_output(args.mode, [], base_meta)
        atomic_write_json(out_dir / f"{args.mode}_all.json", empty_out)
        atomic_write_json(out_dir / "meta.json", {**base_meta, "files": [f"{args.mode}_all.json"]})
        return 0

    # fills
    active_cutoff = utcnow().timestamp() - (args.active_days * 86400)
    last_trade: Dict[str, Optional[datetime]] = {}
    failed_fills: List[str] = []

    print(f"🧾 Fetch userFills for {len(candidates)} wallets (activity + age)")
    for i, addr in enumerate(candidates, 1):
        fs = client.user_fills(addr)
        if fs is None:
            failed_fills.append(addr)
            last_trade[addr] = None
        else:
            last_trade[addr] = last_trade_time_from_fills(fs)
            ages = infer_position_ages_from_fills(fs, positions_by_user[addr])
            for p in positions_by_user[addr]:
                if p.coin in ages:
                    p.age_days = ages[p.coin]

        if i % 20 == 0 or i == len(candidates):
            print(f"  ...fills {i}/{len(candidates)}")

    def is_active(addr: str) -> bool:
        lt = last_trade.get(addr)
        if lt is None:
            return False
        return lt.timestamp() >= active_cutoff

    active_addrs = [a for a in candidates if is_active(a)]
    inactive_addrs = [a for a in candidates if not is_active(a)]
    print(f"✅ Active: {len(active_addrs)} | Inactive: {len(inactive_addrs)}")

    def wallet_obj(addr: str) -> Dict[str, Any]:
        av = account_value_by_user.get(addr, 0.0)
        pos = positions_by_user.get(addr, [])
        total_pv = sum(abs(p.position_value) for p in pos)
        total_upnl = sum(p.unrealized_pnl for p in pos)
        total_margin = sum(p.margin_used for p in pos)
        exposure_pct = (total_pv / av * 100.0) if av > 0 else None
        margin_pct = (total_margin / av * 100.0) if av > 0 else None
        max_lev = max((p.leverage for p in pos), default=0.0)
        min_liq_dist = min((p.liq_distance_pct for p in pos if p.liq_distance_pct is not None), default=None)

        return {
            "address": addr,
            "account_value": av,
            "last_trade_utc": iso_utc(last_trade.get(addr)),
            "positions": [asdict(p) for p in pos],
            "num_positions": len(pos),
            "total_position_value": total_pv,
            "total_unrealized_pnl": total_upnl,
            "total_margin_used": total_margin,
            "exposure_pct": exposure_pct,
            "margin_pct": margin_pct,
            "max_leverage": max_lev,
            "min_liq_distance_pct": min_liq_dist,
            "portfolio": {"month": None, "week": None, "allTime": None},
            "risk_score": 0.0,
            "style": "unknown",
        }

    wallets_active = [wallet_obj(a) for a in active_addrs]
    wallets_inactive = [wallet_obj(a) for a in inactive_addrs]

    def fill_portfolio(wallets: List[Dict[str, Any]]) -> None:
        if args.no_portfolio:
            return
        print(f"📈 Fetch portfolio for {len(wallets)} wallets")
        for i, w in enumerate(wallets, 1):
            addr = w["address"]
            pr = client.portfolio(addr)
            wins = parse_portfolio_windows(pr) if pr is not None else {}

            month = window_return_metrics(wins.get("month", {})) if "month" in wins else None
            week = window_return_metrics(wins.get("week", {})) if "week" in wins else None
            all_time = window_return_metrics(wins.get("allTime", {})) if "allTime" in wins else None

            w["portfolio"] = {"month": month, "week": week, "allTime": all_time}

            if i % 20 == 0 or i == len(wallets):
                print(f"  ...portfolio {i}/{len(wallets)}")

    if args.mode in ("active", "both"):
        fill_portfolio(wallets_active)
    if args.mode in ("inactive", "both"):
        fill_portfolio(wallets_inactive)

    def finalize_wallets(wallets: List[Dict[str, Any]]) -> None:
        for w in wallets:
            av = float(w.get("account_value") or 0.0)
            pos = w.get("positions") or []
            pos_objs = [PositionView(**p) for p in pos if isinstance(p, dict)]
            r = risk_score(av, pos_objs)

            m = (w.get("portfolio") or {}).get("month") or {}
            v = m.get("vol_pct_daily") if isinstance(m, dict) else None
            d = m.get("max_drawdown_pct") if isinstance(m, dict) else None

            w["risk_score"] = r
            w["style"] = style_label(r, v, d)

    written_files: List[str] = []

    def write_mode_files(mode_name: str, wallets: List[Dict[str, Any]], base_meta: Dict[str, Any]) -> None:
        nonlocal written_files
        all_out = build_output(mode_name, wallets, base_meta)
        name_all = f"{mode_name}_all.json"
        atomic_write_json(out_dir / name_all, all_out)
        written_files.append(name_all)

        for rank_by in ("risk", "pnl", "stability", "conviction"):
            sorted_wallets = sort_wallets(wallets, rank_by)
            out = {**build_output(mode_name, sorted_wallets, base_meta), "rank_by": rank_by}
            fn = f"{mode_name}_{rank_by}.json"
            atomic_write_json(out_dir / fn, out)
            written_files.append(fn)

    base_meta = {
        "generated_at_utc": utcnow().isoformat(),
        "generated_at_epoch_ms": int(time.time() * 1000),
        "active_days": args.active_days,
        "min_value": args.min_value,
        "source": {"info_url": client.info_url, "leaderboard_url": client.leaderboard_url},
        "notes": {
            "pnl_pct_and_growth_pct_are_approx": (not args.no_portfolio),
            "reason": "Computed from portfolio accountValueHistory/pnlHistory deltas divided by start account value.",
        },
        "failed_states": failed_states,
        "failed_fills": failed_fills,
    }

    if args.mode in ("active", "both"):
        finalize_wallets(wallets_active)
        apply_ranks(wallets_active)
        write_mode_files("active", wallets_active, base_meta)

    if args.mode in ("inactive", "both"):
        finalize_wallets(wallets_inactive)
        apply_ranks(wallets_inactive)
        write_mode_files("inactive", wallets_inactive, base_meta)

    meta = {**base_meta, "files": written_files}
    atomic_write_json(out_dir / "meta.json", meta)

    print("\n✅ DONE")
    print(f"Output dir: {out_dir.resolve()}")
    for f in written_files:
        print(f" - {f}")
    print(" - meta.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
