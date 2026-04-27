from pydantic import BaseModel, Field
from typing import Optional


class ListingCreate(BaseModel):
    seller_wallet: str
    amount: float = Field(..., gt=0, description="USDC amount the buyer receives (net)")
    price_per_usdc_krw: float = Field(..., gt=0, description="KRW price per 1 USDC")
    bank_name: str
    bank_account: str
    bank_holder: Optional[str] = None
    nickname: Optional[str] = None
    message: Optional[str] = None


class ListingResponse(BaseModel):
    id: str
    trade_id: str
    seller_wallet: str
    amount: float
    fee: float
    total_deposit: float
    price_per_usdc_krw: float
    total_krw: float
    # Bank info is intentionally NOT exposed via the listing endpoint —
    # it's revealed only on the trade detail once funds are locked.
    nickname: Optional[str] = None
    message: Optional[str] = None
    status: str
    created_at: str
    updated_at: str


class TradeJoin(BaseModel):
    buyer_wallet: str


class TradeResponse(BaseModel):
    id: str
    listing_id: Optional[str] = None
    seller_wallet: str
    buyer_wallet: Optional[str] = None
    amount: float
    fee: float
    total_deposit: float
    total_krw: float
    status: str
    bank_name: Optional[str] = None
    bank_account: Optional[str] = None
    bank_holder: Optional[str] = None
    message: Optional[str] = None
    deposit_tx_hash: Optional[str] = None
    fiat_confirm_tx_hash: Optional[str] = None
    release_tx_hash: Optional[str] = None
    refund_tx_hash: Optional[str] = None
    created_at: str
    joined_at: Optional[str] = None
    locked_at: Optional[str] = None
    paid_at: Optional[str] = None
    released_at: Optional[str] = None
    expires_at: Optional[str] = None
