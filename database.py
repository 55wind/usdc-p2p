import aiosqlite
from config import DATABASE_URL

DB_PATH = DATABASE_URL


async def init_db():
    async with aiosqlite.connect(DB_PATH) as db:
        # listings: marketplace listings (1:1 with a trade)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS listings (
                id TEXT PRIMARY KEY,
                trade_id TEXT NOT NULL,
                seller_wallet TEXT NOT NULL,
                amount REAL NOT NULL,
                fee REAL NOT NULL,
                total_deposit REAL NOT NULL,
                price_per_usdc_krw REAL NOT NULL,
                total_krw REAL NOT NULL,
                bank_name TEXT NOT NULL,
                bank_account TEXT NOT NULL,
                bank_holder TEXT,
                nickname TEXT,
                message TEXT,
                status TEXT NOT NULL DEFAULT 'open',
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL
            )
        """)

        await db.execute("""
            CREATE TABLE IF NOT EXISTS trades (
                id TEXT PRIMARY KEY,
                listing_id TEXT,
                seller_wallet TEXT NOT NULL,
                buyer_wallet TEXT,
                amount REAL NOT NULL,
                fee REAL NOT NULL DEFAULT 0,
                total_deposit REAL NOT NULL DEFAULT 0,
                total_krw REAL NOT NULL,
                status TEXT NOT NULL DEFAULT 'open',
                bank_name TEXT,
                bank_account TEXT,
                bank_holder TEXT,
                message TEXT,
                contract_deal_id TEXT,
                deposit_tx_hash TEXT,
                fiat_confirm_tx_hash TEXT,
                release_tx_hash TEXT,
                refund_tx_hash TEXT,
                created_at DATETIME NOT NULL,
                joined_at DATETIME,
                locked_at DATETIME,
                paid_at DATETIME,
                released_at DATETIME,
                expires_at DATETIME
            )
        """)
        await db.commit()

        # Lightweight in-place migrations for installs created before this schema.
        await _ensure_columns(db, "trades", {
            "listing_id": "TEXT",
            "amount": "REAL",
            "fee": "REAL DEFAULT 0",
            "total_deposit": "REAL DEFAULT 0",
            "bank_holder": "TEXT",
            "message": "TEXT",
            "contract_deal_id": "TEXT",
            "deposit_tx_hash": "TEXT",
            "fiat_confirm_tx_hash": "TEXT",
            "release_tx_hash": "TEXT",
            "refund_tx_hash": "TEXT",
            "locked_at": "DATETIME",
            "paid_at": "DATETIME",
            "released_at": "DATETIME",
        })
        await db.commit()


async def _ensure_columns(db, table: str, columns: dict[str, str]):
    cur = await db.execute(f"PRAGMA table_info({table})")
    existing = {row[1] for row in await cur.fetchall()}
    for col, decl in columns.items():
        if col not in existing:
            await db.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")


async def get_db():
    db = await aiosqlite.connect(DB_PATH)
    db.row_factory = aiosqlite.Row
    try:
        yield db
    finally:
        await db.close()
