from pydantic import BaseModel
from typing import Optional


class TradeCreate(BaseModel):
    seller_wallet: str
    usdc_amount: float
    total_krw: float
    bank_name: str
    bank_account: str


class TradeJoin(BaseModel):
    buyer_wallet: str


class TradeResponse(BaseModel):
    id: str
    seller_wallet: str
    buyer_wallet: Optional[str] = None
    usdc_amount: float
    total_krw: float
    status: str
    bank_name: Optional[str] = None
    bank_account: Optional[str] = None
    escrow_tx_hash: Optional[str] = None
    release_tx_hash: Optional[str] = None
    created_at: str
    joined_at: Optional[str] = None
    escrowed_at: Optional[str] = None
    fiat_sent_at: Optional[str] = None
    completed_at: Optional[str] = None
    expires_at: Optional[str] = None
