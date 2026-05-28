"""Live USDC→KRW market rate, used to suggest the seller's price on /sell.

No extra HTTP dependency: the upstream call uses stdlib urllib, run in a
threadpool so it never blocks the event loop. Results are cached briefly and
degrade gracefully — stale cache, then a configured fallback constant.
"""
import asyncio
import json
import logging
import time
import urllib.request

from config import FALLBACK_USDC_KRW, RATE_CACHE_SECONDS

log = logging.getLogger(__name__)

# CoinGecko gives the actual KRW price of USDC (captures any premium/discount),
# which is exactly what a seller prices against. No API key required.
_SOURCE_URL = "https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=krw"

_cache = {"rate": None, "source": None, "ts": 0.0}


def _fetch_blocking() -> float:
    req = urllib.request.Request(_SOURCE_URL, headers={"User-Agent": "Lumos/1.0"})
    with urllib.request.urlopen(req, timeout=5) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    rate = float(data["usd-coin"]["krw"])
    if rate <= 0:
        raise ValueError(f"non-positive rate: {rate}")
    return rate


async def get_usdc_krw() -> dict:
    """Return {usdc_krw, source, cached}. Never raises."""
    now = time.time()
    if _cache["rate"] is not None and (now - _cache["ts"]) < RATE_CACHE_SECONDS:
        return {"usdc_krw": _cache["rate"], "source": _cache["source"], "cached": True}

    try:
        rate = await asyncio.to_thread(_fetch_blocking)
        _cache.update(rate=rate, source="coingecko", ts=now)
        return {"usdc_krw": rate, "source": "coingecko", "cached": False}
    except Exception as e:  # network error, bad payload, timeout, etc.
        log.warning("USDC→KRW rate fetch failed: %s", e)
        if _cache["rate"] is not None:
            # Serve the last good value rather than a hardcoded guess.
            return {"usdc_krw": _cache["rate"], "source": f"{_cache['source']}-stale", "cached": True}
        return {"usdc_krw": FALLBACK_USDC_KRW, "source": "fallback", "cached": False}
