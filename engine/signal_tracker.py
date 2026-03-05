"""SQLite-backed signal history and P&L tracker.

Signals are stored when detected. Settlement is resolved by checking the
Polymarket Gamma API for closed markets and computing realized P&L:
  - BUY POLY NO  (short_vol / skew_arb): pnl = poly_prob - settlement_price
  - BUY POLY YES (the_pin):              pnl = settlement_price - poly_prob

where settlement_price is 1.0 (YES resolved) or 0.0 (NO resolved).
"""

import asyncio
import json
import logging
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

DB_PATH = Path(__file__).parent.parent / "data" / "signals.db"


def _init_db() -> None:
    DB_PATH.parent.mkdir(exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS signals (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            detected_at     TEXT    NOT NULL,
            strategy        TEXT    NOT NULL,
            asset           TEXT    NOT NULL,
            strike          REAL    NOT NULL,
            direction       TEXT    NOT NULL,
            edge_pct        REAL    NOT NULL,
            synth_prob      REAL,
            derive_prob     REAL,
            poly_prob       REAL,
            confidence      TEXT,
            kelly_fraction  REAL    DEFAULT 0.0,
            poly_question   TEXT    DEFAULT '',
            poly_url        TEXT    DEFAULT '',
            poly_expiry     TEXT    DEFAULT '',
            settled_at      TEXT,
            settlement_price REAL,
            pnl             REAL
        )
    """)
    conn.commit()
    conn.close()


# Initialise on import
try:
    _init_db()
except Exception as e:
    logger.warning("signal_tracker: DB init failed: %s", e)


# ── Sync helpers (run in executor) ──────────────────────────────────────────

def _save_signals_sync(signals: List[Dict]) -> int:
    """Persist new signals; skip duplicates within the same hour."""
    if not signals:
        return 0
    conn = sqlite3.connect(DB_PATH)
    now = datetime.now(timezone.utc).isoformat()
    saved = 0
    for s in signals:
        # Deduplicate: same strategy+asset+strike+expiry detected in the same hour
        cur = conn.execute(
            """SELECT id FROM signals
               WHERE strategy=? AND asset=? AND strike=? AND poly_expiry=?
               AND detected_at > datetime(?, '-1 hour')""",
            (s["strategy"], s["asset"], s["strike"],
             s.get("poly_expiry", ""), now),
        )
        if cur.fetchone():
            continue
        conn.execute(
            """INSERT INTO signals
               (detected_at, strategy, asset, strike, direction, edge_pct,
                synth_prob, derive_prob, poly_prob, confidence, kelly_fraction,
                poly_question, poly_url, poly_expiry)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                now,
                s["strategy"], s["asset"], s["strike"], s["direction"],
                s["edge_pct"], s.get("synth_prob"), s.get("derive_prob"),
                s.get("poly_prob"), s.get("confidence"),
                s.get("kelly_fraction", 0.0),
                s.get("poly_question", ""), s.get("poly_url", ""),
                s.get("poly_expiry", ""),
            ),
        )
        saved += 1
    conn.commit()
    conn.close()
    return saved


def _get_history_sync(limit: int) -> List[Dict]:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT * FROM signals ORDER BY detected_at DESC LIMIT ?", (limit,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def _get_pnl_sync() -> Dict:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    summary_row = conn.execute("""
        SELECT
            COUNT(*)                                           AS total_signals,
            SUM(CASE WHEN pnl IS NOT NULL THEN 1 ELSE 0 END)  AS settled_count,
            SUM(CASE WHEN pnl > 0          THEN 1 ELSE 0 END)  AS wins,
            SUM(CASE WHEN pnl <= 0         THEN 1 ELSE 0 END)  AS losses,
            AVG(pnl)                                           AS avg_pnl,
            SUM(pnl)                                           AS total_pnl,
            AVG(edge_pct)                                      AS avg_edge_pct
        FROM signals
    """).fetchone()

    by_strategy = {}
    for row in conn.execute("""
        SELECT strategy,
               COUNT(*)                                            AS total,
               SUM(CASE WHEN pnl IS NOT NULL THEN 1 ELSE 0 END)   AS settled,
               SUM(CASE WHEN pnl > 0          THEN 1 ELSE 0 END)  AS wins,
               AVG(pnl)                                            AS avg_pnl,
               SUM(pnl)                                            AS total_pnl,
               AVG(edge_pct)                                       AS avg_edge
        FROM signals
        GROUP BY strategy
    """).fetchall():
        by_strategy[row["strategy"]] = dict(row)

    conn.close()
    return {
        "summary": dict(summary_row) if summary_row else {},
        "by_strategy": by_strategy,
    }


def _resolve_settlements_sync(settlements: List[Dict]) -> int:
    """
    Apply settlement results to open signals.
    Each settlement: {poly_url, settlement_price (0.0 or 1.0)}.
    P&L per signal:
      BUY POLY YES → pnl = settlement_price - poly_prob
      BUY POLY NO  → pnl = poly_prob - settlement_price
    """
    if not settlements:
        return 0
    conn = sqlite3.connect(DB_PATH)
    now = datetime.now(timezone.utc).isoformat()
    updated = 0
    for item in settlements:
        url = item["poly_url"]
        price = float(item["settlement_price"])
        rows = conn.execute(
            "SELECT id, direction, poly_prob FROM signals WHERE poly_url=? AND pnl IS NULL",
            (url,),
        ).fetchall()
        for row_id, direction, poly_prob in rows:
            if poly_prob is None:
                continue
            pnl = (price - poly_prob) if "BUY POLY YES" in direction else (poly_prob - price)
            conn.execute(
                "UPDATE signals SET settled_at=?, settlement_price=?, pnl=? WHERE id=?",
                (now, price, round(pnl, 4), row_id),
            )
            updated += 1
    conn.commit()
    conn.close()
    return updated


def _get_unsettled_expiries_sync() -> List[Dict]:
    """Return (poly_url, poly_expiry) for signals that may now be settled."""
    now_iso = datetime.now(timezone.utc).isoformat()
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        """SELECT DISTINCT poly_url, poly_expiry FROM signals
           WHERE pnl IS NULL
             AND poly_url != ''
             AND poly_expiry != ''
             AND poly_expiry < ?""",
        (now_iso,),
    ).fetchall()
    conn.close()
    return [{"poly_url": r[0], "poly_expiry": r[1]} for r in rows]


# ── Async public API ─────────────────────────────────────────────────────────

async def save_signals(signals: List[Dict]) -> int:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _save_signals_sync, signals)


async def get_history(limit: int = 200) -> List[Dict]:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _get_history_sync, limit)


async def get_pnl() -> Dict:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _get_pnl_sync)


async def resolve_settlements(settlements: List[Dict]) -> int:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _resolve_settlements_sync, settlements)


async def get_unsettled_expiries() -> List[Dict]:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _get_unsettled_expiries_sync)
