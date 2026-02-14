import aiosqlite
from config import DATABASE_URL

DB_PATH = DATABASE_URL


async def init_db():
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS trades (
                id TEXT PRIMARY KEY,
                seller_wallet TEXT NOT NULL,
                buyer_wallet TEXT,
                usdc_amount REAL NOT NULL,
                total_krw REAL NOT NULL,
                status TEXT NOT NULL DEFAULT 'created',
                toss_account_number TEXT,
                toss_bank_code TEXT,
                tx_hash TEXT,
                created_at DATETIME NOT NULL,
                joined_at DATETIME,
                usdc_sent_at DATETIME,
                fiat_deposited_at DATETIME,
                completed_at DATETIME,
                expires_at DATETIME
            )
        """)
        await db.commit()


async def get_db():
    db = await aiosqlite.connect(DB_PATH)
    db.row_factory = aiosqlite.Row
    try:
        yield db
    finally:
        await db.close()
