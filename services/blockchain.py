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

POLL_INTERVAL = 10  # seconds


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
    """Background loop monitoring escrow contract events."""
    if not ESCROW_CONTRACT_ADDRESS:
        logger.warning("ESCROW_CONTRACT_ADDRESS not set, escrow monitor disabled")
        return

    w3 = Web3(Web3.HTTPProvider(POLYGON_RPC_URL))
    contract = w3.eth.contract(
        address=Web3.to_checksum_address(ESCROW_CONTRACT_ADDRESS),
        abi=ESCROW_ABI,
    )

    # Start from current block
    last_block = w3.eth.block_number
    logger.info(f"Escrow monitor started at block {last_block}, contract={ESCROW_CONTRACT_ADDRESS}")

    while True:
        try:
            current_block = w3.eth.block_number
            if current_block <= last_block:
                await asyncio.sleep(POLL_INTERVAL)
                continue

            from_block = last_block + 1
            to_block = current_block

            # Fetch all three event types
            deposited_events = contract.events.Deposited.get_logs(
                fromBlock=from_block, toBlock=to_block
            )
            released_events = contract.events.Released.get_logs(
                fromBlock=from_block, toBlock=to_block
            )
            refunded_events = contract.events.Refunded.get_logs(
                fromBlock=from_block, toBlock=to_block
            )

            for event in deposited_events:
                await _handle_deposited(event)

            for event in released_events:
                await _handle_released(event)

            for event in refunded_events:
                await _handle_refunded(event)

            last_block = to_block

        except Exception as e:
            logger.error(f"Escrow monitor error: {e}")

        await asyncio.sleep(POLL_INTERVAL)


async def _handle_deposited(event):
    """Handle Deposited event: update trade status to usdc_escrowed."""
    from services.escrow import notify_trade_update

    trade_id_bytes = event["args"]["tradeId"]
    trade_id = bytes32_to_uuid(trade_id_bytes)
    tx_hash = event["transactionHash"].hex()

    logger.info(f"[{trade_id[:8]}] Deposited event detected, tx={tx_hash}")

    now = datetime.now(timezone.utc).isoformat()

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        rows = await db.execute_fetchall("SELECT * FROM trades WHERE id = ?", (trade_id,))
        if not rows:
            logger.warning(f"[{trade_id[:8]}] Trade not found for Deposited event")
            return

        trade = dict(rows[0])
        if trade["status"] not in ("joined",):
            logger.warning(f"[{trade_id[:8]}] Ignoring Deposited event, status={trade['status']}")
            return

        await db.execute(
            """UPDATE trades SET status = 'usdc_escrowed', escrow_tx_hash = ?, escrowed_at = ?,
               expires_at = ? WHERE id = ?""",
            (tx_hash, now, (datetime.now(timezone.utc) + timedelta(minutes=60)).isoformat(), trade_id),
        )
        await db.commit()

        rows = await db.execute_fetchall("SELECT * FROM trades WHERE id = ?", (trade_id,))
        trade = dict(rows[0])

    await notify_trade_update(trade_id, trade)


async def _handle_released(event):
    """Handle Released event: update trade status to completed."""
    from services.escrow import notify_trade_update

    trade_id_bytes = event["args"]["tradeId"]
    trade_id = bytes32_to_uuid(trade_id_bytes)
    tx_hash = event["transactionHash"].hex()

    logger.info(f"[{trade_id[:8]}] Released event detected, tx={tx_hash}")

    now = datetime.now(timezone.utc).isoformat()

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        rows = await db.execute_fetchall("SELECT * FROM trades WHERE id = ?", (trade_id,))
        if not rows:
            logger.warning(f"[{trade_id[:8]}] Trade not found for Released event")
            return

        await db.execute(
            """UPDATE trades SET status = 'completed', release_tx_hash = ?, completed_at = ?,
               expires_at = NULL WHERE id = ?""",
            (tx_hash, now, trade_id),
        )
        await db.commit()

        rows = await db.execute_fetchall("SELECT * FROM trades WHERE id = ?", (trade_id,))
        trade = dict(rows[0])

    await notify_trade_update(trade_id, trade)


async def _handle_refunded(event):
    """Handle Refunded event: update trade status to refunded."""
    from services.escrow import notify_trade_update

    trade_id_bytes = event["args"]["tradeId"]
    trade_id = bytes32_to_uuid(trade_id_bytes)
    tx_hash = event["transactionHash"].hex()

    logger.info(f"[{trade_id[:8]}] Refunded event detected, tx={tx_hash}")

    now = datetime.now(timezone.utc).isoformat()

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        rows = await db.execute_fetchall("SELECT * FROM trades WHERE id = ?", (trade_id,))
        if not rows:
            logger.warning(f"[{trade_id[:8]}] Trade not found for Refunded event")
            return

        await db.execute(
            """UPDATE trades SET status = 'refunded', release_tx_hash = ?, completed_at = ?,
               expires_at = NULL WHERE id = ?""",
            (tx_hash, now, trade_id),
        )
        await db.commit()

        rows = await db.execute_fetchall("SELECT * FROM trades WHERE id = ?", (trade_id,))
        trade = dict(rows[0])

    await notify_trade_update(trade_id, trade)
