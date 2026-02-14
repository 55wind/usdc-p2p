from pydantic import BaseModel
from typing import Optional


class TradeCreate(BaseModel):
    seller_wallet: str
    usdc_amount: float
    total_krw: float


class TradeJoin(BaseModel):
    buyer_wallet: str


class TradeResponse(BaseModel):
    id: str
    seller_wallet: str
    buyer_wallet: Optional[str] = None
    usdc_amount: float
    total_krw: float
    status: str
    toss_account_number: Optional[str] = None
    toss_bank_code: Optional[str] = None
    tx_hash: Optional[str] = None
    created_at: str
    joined_at: Optional[str] = None
    usdc_sent_at: Optional[str] = None
    fiat_deposited_at: Optional[str] = None
    completed_at: Optional[str] = None
    expires_at: Optional[str] = None


class WebhookPayload(BaseModel):
    eventType: str
    data: dict
