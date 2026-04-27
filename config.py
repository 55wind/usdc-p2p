import os
from dotenv import load_dotenv

load_dotenv()

# Polygon RPC
POLYGON_RPC_URL = os.getenv("POLYGON_RPC_URL", "https://polygon-bor-rpc.publicnode.com")

# USDC contract on Polygon (native USDC)
USDC_CONTRACT_ADDRESS = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"

# Escrow contract
ESCROW_CONTRACT_ADDRESS = os.getenv("ESCROW_CONTRACT_ADDRESS", "")

# Platform wallet (receives fees)
PLATFORM_WALLET_ADDRESS = os.getenv("PLATFORM_WALLET_ADDRESS", "")

# Fee — buyer always receives `amount`; seller deposits `amount + fee`
PLATFORM_FEE_BPS = int(os.getenv("PLATFORM_FEE_BPS", "50"))  # 50 bps = 0.5%

# Trade settings
PHASE_TIMEOUT_MINUTES = 20
TIMEOUT_CHECK_INTERVAL_SECONDS = 30

# Debug mode (set DEBUG=true for development mock fallbacks)
DEBUG = os.getenv("DEBUG", "false").lower() == "true"

# Server
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))

# Database
DATABASE_URL = os.getenv("DATABASE_URL", "trades.db")


def calc_fee(amount: float) -> float:
    """Buyer receives `amount`. Fee is paid by the seller on top.

    Fee = amount * BPS / 10_000, rounded to 6-decimal USDC precision.
    """
    fee = amount * PLATFORM_FEE_BPS / 10_000
    return round(fee, 6)
