import uuid
from datetime import datetime, timedelta, timezone

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException

from database import get_db
from models import TradeCreate, TradeJoin, TradeResponse
from config import PHASE_TIMEOUT_MINUTES, ESCROW_CONTRACT_ADDRESS
from services.escrow import notify_trade_update

router = APIRouter(prefix="/api/trades", tags=["trades"])


@router.get("/config")
async def get_config():
    return {"escrow_contract_address": ESCROW_CONTRACT_ADDRESS}


def row_to_dict(row: aiosqlite.Row) -> dict:
    return dict(row)


@router.post("", response_model=TradeResponse)
async def create_trade(body: TradeCreate, db=Depends(get_db)):
    trade_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    total_krw = round(body.total_krw, 0)

    await db.execute(
        """INSERT INTO trades (id, seller_wallet, usdc_amount, total_krw, bank_name, bank_account, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'created', ?)""",
        (trade_id, body.seller_wallet, body.usdc_amount, total_krw, body.bank_name, body.bank_account, now),
    )
    await db.commit()

    row = await db.execute_fetchall("SELECT * FROM trades WHERE id = ?", (trade_id,))
    return TradeResponse(**row_to_dict(row[0]))


@router.get("/{trade_id}", response_model=TradeResponse)
async def get_trade(trade_id: str, db=Depends(get_db)):
    rows = await db.execute_fetchall("SELECT * FROM trades WHERE id = ?", (trade_id,))
    if not rows:
        raise HTTPException(404, "Trade not found")
    return TradeResponse(**row_to_dict(rows[0]))


@router.post("/{trade_id}/join", response_model=TradeResponse)
async def join_trade(trade_id: str, body: TradeJoin, db=Depends(get_db)):
    rows = await db.execute_fetchall("SELECT * FROM trades WHERE id = ?", (trade_id,))
    if not rows:
        raise HTTPException(404, "Trade not found")
    trade = row_to_dict(rows[0])
    if trade["status"] != "created":
        raise HTTPException(400, "Trade is not available to join")

    now = datetime.now(timezone.utc)
    expires = (now + timedelta(minutes=PHASE_TIMEOUT_MINUTES)).isoformat()

    await db.execute(
        """UPDATE trades SET buyer_wallet = ?, status = 'joined', joined_at = ?, expires_at = ?
           WHERE id = ?""",
        (body.buyer_wallet, now.isoformat(), expires, trade_id),
    )
    await db.commit()

    rows = await db.execute_fetchall("SELECT * FROM trades WHERE id = ?", (trade_id,))
    trade = row_to_dict(rows[0])
    await notify_trade_update(trade_id, trade)
    return TradeResponse(**trade)


