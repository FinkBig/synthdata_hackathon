"""Polymarket CLOB WebSocket client for live bid/ask prices."""

import asyncio
import json
import logging
import time
from typing import Dict, List, Optional, Tuple

import aiohttp

logger = logging.getLogger(__name__)

CLOB_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market"
_BATCH_SIZE = 50
_PING_INTERVAL = 30
_BACKOFF_INITIAL = 5
_BACKOFF_MAX = 60


class PolymarketClobWs:
    def __init__(self):
        self._prices: Dict[str, Tuple[float, float, float]] = {}  # token_id -> (best_bid, best_ask, ts)
        self._connected = False
        self._subscribed_ids: List[str] = []
        self._ws: Optional[aiohttp.ClientWebSocketResponse] = None
        self._session: Optional[aiohttp.ClientSession] = None
        self._stop_event = asyncio.Event()
        self._lock = asyncio.Lock()

    def subscribe(self, token_ids: List[str]) -> None:
        """Update the subscription list; re-subscribes immediately if already connected."""
        self._subscribed_ids = list(token_ids)
        if self._connected and self._ws is not None and not self._ws.closed:
            asyncio.create_task(self._send_subscribe(self._ws, token_ids))

    def get_price(self, token_id: str) -> Optional[Tuple[float, float]]:
        entry = self._prices.get(token_id)
        if entry is None:
            return None
        return entry[0], entry[1]

    def get_price_age(self, token_id: str) -> Optional[float]:
        """Returns seconds since last price update, or None if never seen."""
        entry = self._prices.get(token_id)
        return (time.time() - entry[2]) if entry else None

    def all_prices(self) -> Dict[str, Tuple[float, float]]:
        return {k: (v[0], v[1]) for k, v in self._prices.items()}

    def is_connected(self) -> bool:
        return self._connected

    async def run(self) -> None:
        """Main connection loop with exponential backoff reconnect."""
        backoff = _BACKOFF_INITIAL
        while not self._stop_event.is_set():
            try:
                await self._connect_and_run()
                backoff = _BACKOFF_INITIAL
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning("CLOB WS error: %s, reconnecting in %ds", e, backoff)

            if self._stop_event.is_set():
                break

            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=backoff)
            except asyncio.TimeoutError:
                pass
            backoff = min(backoff * 2, _BACKOFF_MAX)

    async def stop(self) -> None:
        self._stop_event.set()
        if self._ws and not self._ws.closed:
            await self._ws.close()
        if self._session and not self._session.closed:
            await self._session.close()

    async def _connect_and_run(self) -> None:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()

        async with self._session.ws_connect(CLOB_WS_URL) as ws:
            self._ws = ws
            self._connected = True
            logger.info("CLOB WS: connected")

            if self._subscribed_ids:
                await self._send_subscribe(ws, self._subscribed_ids)

            ping_task = asyncio.create_task(self._ping_loop(ws))
            try:
                async for msg in ws:
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        await self._handle_message(msg.data)
                    elif msg.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSED):
                        break
            finally:
                ping_task.cancel()
                self._connected = False
                self._ws = None
                logger.info("CLOB WS: disconnected")

    async def _send_subscribe(self, ws: aiohttp.ClientWebSocketResponse,
                               token_ids: List[str]) -> None:
        for i in range(0, len(token_ids), _BATCH_SIZE):
            batch = token_ids[i:i + _BATCH_SIZE]
            msg = json.dumps({
                "type": "market",
                "assets_ids": batch,
                "custom_feature_enabled": True,
            })
            await ws.send_str(msg)
        logger.info("CLOB WS: subscribed to %d token IDs", len(token_ids))

    async def _ping_loop(self, ws: aiohttp.ClientWebSocketResponse) -> None:
        while not ws.closed:
            await asyncio.sleep(_PING_INTERVAL)
            if not ws.closed:
                try:
                    await ws.send_str(json.dumps({"type": "ping"}))
                except Exception:
                    break

    async def _handle_message(self, data: str) -> None:
        try:
            payload = json.loads(data)
            events = payload if isinstance(payload, list) else [payload]
            for event in events:
                event_type = event.get("event_type") or event.get("type")
                if event_type == "book":
                    await self._handle_book(event)
                elif event_type == "price_change":
                    await self._handle_price_change(event)
                elif event_type == "best_bid_ask":
                    await self._handle_best_bid_ask(event)
        except Exception as e:
            logger.debug("CLOB WS parse error: %s", e)

    async def _handle_book(self, event: Dict) -> None:
        """Full order book snapshot — bids descending, asks ascending."""
        asset_id = event.get("asset_id")
        if not asset_id:
            return

        bids = event.get("bids", [])
        asks = event.get("asks", [])

        # bids sorted descending → first non-zero is best bid
        best_bid = 0.0
        for b in bids:
            if float(b.get("size", 0)) > 0:
                best_bid = float(b["price"])
                break

        # asks sorted ascending → first non-zero is best ask
        best_ask = 1.0
        for a in asks:
            if float(a.get("size", 0)) > 0:
                best_ask = float(a["price"])
                break

        async with self._lock:
            self._prices[asset_id] = (best_bid, best_ask, time.time())

    async def _handle_price_change(self, event: Dict) -> None:
        """Incremental update — each change carries best_bid/best_ask directly."""
        for change in event.get("price_changes", []):
            asset_id = change.get("asset_id")
            if not asset_id:
                continue

            # Prefer the authoritative best_bid/best_ask included in the event
            raw_bid = change.get("best_bid")
            raw_ask = change.get("best_ask")
            if raw_bid is not None and raw_ask is not None:
                async with self._lock:
                    self._prices[asset_id] = (float(raw_bid), float(raw_ask), time.time())
                continue

            # Fallback: apply the individual level change manually.
            # When size==0 a level was removed; without full book state we can't
            # reliably determine the new best, so we skip and wait for the next
            # authoritative best_bid_ask event (fired by custom_feature_enabled=True).
            async with self._lock:
                entry = self._prices.get(asset_id, (0.0, 1.0, 0.0))
                best_bid, best_ask, ts = entry
                side = change.get("side", "").upper()
                price = float(change.get("price", 0))
                size = float(change.get("size", 0))

                if size > 0:
                    if side == "BUY" and price > best_bid:
                        best_bid = price
                    elif side == "SELL" and price < best_ask:
                        best_ask = price
                    self._prices[asset_id] = (best_bid, best_ask, time.time())

    async def _handle_best_bid_ask(self, event: Dict) -> None:
        """Direct best bid/ask update (custom_feature_enabled=True)."""
        asset_id = event.get("asset_id")
        if not asset_id:
            return
        raw_bid = event.get("best_bid")
        raw_ask = event.get("best_ask")
        if raw_bid is not None and raw_ask is not None:
            async with self._lock:
                self._prices[asset_id] = (float(raw_bid), float(raw_ask), time.time())
