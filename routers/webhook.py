from datetime import datetime, timezone

import aiosqlite
from fastapi import APIRouter, Request

from database import DB_PATH
from services.escrow import notify_trade_update

router = APIRouter(prefix="/webhook", tags=["webhook"])


@router.post("/toss")
async def toss_webhook(request: Request):
    """Receive deposit confirmation from Toss Payments."""
    body = await request.json()
    event_type = body.get("eventType", "")

    if event_type != "DEPOSIT_CALLBACK":
        return {"status": "ignored"}

    data = body.get("data", {})
    order_id = data.get("orderId", "")  # We use trade_id as orderId

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        rows = await db.execute_fetchall("SELECT * FROM trades WHERE id = ?", (order_id,))
        if not rows:
            return {"status": "trade_not_found"}

        trade = dict(rows[0])
        if trade["status"] != "usdc_sent":
            return {"status": "ignored_status"}

        now = datetime.now(timezone.utc).isoformat()
        await db.execute(
            """UPDATE trades SET status = 'fiat_deposited', fiat_deposited_at = ?, expires_at = NULL
               WHERE id = ?""",
            (now, order_id),
        )
        await db.commit()

        rows = await db.execute_fetchall("SELECT * FROM trades WHERE id = ?", (order_id,))
        trade = dict(rows[0])

    await notify_trade_update(order_id, trade)
    return {"status": "ok"}
