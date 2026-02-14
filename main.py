import asyncio
import logging

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from starlette.requests import Request

from config import HOST, PORT
from database import init_db
from routers import trades, webhook
from services.escrow import register_ws, unregister_ws, run_timeout_checker

logging.basicConfig(level=logging.INFO)

app = FastAPI(title="USDC-KRW P2P Trading")

app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

app.include_router(trades.router)
app.include_router(webhook.router)


@app.on_event("startup")
async def startup():
    await init_db()
    asyncio.create_task(run_timeout_checker())


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/trade/{trade_id}", response_class=HTMLResponse)
async def trade_page(request: Request, trade_id: str):
    return templates.TemplateResponse("index.html", {"request": request})


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
