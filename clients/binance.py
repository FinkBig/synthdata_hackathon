"""Binance public REST client for spot prices. No API key required."""

import logging
from typing import Optional

import aiohttp

# Standalone config
BINANCE_BASE_URL = "https://api.binance.com"
BINANCE_SYMBOLS = {
    "BTC": "BTCUSDT",
    "ETH": "ETHUSDT",
}

logger = logging.getLogger(__name__)


class BinanceClient:
    def __init__(self):
        self._session: Optional[aiohttp.ClientSession] = None

    async def _ensure_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10))
        return self._session

    async def close(self):
        if self._session and not self._session.closed:
            await self._session.close()
        self._session = None

    async def get_spot_price(self, asset: str) -> Optional[float]:
        """Get current spot price for BTC or ETH (USDT pair)."""
        symbol = BINANCE_SYMBOLS.get(asset)
        if not symbol:
            return None
        session = await self._ensure_session()
        url = f"{BINANCE_BASE_URL}/api/v3/ticker/price"
        try:
            async with session.get(url, params={"symbol": symbol}) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    price = float(data["price"])
                    logger.info("Binance %s spot: %.2f", asset, price)
                    return price
                logger.error("Binance spot HTTP %s for %s", resp.status, symbol)
                return None
        except Exception as e:
            logger.error("Binance spot error for %s: %s", symbol, e)
            return None
