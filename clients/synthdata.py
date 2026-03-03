"""SynthData API client for AI ensemble predictions.

Fetches probability estimates from SynthData's decentralized AI network (Bittensor subnet).
Uses /prediction-percentiles endpoint for full CDF reconstruction.

API budget: 4500 calls/month.
"""

import logging
import os
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import aiohttp

# Standalone config
SYNTHDATA_BASE_URL = "https://api.synthdata.co"
SYNTHDATA_MONTHLY_LIMIT = 4500
SYNTHDATA_402_BACKOFF_SEC = 3600

logger = logging.getLogger(__name__)

# Percentile CDF keys in the API response, sorted by probability
_PERCENTILE_KEYS = ["0.005", "0.05", "0.2", "0.35", "0.5", "0.65", "0.8", "0.95", "0.995"]


class SynthDataClient:
    def __init__(self):
        self._session: Optional[aiohttp.ClientSession] = None
        self._api_key: Optional[str] = os.environ.get("SYNTHDATA_API_KEY")

        self._cache: Dict[str, Any] = {}
        self._cache_ts: Dict[str, float] = {}

        # TTLs in seconds
        self._ttl_percentiles = 30 * 60  # 30 min
        self._ttl_vol = 30 * 60

        self._call_count = 0
        self._call_month: Optional[int] = None

        self.last_error: Optional[str] = None
        self.enabled = bool(self._api_key)
        self._disabled_until: float = 0.0

    def in_backoff(self) -> bool:
        return time.time() < self._disabled_until

    async def _ensure_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            headers = {}
            if self._api_key:
                headers["Authorization"] = f"Apikey {self._api_key}"
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=15),
                headers=headers,
            )
        return self._session

    async def close(self):
        if self._session and not self._session.closed:
            await self._session.close()
        self._session = None

    def _check_budget(self) -> bool:
        now = datetime.now(timezone.utc)
        if self._call_month != now.month:
            self._call_month = now.month
            self._call_count = 0
            self._cache.clear()
            self._cache_ts.clear()
        return self._call_count < SYNTHDATA_MONTHLY_LIMIT

    def _record_call(self):
        now = datetime.now(timezone.utc)
        if self._call_month != now.month:
            self._call_month = now.month
            self._call_count = 0
        self._call_count += 1

    def _is_cached(self, key: str, ttl: float) -> bool:
        return key in self._cache and (time.time() - self._cache_ts.get(key, 0)) < ttl

    async def _get(self, endpoint: str, ttl: float) -> Optional[Any]:
        if not self.enabled:
            return None

        cache_key = endpoint
        if self._is_cached(cache_key, ttl):
            return self._cache[cache_key]

        now = time.time()
        if now < self._disabled_until:
            self.last_error = "402 backoff (insufficient credits)"
            return self._cache.get(cache_key)

        if not self._check_budget():
            logger.warning("SynthData monthly budget reached (%d/%d)", self._call_count, SYNTHDATA_MONTHLY_LIMIT)
            self.last_error = "Monthly budget exceeded"
            return None

        session = await self._ensure_session()
        url = f"{SYNTHDATA_BASE_URL}{endpoint}"
        try:
            async with session.get(url) as resp:
                if resp.status == 402:
                    self._disabled_until = time.time() + SYNTHDATA_402_BACKOFF_SEC
                    logger.warning("SynthData 402 Insufficient credits — pausing for %d min",
                                   SYNTHDATA_402_BACKOFF_SEC // 60)
                    self.last_error = "402 Insufficient credits (backoff)"
                    return self._cache.get(cache_key)
                if resp.status != 200:
                    text = await resp.text()
                    logger.warning("SynthData %s returned %d: %s", endpoint, resp.status, text[:200])
                    self.last_error = f"HTTP {resp.status}"
                    return None
                data = await resp.json()
                self._record_call()
                self._cache[cache_key] = data
                self._cache_ts[cache_key] = time.time()
                self.last_error = None
                return data
        except Exception as e:
            logger.error("SynthData request error for %s: %s", endpoint, e)
            self.last_error = str(e)
            return None

    async def get_prediction_percentiles(self, asset: str) -> Optional[Dict]:
        """Get 289-step price distribution with 9 percentiles per step."""
        return await self._get(f"/insights/prediction-percentiles?asset={asset}", self._ttl_percentiles)

    async def get_volatility(self, asset: str) -> Optional[Dict]:
        """Get forward + realized vol forecasts."""
        return await self._get(f"/insights/volatility?asset={asset}", self._ttl_vol)

    def get_cached_percentiles(self, asset: str) -> Optional[Dict]:
        """Return already-cached percentile data without making a new API call."""
        cache_key = f"/insights/prediction-percentiles?asset={asset}"
        return self._cache.get(cache_key)

    def get_status(self) -> Dict:
        return {
            "enabled": self.enabled,
            "calls_this_month": self._call_count,
            "monthly_limit": SYNTHDATA_MONTHLY_LIMIT,
            "cache_entries": len(self._cache),
            "last_error": self.last_error,
        }
