from datetime import datetime, timedelta, timezone

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException

from database import get_db
from models import TradeJoin, TradeResponse
from config import PHASE_TIMEOUT_MINUTES, ESCROW_CONTRACT_ADDRESS, PLATFORM_WALLET_ADDRESS, PLATFORM_FEE_BPS
from services.escrow import notify_trade_update

router = APIRouter(prefix="/api/trades", tags=["trades"])


@router.get("/config")
async def get_config():
    return {
        "escrow_contract_address": ESCROW_CONTRACT_ADDRESS,
        "platform_wallet": PLATFORM_WALLET_ADDRESS,
        "fee_bps": PLATFORM_FEE_BPS,
    }


def row_to_dict(row: aiosqlite.Row) -> dict:
    return dict(row)


def _redact_bank(trade: dict) -> dict:
    """Hide seller bank details until USDC is locked in escrow.

    Without this, anyone with the trade ID could fetch bank account info
    via the public API. Only revealed at status >= 'locked' so that buyers
    only see it after the seller has actually committed funds.
    """
    if trade.get("status") not in ("locked", "paid"):
        trade["bank_name"] = None
        trade["bank_account"] = None
        trade["bank_holder"] = None
    return trade


@router.get("/{trade_id}", response_model=TradeResponse)
async def get_trade(trade_id: str, db=Depends(get_db)):
    rows = await db.execute_fetchall("SELECT * FROM trades WHERE id = ?", (trade_id,))
    if not rows:
        raise HTTPException(404, "Trade not found")
    return TradeResponse(**_redact_bank(row_to_dict(rows[0])))


@router.post("/{trade_id}/join", response_model=TradeResponse)
async def join_trade(trade_id: str, body: TradeJoin, db=Depends(get_db)):
    rows = await db.execute_fetchall("SELECT * FROM trades WHERE id = ?", (trade_id,))
    if not rows:
        raise HTTPException(404, "Trade not found")
    trade = row_to_dict(rows[0])
    if trade["status"] != "open":
        raise HTTPException(400, "Trade is not open to join")

    if body.buyer_wallet.lower() == trade["seller_wallet"].lower():
        raise HTTPException(400, "Buyer wallet must differ from seller wallet")

    now = datetime.now(timezone.utc)
    expires = (now + timedelta(minutes=PHASE_TIMEOUT_MINUTES)).isoformat()

    await db.execute(
        """UPDATE trades SET buyer_wallet = ?, status = 'joined', joined_at = ?, expires_at = ?
           WHERE id = ?""",
        (body.buyer_wallet, now.isoformat(), expires, trade_id),
    )
    # Mirror status onto the listing (for marketplace display).
    await db.execute(
        "UPDATE listings SET status = 'joined', updated_at = ? WHERE trade_id = ?",
        (now.isoformat(), trade_id),
    )
    await db.commit()

    rows = await db.execute_fetchall("SELECT * FROM trades WHERE id = ?", (trade_id,))
    trade = row_to_dict(rows[0])
    # Notify with the full record (WS goes only to listeners of this trade); the
    # response over HTTP gets redacted because the trade just hit 'joined'.
    await notify_trade_update(trade_id, _redact_bank(dict(trade)))
    return TradeResponse(**_redact_bank(trade))
