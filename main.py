import asyncio
import logging

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, PlainTextResponse, Response
from fastapi.templating import Jinja2Templates
from starlette.requests import Request

from config import HOST, PORT, ESCROW_CONTRACT_ADDRESS, PLATFORM_WALLET_ADDRESS, PLATFORM_FEE_BPS
from database import init_db
from routers import trades, listings
from services.escrow import register_ws, unregister_ws, run_timeout_checker
from services.blockchain import run_escrow_monitor

logging.basicConfig(level=logging.INFO)

app = FastAPI(title="Lumos — USDC P2P Marketplace")

app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

app.include_router(listings.router)
app.include_router(trades.router)


@app.on_event("startup")
async def startup():
    await init_db()
    asyncio.create_task(run_timeout_checker())
    asyncio.create_task(run_escrow_monitor())


def _ctx(request: Request) -> dict:
    return {
        "request": request,
        "escrow_address": ESCROW_CONTRACT_ADDRESS,
        "platform_wallet": PLATFORM_WALLET_ADDRESS,
        "fee_bps": PLATFORM_FEE_BPS,
    }


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", _ctx(request))


@app.get("/marketplace", response_class=HTMLResponse)
async def marketplace_page(request: Request):
    return templates.TemplateResponse("marketplace.html", _ctx(request))


@app.get("/sell", response_class=HTMLResponse)
async def sell_page(request: Request):
    return templates.TemplateResponse("sell.html", _ctx(request))


@app.get("/trade/{trade_id}", response_class=HTMLResponse)
async def trade_page(request: Request, trade_id: str):
    return templates.TemplateResponse("trade.html", {**_ctx(request), "trade_id": trade_id})


@app.get("/listing/{listing_id}", response_class=HTMLResponse)
async def listing_page(request: Request, listing_id: str):
    # Listing detail and trade page are the same unified page; the JS resolves the trade id.
    return templates.TemplateResponse("trade.html", {**_ctx(request), "listing_id": listing_id})


@app.get("/robots.txt", response_class=PlainTextResponse)
async def robots(request: Request):
    base = f"{request.url.scheme}://{request.url.netloc}"
    return (
        "User-agent: *\n"
        "Allow: /\n"
        "Allow: /marketplace\n"
        "Allow: /sell\n"
        "Disallow: /api/\n"
        "Disallow: /trade/\n"
        "Disallow: /listing/\n"
        f"Sitemap: {base}/sitemap.xml\n"
    )


@app.get("/sitemap.xml")
async def sitemap(request: Request):
    base = f"{request.url.scheme}://{request.url.netloc}"
    urls = [
        ("/", "1.0"),
        ("/marketplace", "0.9"),
        ("/sell", "0.8"),
    ]
    items = "".join(
        f"<url><loc>{base}{path}</loc><priority>{prio}</priority><changefreq>daily</changefreq></url>"
        for path, prio in urls
    )
    xml = f'<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{items}</urlset>'
    return Response(content=xml, media_type="application/xml")


@app.websocket("/ws/{trade_id}")
async def websocket_endpoint(websocket: WebSocket, trade_id: str):
    await websocket.accept()
    register_ws(trade_id, websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        unregister_ws(trade_id, websocket)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=HOST, port=PORT, reload=False)
