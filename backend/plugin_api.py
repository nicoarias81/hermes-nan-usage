"""NaN usage metrics — backend API routes.

Mounted at ``/api/plugins/nan-usage/`` once the plugin is in ``plugins.enabled``.
Aggregates NaN subscription data (quota + daily usage) with local Hermes signals
(state.db session usage, 429 rate-limit events in agent.log) into one snapshot.
Read-only everywhere: NaN HTTP GETs, state.db opened read-only, logs tailed.
The API key is read from the environment and never returned to clients.

Routes:
    GET /overview            everything below, assembled + cached per section
    GET /daily?days=30       raw daily series (tokens + api_requests per model)
"""

from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from fastapi import APIRouter, HTTPException

_log = logging.getLogger(__name__)
router = APIRouter()

QUOTA_URL = "https://cloud-api.nan.builders/api/usage/quota"
USAGE_URL = "https://api.nan.builders/v1/usage"
IMAGE_MODELS = ("flux", "qwen-image")

# ── plumbing ────────────────────────────────────────────────────────────────

def _hermes_home() -> Path:
    try:
        from hermes_constants import get_hermes_home
        return get_hermes_home()
    except Exception:
        env = os.environ.get("HERMES_HOME")
        if env:
            return Path(env)
        local = Path(os.path.expanduser("~")) / "AppData" / "Local" / "hermes"
        if local.exists():
            return local
        return Path(os.path.expanduser("~")) / ".hermes"


def _api_key() -> str | None:
    for name in ("HERMES_CUSTOM_NAN_API_KEY", "NAN_API_KEY"):
        val = os.environ.get(name)
        if val:
            return val.strip()
    return None


def _http_get_json(url: str, key: str, timeout: float = 15.0):
    req = Request(url, headers={
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
        "User-Agent": "hermes-nan-usage-plugin/1.0",
    })
    with urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


# in-memory section cache; TTLs per section (quota/pressure/rps 2min, usage 15min)
_CACHE: dict[str, tuple[float, dict]] = {}


def _cached(section: str, ttl: float, fn):
    now = time.time()
    hit = _CACHE.get(section)
    if hit and hit[0] > now:
        return hit[1]
    try:
        data = fn()
    except Exception as exc:  # never let one section sink the snapshot
        _log.warning("nan-usage section %s failed: %s", section, exc)
        if hit:  # stale beats nothing
            return {**hit[1], "_stale": True}
        return {"error": f"{type(exc).__name__}: {exc}"}
    _CACHE[section] = (now + ttl, data)
    return data


# ── NaN endpoints ───────────────────────────────────────────────────────────

def _fetch_quota() -> dict:
    key = _api_key()
    if not key:
        return {"error": "API key no disponible (HERMES_CUSTOM_NAN_API_KEY / NAN_API_KEY)"}
    raw = _http_get_json(QUOTA_URL, key)
    models = []
    for m in raw.get("models", []):
        cap = m.get("cap") or 0
        used = m.get("tokensUsed") or 0
        models.append({
            "model": m.get("model"),
            "tokensUsed": used,
            "cap": cap,
            "remaining": m.get("remaining"),
            "usedPct": round(used / cap * 100, 1) if cap else None,
            "periodStart": raw.get("periodStart"),
            "periodEnd": m.get("periodEnd"),
            "updatedAt": m.get("updatedAt"),
            "extraTokens": m.get("extraTokens") or 0,
            "extraExpiresAt": m.get("extraExpiresAt"),
            "extraUsable": m.get("extraUsable"),
            "fullWindowTokens": m.get("fullWindowTokens"),
            "windowHours": m.get("windowHours"),
        })
    return {"periodStart": raw.get("periodStart"), "models": models}


def _fetch_usage(days: int) -> dict:
    key = _api_key()
    if not key:
        return {"error": "API key no disponible"}
    end = datetime.now(timezone.utc).date()
    start = end - timedelta(days=max(1, min(90, days)))
    rows, cursor = [], None
    for _ in range(12):  # cursor pagination guard
        params = {"start_date": start.isoformat(), "end_date": end.isoformat()}
        if cursor:
            params["cursor"] = cursor
        page = _http_get_json(f"{USAGE_URL}?{urlencode(params)}", key, timeout=20.0)
        rows.extend(page.get("data", []))
        cursor = page.get("next_cursor")
        if not cursor:
            break
    return {"start": start.isoformat(), "end": end.isoformat(), "rows": rows}


# ── 429 pressure from local logs ────────────────────────────────────────────

_429_RE = re.compile(
    r"^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})[.,]\d+.*?"
    r"Rate limit exceeded for api_key: \S+\. Limit type: (\w+)\. "
    r"Current limit: (\d+), Remaining: (\d+)\. Limit resets at: ([^']+)"
)


def _fetch_pressure() -> dict:
    logs = _hermes_home() / "logs"
    events = []
    files = sorted(logs.glob("agent.log*"))[:6]
    for f in files:
        try:
            with f.open("r", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    if "Rate limit exceeded for api_key" not in line:
                        continue
                    m = _429_RE.search(line)
                    if not m:
                        continue
                    events.append({
                        "ts": f"{m.group(1)} {m.group(2)}",
                        "limitType": m.group(3),
                        "currentLimit": int(m.group(4)),
                        "remaining": int(m.group(5)),
                        "resetsAt": m.group(6),
                        "source": f.name,
                    })
        except OSError:
            continue
    events.sort(key=lambda e: e["ts"])
    now_local = datetime.now()
    def _since(hours: float):
        cut = (now_local - timedelta(hours=hours)).strftime("%Y-%m-%d %H:%M:%S")
        return sum(1 for e in events if e["ts"] >= cut)
    by_day: dict[str, int] = {}
    for e in events:
        d = e["ts"][:10]
        by_day[d] = by_day.get(d, 0) + 1
    last7 = [(now_local - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(6, -1, -1)]
    return {
        "count1h": _since(1), "count24h": _since(24), "count7d": _since(24 * 7),
        "byDay": [{"date": d, "count": by_day.get(d, 0)} for d in last7],
        "last": events[-1] if events else None,
        "total": len(events),
    }


# ── state.db: rps / efficiency / drift ──────────────────────────────────────

def _open_state() -> sqlite3.Connection | None:
    db = _hermes_home() / "state.db"
    if not db.exists():
        return None
    con = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    return con


_NAN_SESSIONS = ("SELECT DISTINCT session_id FROM session_model_usage "
                 "WHERE billing_base_url LIKE '%api.nan.builders%'")


def _fetch_rps(days: int = 7) -> dict:
    con = _open_state()
    if con is None:
        return {"error": "state.db no encontrado"}
    now = time.time()
    rows = con.execute(
        f"SELECT m.timestamp AS ts FROM messages m JOIN ({_NAN_SESSIONS}) s "
        "ON m.session_id = s.session_id WHERE m.role = 'assistant' AND m.timestamp > ?",
        (now - days * 86400,),
    ).fetchall()
    ts = sorted(r["ts"] for r in rows)
    out: dict = {"windowDays": days, "assistantMsgs": len(ts)}
    if ts:
        # per-minute buckets over the last 24h → current pressure
        day1 = [t for t in ts if t >= now - 86400]
        mins: dict[int, int] = {}
        for t in day1:
            mins[int(t // 60)] = mins.get(int(t // 60), 0) + 1
        rates = list(mins.values()) or [0]
        out["maxRpm24h"] = max(rates)
        out["avgRpm24h"] = round(sum(rates) / max(1, len(rates)), 2)
        # 10-min sparkline over the last 24h
        spark = []
        for slot in range(144):
            lo = int((now - (144 - slot) * 600) // 600)
            spark.append(sum(1 for t in day1 if int(t // 600) == lo))
        out["spark24h"] = spark
        # heatmap: 7 days x 24h (local)
        grid = [[0] * 24 for _ in range(days)]
        day_index = {}
        for t in ts:
            d = datetime.fromtimestamp(t)
            idx = (d.date() - datetime.now().date()).days + days - 1
            if 0 <= idx < days:
                grid[idx][d.hour] += 1
        out["heat"] = grid
        out["heatDays"] = [(datetime.now() - timedelta(days=i)).strftime("%m-%d")
                           for i in range(days - 1, -1, -1)]
    return out


def _fetch_efficiency() -> dict:
    con = _open_state()
    if con is None:
        return {"error": "state.db no encontrado"}
    rows = con.execute(
        "SELECT model, SUM(api_call_count) AS calls, SUM(input_tokens) AS inp, "
        "SUM(output_tokens) AS outp, SUM(cache_read_tokens) AS cr, "
        "SUM(cache_write_tokens) AS cw, SUM(reasoning_tokens) AS rz "
        "FROM session_model_usage WHERE billing_base_url LIKE '%api.nan.builders%' "
        "GROUP BY model ORDER BY calls DESC"
    ).fetchall()
    models = []
    for r in rows:
        inp, cr = r["inp"] or 0, r["cr"] or 0
        denom = inp + cr
        models.append({
            "model": r["model"], "calls": r["calls"] or 0, "input": inp,
            "output": r["outp"] or 0, "cacheRead": cr, "cacheWrite": r["cw"] or 0,
            "reasoning": r["rz"] or 0,
            "cacheShare": round(cr / denom * 100, 1) if denom else None,
        })
    return {"models": models}


def _fetch_drift(usage: dict) -> dict:
    """NaN api_requests/dia vs Hermes assistant-msgs/día (estimación de uso externo a Hermes)."""
    if "rows" not in usage:
        return {"error": usage.get("error", "usage no disponible")}
    nan_by_day: dict[str, dict] = {}
    for r in usage["rows"]:
        d = nan_by_day.setdefault(r["date"], {"reqs": 0, "tokens": 0})
        d["reqs"] += r.get("api_requests") or 0
        d["tokens"] += r.get("total_tokens") or 0
    con = _open_state()
    days = sorted(nan_by_day)[-7:]
    hermes: dict[str, int] = {}
    if con is not None and days:
        cut = days[0] + " 00:00:00"
        start = datetime.strptime(cut, "%Y-%m-%d %H:%M:%S").timestamp()
        rows = con.execute(
            f"SELECT m.timestamp AS ts FROM messages m JOIN ({_NAN_SESSIONS}) s "
            "ON m.session_id = s.session_id WHERE m.role = 'assistant' AND m.timestamp >= ?",
            (start,),
        ).fetchall()
        for r in rows:
            d = datetime.fromtimestamp(r["ts"]).strftime("%Y-%m-%d")
            hermes[d] = hermes.get(d, 0) + 1
    out = []
    for d in days:
        n = nan_by_day[d]["reqs"]
        h = hermes.get(d, 0)
        out.append({"date": d, "nanReqs": n, "hermesReqs": h, "externalReqs": n - h,
                    "nanTokens": nan_by_day[d]["tokens"]})
    return {"days": out, "note": "hermesReqs ≈ mensajes assistant; subagentes y canales cuentan como Hermes"}


# ── forecast + image quota ──────────────────────────────────────────────────

def _fetch_forecast(quota: dict, usage: dict) -> dict:
    if "models" not in quota:
        return {"error": quota.get("error", "quota no disponible")}
    req_rate: dict[str, float] = {}
    if "rows" in usage:
        last7 = sorted({r["date"] for r in usage["rows"]})[-7:]
        per_model: dict[str, dict] = {}
        for r in usage["rows"]:
            if r["date"] in last7:
                per_model.setdefault(r["model"], {})[r["date"]] = r.get("total_tokens") or 0
        for m, days in per_model.items():
            vals = [days.get(d, 0) for d in last7]
            req_rate[m] = sum(vals) / max(1, len(vals))
    out = []
    now = datetime.now(timezone.utc)
    for m in quota["models"]:
        if m.get("windowHours"):
            out.append({"model": m["model"], "kind": "rolling",
                        "windowHours": m["windowHours"],
                        "fullWindowTokens": m["fullWindowTokens"],
                        "periodEnd": m["periodEnd"]})
            continue
        rate = req_rate.get(m["model"], 0.0)
        remaining = m.get("remaining")
        if rate > 0 and remaining:
            days_left = remaining / rate
            out.append({"model": m["model"], "kind": "forecast",
                        "dailyTokens": round(rate), "daysToCap": round(days_left, 1),
                        "capDate": (now + timedelta(days=days_left)).strftime("%Y-%m-%d"),
                        "periodEnd": (m.get("periodEnd") or "")[:10]})
        else:
            out.append({"model": m["model"], "kind": "quiet",
                        "dailyTokens": round(rate), "periodEnd": (m.get("periodEnd") or "")[:10]})
    return {"items": out}


def _fetch_images(usage: dict, quota: dict) -> dict:
    cap = 100
    if "rows" not in usage:
        return {"error": usage.get("error", "usage no disponible")}
    pstart = quota.get("periodStart") if "models" in quota else None
    month = pstart[:7] if pstart else None
    reqs: dict[str, int] = {}
    total = 0
    for r in usage["rows"]:
        model = (r.get("model") or "").lower()
        if any(k in model for k in IMAGE_MODELS):
            if month and not r["date"].startswith(month):
                continue
            n = r.get("api_requests") or 0
            reqs[r["model"]] = reqs.get(r["model"], 0) + n
            total += n
    return {"periodMonth": month, "cap": cap, "used": total, "byModel": reqs}


# ── routes ──────────────────────────────────────────────────────────────────

@router.get("/daily")
def daily(days: int = 30):
    return _cached(f"usage:{days}", 900, lambda: _fetch_usage(days))


@router.get("/overview")
def overview():
    quota = _cached("quota", 120, _fetch_quota)
    usage = _cached("usage:30", 900, lambda: _fetch_usage(30))
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "quota": quota,
        "daily": usage,
        "pressure": _cached("pressure", 120, _fetch_pressure),
        "rps": _cached("rps", 120, _fetch_rps),
        "efficiency": _cached("efficiency", 300, _fetch_efficiency),
        "drift": _cached("drift", 900, lambda: _fetch_drift(usage)),
        "forecast": _cached("forecast", 300, lambda: _fetch_forecast(quota, usage)),
        "images": _cached("images", 300, lambda: _fetch_images(usage, quota)),
    }
