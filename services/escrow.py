import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Dict, Set

import aiosqlite
from fastapi import WebSocket

from config import TIMEOUT_CHECK_INTERVAL_SECONDS
from database import DB_PATH

logger = logging.getLogger(__name__)

# WebSocket connections per trade: {trade_id: set of websockets}
connections: Dict[str, Set[WebSocket]] = {}


def register_ws(trade_id: str, ws: WebSocket):
    connections.setdefault(trade_id, set()).add(ws)


def unregister_ws(trade_id: str, ws: WebSocket):
    if trade_id in connections:
        connections[trade_id].discard(ws)
        if not connections[trade_id]:
            del connections[trade_id]


async def notify_trade_update(trade_id: str, trade: dict):
    """Send trade update to all connected WebSocket clients."""
    if trade_id not in connections:
        return
    message = json.dumps({"type": "trade_update", "trade": trade})
    dead = []
    for ws in connections[trade_id]:
        try:
            await ws.send_text(message)
        except Exception:
            dead.append(ws)
    for ws in dead:
        connections[trade_id].discard(ws)


async def run_timeout_checker():
    """Background task to expire trades that exceeded their deadline."""
    while True:
        try:
            now = datetime.now(timezone.utc).isoformat()
            async with aiosqlite.connect(DB_PATH) as db:
                db.row_factory = aiosqlite.Row
                rows = await db.execute_fetchall(
                    """SELECT * FROM trades
                       WHERE expires_at IS NOT NULL AND expires_at < ? AND status NOT IN ('completed', 'expired', 'cancelled', 'refunded')""",
                    (now,),
                )
                for row in rows:
                    trade = dict(row)
                    trade_id = trade["id"]
                    await db.execute(
                        "UPDATE trades SET status = 'expired', expires_at = NULL WHERE id = ?",
                        (trade_id,),
                    )
                    await db.commit()
                    trade["status"] = "expired"
                    trade["expires_at"] = None
                    await notify_trade_update(trade_id, trade)
                    logger.info(f"Trade {trade_id} expired")
        except Exception as e:
            logger.error(f"Timeout checker error: {e}")

        await asyncio.sleep(TIMEOUT_CHECK_INTERVAL_SECONDS)
