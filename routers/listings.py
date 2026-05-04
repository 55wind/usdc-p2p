import uuid
from datetime import datetime, timezone
from typing import Optional

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, Query

from database import get_db
from models import ListingCreate, ListingResponse, TradeResponse
from config import calc_fee

router = APIRouter(prefix="/api/listings", tags=["listings"])


def row_to_dict(row: aiosqlite.Row) -> dict:
    return dict(row)


@router.post("", response_model=ListingResponse)
async def create_listing(body: ListingCreate, db=Depends(get_db)):
    """Create a marketplace listing. A trade record is auto-created (1:1)."""
    listing_id = str(uuid.uuid4())
    trade_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()

    amount = round(float(body.amount), 6)
    fee = calc_fee(amount)
    total_deposit = round(amount + fee, 6)
    total_krw = round(amount * float(body.price_per_usdc_krw), 0)

    # Create the listing
    await db.execute(
        """INSERT INTO listings
           (id, trade_id, seller_wallet, amount, fee, total_deposit,
            price_per_usdc_krw, total_krw, bank_name, bank_account, bank_holder,
            nickname, message, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)""",
        (listing_id, trade_id, body.seller_wallet, amount, fee, total_deposit,
         body.price_per_usdc_krw, total_krw, body.bank_name, body.bank_account,
         body.bank_holder, body.nickname, body.message, now, now),
    )

    # Auto-create the matching trade
    await db.execute(
        """INSERT INTO trades
           (id, listing_id, seller_wallet, amount, fee, total_deposit, total_krw,
            bank_name, bank_account, bank_holder, message, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)""",
        (trade_id, listing_id, body.seller_wallet, amount, fee, total_deposit, total_krw,
         body.bank_name, body.bank_account, body.bank_holder, body.message, now),
    )
    await db.commit()

    rows = await db.execute_fetchall("SELECT * FROM listings WHERE id = ?", (listing_id,))
    return ListingResponse(**row_to_dict(rows[0]))


@router.get("", response_model=list[ListingResponse])
async def list_listings(
    status: str = Query("open"),
    min_amount: Optional[float] = None,
    max_amount: Optional[float] = None,
    min_price: Optional[float] = None,
    max_price: Optional[float] = None,
    sort: str = Query("newest"),
    limit: int = Query(50, ge=1, le=200),
    db=Depends(get_db),
):
    where = ["status = ?"]
    args: list = [status]
    if min_amount is not None:
        where.append("amount >= ?"); args.append(min_amount)
    if max_amount is not None:
        where.append("amount <= ?"); args.append(max_amount)
    if min_price is not None:
        where.append("price_per_usdc_krw >= ?"); args.append(min_price)
    if max_price is not None:
        where.append("price_per_usdc_krw <= ?"); args.append(max_price)

    order = "created_at DESC" if sort == "newest" else "created_at ASC"
    if sort == "price_low":
        order = "price_per_usdc_krw ASC"
    elif sort == "price_high":
        order = "price_per_usdc_krw DESC"

    sql = f"SELECT * FROM listings WHERE {' AND '.join(where)} ORDER BY {order} LIMIT ?"
    args.append(limit)
    rows = await db.execute_fetchall(sql, tuple(args))
    return [ListingResponse(**row_to_dict(r)) for r in rows]


@router.get("/{listing_id}", response_model=ListingResponse)
async def get_listing(listing_id: str, db=Depends(get_db)):
    rows = await db.execute_fetchall("SELECT * FROM listings WHERE id = ?", (listing_id,))
    if not rows:
        raise HTTPException(404, "Listing not found")
    return ListingResponse(**row_to_dict(rows[0]))


@router.get("/{listing_id}/trade", response_model=TradeResponse)
async def get_listing_trade(listing_id: str, db=Depends(get_db)):
    rows = await db.execute_fetchall("SELECT * FROM listings WHERE id = ?", (listing_id,))
    if not rows:
        raise HTTPException(404, "Listing not found")
    listing = row_to_dict(rows[0])
    trade_rows = await db.execute_fetchall("SELECT * FROM trades WHERE id = ?", (listing["trade_id"],))
    if not trade_rows:
        raise HTTPException(404, "Trade not found for listing")
    return TradeResponse(**row_to_dict(trade_rows[0]))


@router.delete("/{listing_id}")
async def delete_listing(
    listing_id: str,
    wallet: str = Query(..., description="Seller wallet address (must match listing.seller_wallet)"),
    db=Depends(get_db),
):
    """Cancel an open listing. Allowed only when the requester's wallet matches the
    listing's seller_wallet AND no buyer has joined yet (status still 'open').

    This is the simple wallet-address-comparison guard — no signature verification.
    Sufficient for MVP since the bank info is never exposed on open listings and
    a deleted listing only removes the seller's own marketplace post.
    """
    rows = await db.execute_fetchall("SELECT * FROM listings WHERE id = ?", (listing_id,))
    if not rows:
        raise HTTPException(404, "Listing not found")
    listing = row_to_dict(rows[0])

    if listing["seller_wallet"].lower() != wallet.lower():
        raise HTTPException(403, "Only the seller can delete this listing")

    if listing["status"] != "open":
        raise HTTPException(409, "Listing is no longer open and cannot be deleted")

    trade_rows = await db.execute_fetchall(
        "SELECT * FROM trades WHERE id = ?", (listing["trade_id"],)
    )
    if trade_rows:
        trade = row_to_dict(trade_rows[0])
        if trade["status"] != "open" or trade.get("buyer_wallet"):
            raise HTTPException(409, "A buyer has already joined; listing cannot be deleted")

    await db.execute("DELETE FROM listings WHERE id = ?", (listing_id,))
    await db.execute("DELETE FROM trades WHERE id = ?", (listing["trade_id"],))
    await db.commit()
    return {"deleted": True, "listing_id": listing_id}
