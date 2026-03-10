"""Read-only Polymarket CLOB REST client via py-clob-client SDK.

Supplements the WebSocket client (polymarket_clob.py) with order book depth,
last trade prices, and batch midpoint data. All operations are auth-free.

The SDK is synchronous — call from FastAPI via asyncio.run_in_executor.
"""

import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

try:
    from py_clob_client.client import ClobClient
    from py_clob_client.clob_types import BookParams

    _client = ClobClient("https://clob.polymarket.com", chain_id=137)
    _available = True
    logger.info("py-clob-client initialised (read-only)")
except Exception as e:
    _client = None  # type: ignore
    _available = False
    logger.warning("py-clob-client unavailable: %s", e)


def is_available() -> bool:
    return _available


def get_order_book(token_id: str) -> Dict[str, Any]:
    """Return full order book depth for one CLOB token (synchronous)."""
    if not _available or not _client:
        return {"token_id": token_id, "bids": [], "asks": [], "error": "sdk_unavailable"}
    try:
        book = _client.get_order_book(token_id)
        bids = [{"price": float(b.price), "size": float(b.size)} for b in (book.bids or [])]
        asks = [{"price": float(a.price), "size": float(a.size)} for a in (book.asks or [])]
        top_bid = bids[0]["price"] if bids else None
        top_ask = asks[0]["price"] if asks else None
        spread = round(top_ask - top_bid, 4) if top_bid and top_ask else None
        mid = round((top_bid + top_ask) / 2, 4) if top_bid and top_ask else None
        return {
            "token_id": token_id,
            "bids": bids[:10],   # top 10 levels
            "asks": asks[:10],
            "spread": spread,
            "midpoint": mid,
            "tick_size": book.tick_size,
            "timestamp": book.timestamp,
        }
    except Exception as e:
        logger.debug("get_order_book(%s) error: %s", token_id, e)
        return {"token_id": token_id, "bids": [], "asks": [], "error": str(e)}


def get_order_books_batch(token_ids: List[str]) -> Dict[str, Dict]:
    """Fetch order books for multiple tokens in one call."""
    if not _available or not _client or not token_ids:
        return {}
    try:
        params = [BookParams(token_id=tid) for tid in token_ids]
        books = _client.get_order_books(params)
        result: Dict[str, Dict] = {}
        for book in (books or []):
            if not book or not book.asset_id:
                continue
            bids = [{"price": float(b.price), "size": float(b.size)} for b in (book.bids or [])]
            asks = [{"price": float(a.price), "size": float(a.size)} for a in (book.asks or [])]
            top_bid = bids[0]["price"] if bids else None
            top_ask = asks[0]["price"] if asks else None
            result[book.asset_id] = {
                "token_id": book.asset_id,
                "bids": bids[:10],
                "asks": asks[:10],
                "spread": round(top_ask - top_bid, 4) if top_bid and top_ask else None,
                "midpoint": round((top_bid + top_ask) / 2, 4) if top_bid and top_ask else None,
                "tick_size": book.tick_size,
            }
        return result
    except Exception as e:
        logger.debug("get_order_books_batch error: %s", e)
        return {}


def get_midpoints_batch(token_ids: List[str]) -> Dict[str, float]:
    """Fetch midpoint prices for multiple tokens (lighter than full books)."""
    if not _available or not _client or not token_ids:
        return {}
    try:
        params = [BookParams(token_id=tid) for tid in token_ids]
        result = _client.get_midpoints(params)
        return {k: float(v) for k, v in (result or {}).items()}
    except Exception as e:
        logger.debug("get_midpoints_batch error: %s", e)
        return {}


def get_last_trade_price(token_id: str) -> Optional[float]:
    """Last executed trade price for a token."""
    if not _available or not _client:
        return None
    try:
        return float(_client.get_last_trade_price(token_id))
    except Exception:
        return None
