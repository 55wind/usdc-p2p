import asyncio
import logging
from datetime import datetime, timedelta, timezone

import aiosqlite
from web3 import Web3

from config import POLYGON_RPC_URL, USDC_CONTRACT_ADDRESS, PHASE_TIMEOUT_MINUTES
from database import DB_PATH

logger = logging.getLogger(__name__)

# Minimal ERC-20 ABI for Transfer event
ERC20_ABI = [
    {
        "anonymous": False,
        "inputs": [
            {"indexed": True, "name": "from", "type": "address"},
            {"indexed": True, "name": "to", "type": "address"},
            {"indexed": False, "name": "value", "type": "uint256"},
        ],
        "name": "Transfer",
        "type": "event",
    }
]

USDC_DECIMALS = 6


async def start_monitoring_transfer(
    trade_id: str, seller_wallet: str, buyer_wallet: str, usdc_amount: float
):
    asyncio.create_task(_monitor_transfer(trade_id, seller_wallet, buyer_wallet, usdc_amount))


async def _monitor_transfer(
    trade_id: str, seller_wallet: str, buyer_wallet: str, usdc_amount: float
):
    """Poll Polygon for USDC transfer from seller to buyer."""
    w3 = Web3(Web3.HTTPProvider(POLYGON_RPC_URL))
    contract = w3.eth.contract(
        address=Web3.to_checksum_address(USDC_CONTRACT_ADDRESS), abi=ERC20_ABI
    )

    seller_addr = Web3.to_checksum_address(seller_wallet)
    buyer_addr = Web3.to_checksum_address(buyer_wallet)
    expected_amount = int(usdc_amount * 10**USDC_DECIMALS)

    start_block = w3.eth.block_number
    deadline = datetime.now(timezone.utc) + timedelta(minutes=PHASE_TIMEOUT_MINUTES)

    while datetime.now(timezone.utc) < deadline:
        try:
            current_block = w3.eth.block_number
            if current_block <= start_block:
                await asyncio.sleep(5)
                continue

            # Get Transfer events
            events = contract.events.Transfer().get_logs(
                from_block=start_block, to_block=current_block,
                argument_filters={"from": seller_addr, "to": buyer_addr},
            )

            for event in events:
                if event["args"]["value"] >= expected_amount:
                    tx_hash = event["transactionHash"].hex()
                    await _confirm_usdc_sent(trade_id, tx_hash)
                    return

            start_block = current_block + 1
        except Exception as e:
            logger.error(f"Blockchain monitoring error for trade {trade_id}: {e}")

        await asyncio.sleep(5)

    logger.warning(f"Monitoring timed out for trade {trade_id}")


async def _confirm_usdc_sent(trade_id: str, tx_hash: str):
    from services.escrow import notify_trade_update
    from services.payment import create_virtual_account

    now = datetime.now(timezone.utc)
    expires = (now + timedelta(minutes=PHASE_TIMEOUT_MINUTES)).isoformat()

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        await db.execute(
            """UPDATE trades SET status = 'usdc_sent', tx_hash = ?, usdc_sent_at = ?, expires_at = ?
               WHERE id = ?""",
            (tx_hash, now.isoformat(), expires, trade_id),
        )
        await db.commit()

        rows = await db.execute_fetchall("SELECT * FROM trades WHERE id = ?", (trade_id,))
        trade = dict(rows[0])

    # Create Toss virtual account for fiat deposit
    va_info = await create_virtual_account(trade_id, trade["total_krw"])
    if va_info:
        async with aiosqlite.connect(DB_PATH) as db:
            db.row_factory = aiosqlite.Row
            await db.execute(
                "UPDATE trades SET toss_account_number = ?, toss_bank_code = ? WHERE id = ?",
                (va_info["accountNumber"], va_info["bankCode"], trade_id),
            )
            await db.commit()
            rows = await db.execute_fetchall("SELECT * FROM trades WHERE id = ?", (trade_id,))
            trade = dict(rows[0])

    await notify_trade_update(trade_id, trade)
