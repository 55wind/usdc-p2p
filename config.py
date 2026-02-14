import os
from dotenv import load_dotenv

load_dotenv()

# Polygon RPC
POLYGON_RPC_URL = os.getenv("POLYGON_RPC_URL", "https://polygon-rpc.com")

# USDC contract on Polygon (native USDC)
USDC_CONTRACT_ADDRESS = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"

# Toss Payments
TOSS_SECRET_KEY = os.getenv("TOSS_SECRET_KEY", "test_sk_xxx")
TOSS_API_URL = "https://api.tosspayments.com/v1"

# Trade settings
PHASE_TIMEOUT_MINUTES = 20
TIMEOUT_CHECK_INTERVAL_SECONDS = 30

# Debug mode (set DEBUG=true for development mock fallbacks)
DEBUG = os.getenv("DEBUG", "false").lower() == "true"

# Server
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "3000"))

# Database
DATABASE_URL = os.getenv("DATABASE_URL", "trades.db")
