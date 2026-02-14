import base64
import logging
from typing import Optional

import httpx

from config import TOSS_SECRET_KEY, TOSS_API_URL, DEBUG

logger = logging.getLogger(__name__)


def _get_auth_header() -> str:
    encoded = base64.b64encode(f"{TOSS_SECRET_KEY}:".encode()).decode()
    return f"Basic {encoded}"


async def create_virtual_account(trade_id: str, amount_krw: float) -> Optional[dict]:
    """Create a Toss Payments virtual account for the given trade."""
    url = f"{TOSS_API_URL}/virtual-accounts"
    headers = {
        "Authorization": _get_auth_header(),
        "Content-Type": "application/json",
    }
    payload = {
        "amount": int(amount_krw),
        "orderId": trade_id,
        "orderName": f"USDC Purchase ({trade_id[:8]})",
        "customerName": "Buyer",
        "bank": "20",  # 우리은행 default
        "validHours": 1,
    }

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(url, json=payload, headers=headers, timeout=15)
            if resp.status_code == 200:
                data = resp.json()
                return {
                    "accountNumber": data.get("virtualAccount", {}).get("accountNumber", ""),
                    "bankCode": data.get("virtualAccount", {}).get("bankCode", "20"),
                }
            else:
                logger.error(f"Toss API error: {resp.status_code} {resp.text}")
                if DEBUG:
                    return {
                        "accountNumber": f"MOCK-{trade_id[:8]}",
                        "bankCode": "20",
                    }
                return None
    except Exception as e:
        logger.error(f"Toss API request failed: {e}")
        if DEBUG:
            return {
                "accountNumber": f"MOCK-{trade_id[:8]}",
                "bankCode": "20",
            }
        return None
