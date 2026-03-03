"""Derive (Lyra Finance) public REST client for options chains."""

import asyncio
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any

import aiohttp

# Standalone config
DERIVE_BASE_URL = "https://api.lyra.finance/public"

logger = logging.getLogger(__name__)


@dataclass
class OptionData:
    """A single option instrument with pricing data."""
    exchange: str
    instrument_name: str
    asset: str
    strike: float
    expiry: datetime
    option_type: str  # call, put
    bid: float = 0.0
    ask: float = 0.0
    mark_price: float = 0.0
    implied_volatility: float = 0.0
    open_interest: float = 0.0
    underlying_price: float = 0.0


class DeriveClient:
    def __init__(self):
        self._session: Optional[aiohttp.ClientSession] = None
        self._cache: Dict[str, Any] = {}
        self._cache_ts: Dict[str, float] = {}
        self._cache_ttl = 60

    async def _ensure_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30))
        return self._session

    async def close(self):
        if self._session and not self._session.closed:
            await self._session.close()
        self._session = None

    async def _post(self, endpoint: str, payload: Dict) -> Any:
        session = await self._ensure_session()
        url = f"{DERIVE_BASE_URL}/{endpoint}"
        try:
            async with session.post(url, json=payload) as resp:
                if resp.status in (502, 503, 504):
                    await asyncio.sleep(1)
                    async with session.post(url, json=payload) as retry_resp:
                        if retry_resp.status == 200:
                            data = await retry_resp.json()
                            return data.get("result") if isinstance(data, dict) else None
                        return None
                if resp.status == 200:
                    data = await resp.json()
                    return data.get("result") if isinstance(data, dict) else None
                logger.error("Derive %s HTTP %s", endpoint, resp.status)
                return None
        except Exception as e:
            logger.error("Derive %s error: %s", endpoint, e)
            return None

    async def _get_all_instruments(self, currency: str) -> List[Dict]:
        """Fetch paginated list of option instruments."""
        instruments = []
        for page in range(1, 21):
            result = await self._post("get_all_instruments", {
                "currency": currency,
                "expired": False,
                "instrument_type": "option",
                "page": page,
                "page_size": 250,
            })
            if not result:
                break
            page_insts = result.get("instruments", []) if isinstance(result, dict) else []
            if not page_insts:
                break
            instruments.extend(page_insts)
            if len(page_insts) < 250:
                break
        return instruments

    async def _get_tickers_batch(self, currency: str, expiry_date: str) -> Dict:
        """Fetch all tickers for a currency+expiry in a single call."""
        result = await self._post("get_tickers", {
            "instrument_type": "option",
            "currency": currency,
            "expiry_date": expiry_date,
        })
        if not result or not isinstance(result, dict):
            return {}
        return result.get("tickers", {})

    async def get_spot(self, currency: str) -> float:
        """Fetch current spot price for a currency."""
        result = await self._post("get_ticker", {"instrument_name": f"{currency}-PERP"})
        if result and isinstance(result, dict):
            index_price = result.get("index_price") or result.get("I")
            if index_price:
                return float(index_price)
        # Fallback: get from options chain
        return 0.0

    async def get_options_chain(self, currency: str) -> List[OptionData]:
        """Fetch full options chain for a currency using batch get_tickers."""
        cache_key = f"chain_{currency}"
        if cache_key in self._cache and (time.time() - self._cache_ts.get(cache_key, 0)) < self._cache_ttl:
            return self._cache[cache_key]

        instruments = await self._get_all_instruments(currency)
        if not instruments:
            return []

        now = time.time()
        max_expiry_ts = now + 14 * 86400

        # Collect unique expiry dates from active instruments
        expiry_dates = set()
        for inst in instruments:
            if not inst.get("is_active", False):
                continue
            name = inst.get("instrument_name", "")
            parts = name.split("-")
            if len(parts) < 4:
                continue
            date_str = parts[1]
            try:
                exp = datetime.strptime(date_str, "%Y%m%d").replace(hour=8, tzinfo=timezone.utc)
            except ValueError:
                try:
                    exp = datetime.strptime(date_str, "%d%b%y").replace(hour=8, tzinfo=timezone.utc)
                    date_str = exp.strftime("%Y%m%d")
                except ValueError:
                    continue
            if exp.timestamp() <= now or exp.timestamp() > max_expiry_ts:
                continue
            expiry_dates.add(date_str)

        logger.info("Derive %s: %d expiry dates to fetch", currency, len(expiry_dates))

        # Fetch all tickers per expiry date using batch endpoint
        batch_results = await asyncio.gather(
            *(self._get_tickers_batch(currency, ed) for ed in sorted(expiry_dates)),
            return_exceptions=True,
        )

        options = []
        spot = 0.0
        for batch in batch_results:
            if isinstance(batch, Exception) or not batch:
                continue

            for name, ticker in batch.items():
                if not isinstance(ticker, dict):
                    continue

                parts = name.split("-")
                if len(parts) < 4:
                    continue

                asset = parts[0]
                try:
                    expiry = datetime.strptime(parts[1], "%Y%m%d").replace(
                        hour=8, tzinfo=timezone.utc
                    )
                except ValueError:
                    try:
                        expiry = datetime.strptime(parts[1], "%d%b%y").replace(
                            hour=8, tzinfo=timezone.utc
                        )
                    except ValueError:
                        continue

                if expiry.timestamp() <= now:
                    continue

                try:
                    strike = float(parts[2])
                except ValueError:
                    continue
                opt_type = "call" if parts[3] == "C" else "put"

                underlying = float(ticker.get("I") or 0)
                if underlying > spot:
                    spot = underlying

                # Derive returns prices directly in USD/USDC — store as-is
                bid = float(ticker.get("b") or 0)
                ask = float(ticker.get("a") or 0)
                mark = float(ticker.get("M") or 0)

                if bid == 0 and ask == 0 and mark == 0:
                    continue

                iv = 0.0
                option_pricing = ticker.get("option_pricing")
                if isinstance(option_pricing, dict):
                    try:
                        iv = float(option_pricing.get("i") or option_pricing.get("iv") or 0)
                    except (TypeError, ValueError):
                        pass

                oi = 0.0
                stats = ticker.get("stats")
                if isinstance(stats, dict):
                    try:
                        oi = float(stats.get("oi") or stats.get("open_interest") or 0)
                    except (TypeError, ValueError):
                        pass

                options.append(OptionData(
                    exchange="derive",
                    instrument_name=name,
                    asset=asset,
                    strike=strike,
                    expiry=expiry,
                    option_type=opt_type,
                    bid=bid,
                    ask=ask,
                    mark_price=mark,
                    implied_volatility=iv,
                    open_interest=oi,
                    underlying_price=underlying,
                ))

        logger.info("Derive %s: %d options fetched, spot=%.0f", currency, len(options), spot)
        self._cache[cache_key] = options
        self._cache_ts[cache_key] = time.time()
        return options

    def get_spot_from_chain(self, options: List[OptionData]) -> float:
        """Extract spot price from an already-fetched options chain."""
        for opt in options:
            if opt.underlying_price > 0:
                return opt.underlying_price
        return 0.0
