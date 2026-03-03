"""Polymarket client using the Gamma API for market discovery."""

import json
import re
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any

import aiohttp

# Standalone config
POLYMARKET_GAMMA_URL = "https://gamma-api.polymarket.com"

POLYMARKET_ASSETS = ["BTC", "ETH", "SOL", "BNB"]

TICKER_TO_NAME = {
    "BTC": "Bitcoin",
    "ETH": "Ethereum",
    "SOL": "Solana",
    "BNB": "Binance Coin",
}

logger = logging.getLogger(__name__)

# Reverse mapping: name -> ticker
NAME_TO_TICKER = {v.upper(): k for k, v in TICKER_TO_NAME.items()}

# Keywords that identify crypto price prediction markets
PRICE_KEYWORDS = ["above", "below", "up or down", "hit", "reach", "dip", "range", "between", "price"]


@dataclass
class PolyMarket:
    """A Polymarket prediction market."""
    market_id: str
    question: str
    asset: str
    market_type: str  # above_below, up_or_down, daily_range, weekly_hit, monthly_hit, 1hr, 4hr
    is_above: bool = True
    strike: Optional[float] = None
    lower_bound: Optional[float] = None
    upper_bound: Optional[float] = None
    expiry: Optional[datetime] = None
    yes_price: float = 0.0
    no_price: float = 0.0
    yes_bid: float = 0.0
    yes_ask: float = 0.0
    no_bid: float = 0.0
    no_ask: float = 0.0
    volume_24h: float = 0.0
    slug: str = ""
    polymarket_url: str = ""
    clob_token_id: str = ""
    clob_token_id_no: str = ""
    condition_id: str = ""


class PolymarketClient:
    def __init__(self):
        self._session: Optional[aiohttp.ClientSession] = None

    async def _ensure_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15))
        return self._session

    async def close(self):
        if self._session and not self._session.closed:
            await self._session.close()
        self._session = None

    async def _fetch_markets_page(self, offset: int = 0, limit: int = 100) -> List[Dict]:
        session = await self._ensure_session()
        url = f"{POLYMARKET_GAMMA_URL}/markets"
        params: Dict[str, Any] = {
            "closed": "false",
            "limit": limit,
            "offset": offset,
            "order": "volume24hr",
            "ascending": "false",
            "volume_num_min": 50,
        }
        try:
            async with session.get(url, params=params) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return data if isinstance(data, list) else []
                logger.error("Polymarket /markets HTTP %s", resp.status)
                return []
        except Exception as e:
            logger.error("Polymarket /markets error: %s", e)
            return []

    def _is_crypto_price_market(self, question: str) -> bool:
        q = question.lower()
        has_asset = any(name.lower() in q for name in NAME_TO_TICKER) or any(t.lower() in q for t in POLYMARKET_ASSETS)
        has_price_kw = any(kw in q for kw in PRICE_KEYWORDS)
        return has_asset and has_price_kw

    async def get_all_active_markets(self) -> List[PolyMarket]:
        all_raw = []
        seen_ids = set()
        max_pages = 20
        consecutive_empty = 0

        for page in range(max_pages):
            offset = page * 100
            items = await self._fetch_markets_page(offset=offset)
            if not items:
                break

            found_any = False
            for m in items:
                mid = m.get("id")
                if not mid or mid in seen_ids:
                    continue
                question = m.get("question", "")
                if self._is_crypto_price_market(question):
                    seen_ids.add(mid)
                    all_raw.append(m)
                    found_any = True

            if not found_any:
                consecutive_empty += 1
                if consecutive_empty >= 3:
                    break
            else:
                consecutive_empty = 0

            if len(items) < 100:
                break

        logger.info("Found %d crypto price markets from Polymarket", len(all_raw))
        parsed = [self._parse_market(raw) for raw in all_raw]
        return [m for m in parsed if m is not None]

    def get_markets_for_asset(self, markets: List[PolyMarket], asset: str) -> List[PolyMarket]:
        """Filter markets by asset ticker."""
        return [m for m in markets if m.asset == asset]

    def _parse_market(self, raw: Dict[str, Any]) -> Optional[PolyMarket]:
        question = raw.get("question", "")
        ticker = self._extract_ticker(question)
        if not ticker:
            return None

        strike = self._extract_strike(question)
        market_type = self._classify_market(question, raw)

        if market_type in ("15min", "up_or_down", "weekly_hit", "monthly_hit", "yearly_hit"):
            return None

        q_lower = question.lower()
        is_above = True
        if "less than" in q_lower or "below" in q_lower or "dip" in q_lower:
            is_above = False

        expiry = self._parse_expiration(raw.get("endDate", raw.get("end_date_iso", "")))

        outcome_prices_str = raw.get("outcomePrices", "[0, 0]")
        try:
            outcome_prices = json.loads(outcome_prices_str) if isinstance(outcome_prices_str, str) else outcome_prices_str
        except (json.JSONDecodeError, TypeError):
            outcome_prices = [0, 0]

        yes_price = float(outcome_prices[0]) if len(outcome_prices) > 0 else 0.0
        no_price = float(outcome_prices[1]) if len(outcome_prices) > 1 else 1.0 - yes_price

        best_bid = raw.get("bestBid")
        best_ask = raw.get("bestAsk")
        if best_bid is not None and best_ask is not None:
            yes_bid = float(best_bid)
            yes_ask = float(best_ask)
            no_bid = 1.0 - float(best_ask)
            no_ask = 1.0 - float(best_bid)
        else:
            yes_bid = yes_price
            yes_ask = yes_price
            no_bid = no_price
            no_ask = no_price

        lower_bound, upper_bound = self._extract_range(question)

        slug = raw.get("slug", "")
        events = raw.get("events", [])
        event_slug = events[0].get("slug", "") if events else ""
        pm_url = f"https://polymarket.com/event/{event_slug}" if event_slug else ""

        clob_ids_str = raw.get("clobTokenIds", "[]")
        try:
            clob_ids = json.loads(clob_ids_str) if isinstance(clob_ids_str, str) else clob_ids_str
        except (json.JSONDecodeError, TypeError):
            clob_ids = []
        clob_token_id = clob_ids[0] if clob_ids else ""
        clob_token_id_no = clob_ids[1] if len(clob_ids) > 1 else ""

        return PolyMarket(
            market_id=raw.get("id", ""),
            question=question,
            asset=ticker,
            market_type=market_type,
            is_above=is_above,
            strike=strike,
            lower_bound=lower_bound,
            upper_bound=upper_bound,
            expiry=expiry,
            yes_price=yes_price,
            no_price=no_price,
            yes_bid=yes_bid,
            yes_ask=yes_ask,
            no_bid=no_bid,
            no_ask=no_ask,
            volume_24h=float(raw.get("volumeNum") or raw.get("volume24hr") or 0),
            slug=slug,
            polymarket_url=pm_url,
            clob_token_id=clob_token_id,
            clob_token_id_no=clob_token_id_no,
            condition_id=raw.get("conditionId", ""),
        )

    def _extract_ticker(self, question: str) -> Optional[str]:
        q = question.upper()
        for name, ticker in NAME_TO_TICKER.items():
            if name in q:
                return ticker
        for ticker in POLYMARKET_ASSETS:
            if ticker in q:
                return ticker
        return None

    def _extract_strike(self, question: str) -> Optional[float]:
        match = re.search(r'\$([0-9,]+\.?[0-9]*)', question)
        if match:
            return float(match.group(1).replace(',', ''))
        return None

    def _extract_range(self, question: str):
        match = re.search(r'between\s+\$([0-9,]+\.?[0-9]*)\s+and\s+\$([0-9,]+\.?[0-9]*)', question, re.IGNORECASE)
        if match:
            lower = float(match.group(1).replace(',', ''))
            upper = float(match.group(2).replace(',', ''))
            return lower, upper
        return None, None

    def _classify_market(self, question: str, raw: Dict) -> str:
        q = question.lower()

        if re.search(r'\d+:\d+[ap]m\s*-\s*\d+:\d+[ap]m', q):
            time_match = re.search(r'(\d+):(\d+)([ap]m)\s*-\s*(\d+):(\d+)([ap]m)', q)
            if time_match:
                h1 = int(time_match.group(1))
                m1 = int(time_match.group(2))
                h2 = int(time_match.group(4))
                m2 = int(time_match.group(5))
                if time_match.group(3) == time_match.group(6):
                    diff = (h2 * 60 + m2) - (h1 * 60 + m1)
                    if 0 < diff <= 15:
                        return "15min"

        if "up or down" in q:
            return "up_or_down"

        if "above" in q:
            return "above_below"

        if "between" in q or "range" in q:
            return "daily_range"

        if "reach" in q or "hit" in q or "dip" in q:
            if re.search(r'\w+\s+\d+-\d+', q):
                return "weekly_hit"
            if re.search(r'\bin\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b', q):
                return "monthly_hit"
            if "by " in q:
                return "yearly_hit"
            return "weekly_hit"

        return "above_below"

    def _parse_expiration(self, date_str: str) -> Optional[datetime]:
        if not date_str:
            return None
        try:
            if isinstance(date_str, str):
                return datetime.fromisoformat(date_str.replace('Z', '+00:00'))
            return datetime.fromtimestamp(date_str, tz=timezone.utc)
        except Exception:
            return None
