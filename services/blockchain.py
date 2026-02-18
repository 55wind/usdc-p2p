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

# Load escrow ABI
ABI_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "abi", "USDCEscrow.json")
with open(ABI_PATH) as f:
    ESCROW_ABI = json.load(f)

POLL_INTERVAL = 5  # seconds


def uuid_to_bytes32(uuid_str: str) -> bytes:
    """Convert UUID string to bytes32 (remove hyphens, hex decode, zero-pad to 32 bytes)."""
    hex_str = uuid_str.replace("-", "")
    raw = bytes.fromhex(hex_str)
    return raw.ljust(32, b"\x00")


def bytes32_to_uuid(b: bytes) -> str:
    """Convert bytes32 back to UUID string."""
    hex_str = b[:16].hex()
    return f"{hex_str[:8]}-{hex_str[8:12]}-{hex_str[12:16]}-{hex_str[16:20]}-{hex_str[20:32]}"


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

    logger.info(f"Escrow monitor started (state polling), contract={ESCROW_CONTRACT_ADDRESS}")

    while True:
        try:
            async with aiosqlite.connect(DB_PATH) as db:
                db.row_factory = aiosqlite.Row

                # Get all trades that might have on-chain updates
                rows = await db.execute_fetchall(
                    "SELECT * FROM trades WHERE status IN ('joined', 'usdc_escrowed', 'fiat_sent')"
                )

                for row in rows:
                    trade = dict(row)
                    trade_id = trade["id"]

                    try:
                        await _check_trade_state(contract, db, trade)
                    except Exception as ex:
                        logger.warning(f"[{trade_id[:8]}] Error checking state: {ex}")

        except Exception as e:
            logger.error(f"Escrow monitor error: {e}")

        await asyncio.sleep(POLL_INTERVAL)


async def _check_trade_state(contract, db, trade):
    """Check on-chain state for a single trade and update DB if changed."""
    from services.escrow import notify_trade_update

    trade_id = trade["id"]
    trade_id_bytes = uuid_to_bytes32(trade_id)

    # Query on-chain: trades(bytes32) returns (seller, buyer, amount, active, fiatConfirmed, fiatConfirmedAt)
    on_chain = contract.functions.trades(trade_id_bytes).call()
    seller, buyer, amount, active, fiat_confirmed, fiat_confirmed_at = on_chain

    now = datetime.now(timezone.utc).isoformat()
    new_status = None

    if trade["status"] == "joined":
        # Check if USDC was deposited (amount > 0 and active)
        if active and amount > 0:
            expires = (datetime.now(timezone.utc) + timedelta(minutes=60)).isoformat()
            await db.execute(
                """UPDATE trades SET status = 'usdc_escrowed', escrowed_at = ?,
                   expires_at = ? WHERE id = ?""",
                (now, expires, trade_id),
            )
            new_status = "usdc_escrowed"
            logger.info(f"[{trade_id[:8]}] Deposit detected, amount={amount}")

    elif trade["status"] == "usdc_escrowed":
        if not active:
            # Trade closed while in escrowed state (refunded)
            await db.execute(
                """UPDATE trades SET status = 'refunded', completed_at = ?,
                   expires_at = NULL WHERE id = ?""",
                (now, trade_id),
            )
            new_status = "refunded"
            logger.info(f"[{trade_id[:8]}] Refund detected")
        elif fiat_confirmed:
            # Buyer confirmed fiat on-chain
            await db.execute(
                """UPDATE trades SET status = 'fiat_sent', fiat_sent_at = ?,
                   expires_at = NULL WHERE id = ?""",
                (now, trade_id),
            )
            new_status = "fiat_sent"
            logger.info(f"[{trade_id[:8]}] Fiat confirmation detected")

    elif trade["status"] == "fiat_sent":
        if not active:
            # Trade closed after fiat confirmed (released or buyer claimed)
            await db.execute(
                """UPDATE trades SET status = 'completed', completed_at = ?,
                   expires_at = NULL WHERE id = ?""",
                (now, trade_id),
            )
            new_status = "completed"
            logger.info(f"[{trade_id[:8]}] Release/claim detected")

    if new_status:
        await db.commit()
        rows = await db.execute_fetchall("SELECT * FROM trades WHERE id = ?", (trade_id,))
        updated_trade = dict(rows[0])
        await notify_trade_update(trade_id, updated_trade)
