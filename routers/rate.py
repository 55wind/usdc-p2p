from fastapi import APIRouter

from services.rate import get_usdc_krw

router = APIRouter(prefix="/api", tags=["rate"])


@router.get("/rate")
async def rate():
    """Live USDC→KRW market rate for pre-filling the seller's suggested price."""
    return await get_usdc_krw()
