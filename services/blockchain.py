import asyncio
import json
import logging
import os
from datetime import datetime, timedelta, timezone

import aiosqlite
from web3 import Web3

from config import POLYGON_RPC_URL, ESCROW_CONTRACT_ADDRESS
from database import DB_PATH

logger = logging.getLogger(__name__)

ABI_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "abi", "USDCEscrow.json")
with open(ABI_PATH) as f:
    ESCROW_ABI = json.load(f)

POLL_INTERVAL = 5  # seconds


def uuid_to_bytes32(uuid_str: str) -> bytes:
    """UUID → bytes32 (right-padded with zeros)."""
    hex_str = uuid_str.replace("-", "")
    raw = bytes.fromhex(hex_str)
    return raw.ljust(32, b"\x00")


async def run_escrow_monitor():
    """Background loop: poll on-chain trade state for active trades."""
    if not ESCROW_CONTRACT_ADDRESS:
        logger.warning("ESCROW_CONTRACT_ADDRESS not set, escrow monitor disabled")
        return

    w3 = Web3(Web3.HTTPProvider(POLYGON_RPC_URL))
    contract = w3.eth.contract(
        address=Web3.to_checksum_address(ESCROW_CONTRACT_ADDRESS),
        abi=ESCROW_ABI,
    )
    logger.info(f"Escrow monitor started, contract={ESCROW_CONTRACT_ADDRESS}")

    while True:
        try:
            async with aiosqlite.connect(DB_PATH) as db:
                db.row_factory = aiosqlite.Row
                rows = await db.execute_fetchall(
                    "SELECT * FROM trades WHERE status IN ('joined', 'locked', 'paid')"
                )
                for row in rows:
                    trade = dict(row)
                    try:
                        await _check_trade_state(contract, db, trade)
                    except Exception as ex:
                        logger.warning(f"[{trade['id'][:8]}] error: {ex}")
        except Exception as e:
            logger.error(f"Escrow monitor error: {e}")
        await asyncio.sleep(POLL_INTERVAL)


async def _check_trade_state(contract, db, trade):
    """Translate on-chain state → DB status (open/joined/locked/paid/released/refunded)."""
    from services.escrow import notify_trade_update

    trade_id = trade["id"]
    trade_id_bytes = uuid_to_bytes32(trade_id)

    # New ABI: trades(bytes32) → (seller, buyer, amount, fee, active, fiatConfirmed, fiatConfirmedAt)
    on_chain = contract.functions.trades(trade_id_bytes).call()

    # Tolerate older ABIs without the fee field.
    if len(on_chain) >= 7:
        seller, buyer, amount, _fee, active, fiat_confirmed, _fc_at = on_chain
    else:
        seller, buyer, amount, active, fiat_confirmed, _fc_at = on_chain

    if amount == 0:
        return

    now = datetime.now(timezone.utc).isoformat()

    if not active:
        new_status = "released" if fiat_confirmed else "refunded"
    elif fiat_confirmed:
        new_status = "paid"
    else:
        new_status = "locked"

    if new_status == trade["status"]:
        return
    logger.info(f"[{trade_id[:8]}] {trade['status']} → {new_status}")

    if new_status == "locked":
        expires = (datetime.now(timezone.utc) + timedelta(minutes=60)).isoformat()
        await db.execute(
            "UPDATE trades SET status='locked', locked_at=?, expires_at=? WHERE id=?",
            (now, expires, trade_id),
        )
    elif new_status == "paid":
        await db.execute(
            "UPDATE trades SET status='paid', paid_at=?, expires_at=NULL WHERE id=?",
            (now, trade_id),
        )
    elif new_status == "released":
        await db.execute(
            "UPDATE trades SET status='released', released_at=?, expires_at=NULL WHERE id=?",
            (now, trade_id),
        )
    elif new_status == "refunded":
        await db.execute(
            "UPDATE trades SET status='refunded', released_at=?, expires_at=NULL WHERE id=?",
            (now, trade_id),
        )

    # Mirror onto listing too.
    await db.execute(
        "UPDATE listings SET status=?, updated_at=? WHERE trade_id=?",
        (new_status, now, trade_id),
    )
    await db.commit()

    rows = await db.execute_fetchall("SELECT * FROM trades WHERE id = ?", (trade_id,))
    updated = dict(rows[0])
    await notify_trade_update(trade_id, updated)
