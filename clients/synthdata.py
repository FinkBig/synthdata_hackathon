"""SynthData API client for AI ensemble predictions.

Fetches probability estimates from SynthData's decentralized AI network (Bittensor subnet).
Endpoints used:
  /prediction-percentiles        — full CDF reconstruction (9 quantiles × 289 steps)
  /insights/volatility           — forecast + realized vol
  /insights/lp-probabilities     — P(price > K) at many strikes
  /insights/lp-bounds            — range-stay probabilities + expected IL
  /insights/liquidation          — P(liquidation) by price-move threshold
  /insights/polymarket/up-down/daily — pre-computed synth vs Poly edge

Credit budget: 1 credit per call (flat rate). ~528 credits/day at planned TTLs.
"""

import logging
import os
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import aiohttp

# Standalone config
SYNTHDATA_BASE_URL = "https://api.synthdata.co"
SYNTHDATA_CREDIT_BUDGET = 18_983   # remaining credits as of project start
SYNTHDATA_CREDIT_WARN_AT = 2_000   # log warning when below this
SYNTHDATA_402_BACKOFF_SEC = 3600
SYNTHDATA_429_BACKOFF_SEC = 300  # 5 min back-off per endpoint on rate-limit
MIN_TTL = 300  # no endpoint may cache for less than 5 minutes

logger = logging.getLogger(__name__)

# Percentile CDF keys in the API response, sorted by probability
_PERCENTILE_KEYS = ["0.005", "0.05", "0.2", "0.35", "0.5", "0.65", "0.8", "0.95", "0.995"]


class SynthDataClient:
    def __init__(self):
        self._session: Optional[aiohttp.ClientSession] = None
        self._api_key: Optional[str] = os.environ.get("SYNTHDATA_API_KEY")

        self._cache: Dict[str, Any] = {}
        self._cache_ts: Dict[str, float] = {}

        # TTLs in seconds — tuned to data change frequency vs. credit budget
        self._ttl_percentiles = 30 * 60   # 30 min  — live model updates every 5 min, cache is fine
        self._ttl_vol         = 60 * 60   # 60 min  — regime shifts are hourly
        self._ttl_lp_probs    = 60 * 60   # 60 min  — price-level probabilities
        self._ttl_lp_bounds   = 2  * 3600 # 2 hours — range widths change slowly
        self._ttl_liquidation = 2  * 3600 # 2 hours — vol-driven, slow-moving
        self._ttl_poly_signal = 10 * 60   # 10 min  — tracks live Poly prices

        self._call_count = 0

        self.last_error: Optional[str] = None
        self.enabled = bool(self._api_key)
        self._disabled_until: float = 0.0          # global 402 backoff
        self._endpoint_disabled: Dict[str, float] = {}  # per-endpoint 429 backoff

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
        remaining = SYNTHDATA_CREDIT_BUDGET - self._call_count
        if remaining <= 0:
            logger.warning("SynthData credit budget exhausted (%d credits used)", self._call_count)
            return False
        if remaining <= SYNTHDATA_CREDIT_WARN_AT:
            logger.warning("SynthData credits low: %d remaining", remaining)
        return True

    def _record_call(self):
        self._call_count += 1

    def _is_cached(self, key: str, ttl: float) -> bool:
        return key in self._cache and (time.time() - self._cache_ts.get(key, 0)) < ttl

    async def _get(self, endpoint: str, ttl: float) -> Optional[Any]:
        if not self.enabled:
            return None

        ttl = max(ttl, MIN_TTL)  # never cache for less than 5 minutes
        cache_key = endpoint
        if self._is_cached(cache_key, ttl):
            return self._cache[cache_key]

        now = time.time()

        # Global 402 backoff (credit exhaustion)
        if now < self._disabled_until:
            self.last_error = "402 backoff (insufficient credits)"
            return self._cache.get(cache_key)

        # Per-endpoint 429 backoff (rate limit)
        if now < self._endpoint_disabled.get(cache_key, 0):
            return self._cache.get(cache_key)

        if not self._check_budget():
            self.last_error = "Credit budget exhausted"
            return self._cache.get(cache_key)

        session = await self._ensure_session()
        url = f"{SYNTHDATA_BASE_URL}{endpoint}"
        try:
            async with session.get(url) as resp:
                if resp.status == 402:
                    self._disabled_until = time.time() + SYNTHDATA_402_BACKOFF_SEC
                    logger.warning("SynthData 402 — pausing %d min. %d credits used so far.",
                                   SYNTHDATA_402_BACKOFF_SEC // 60, self._call_count)
                    self.last_error = "402 Insufficient credits (backoff)"
                    return self._cache.get(cache_key)
                if resp.status == 429:
                    self._endpoint_disabled[cache_key] = time.time() + SYNTHDATA_429_BACKOFF_SEC
                    logger.warning("SynthData 429 rate limit on %s — backing off %ds",
                                   endpoint, SYNTHDATA_429_BACKOFF_SEC)
                    self.last_error = "429 rate limit"
                    return self._cache.get(cache_key)
                if resp.status != 200:
                    text = await resp.text()
                    logger.warning("SynthData %s → %d: %s", endpoint, resp.status, text[:200])
                    self.last_error = f"HTTP {resp.status}"
                    return None
                data = await resp.json()
                self._record_call()
                self._cache[cache_key] = data
                self._cache_ts[cache_key] = time.time()
                self.last_error = None
                return data
        except Exception as e:
            logger.error("SynthData %s error: %s", endpoint, e)
            self.last_error = str(e)
            return None

    async def get_prediction_percentiles(self, asset: str) -> Optional[Dict]:
        """Full CDF: 289 timesteps × 9 quantiles. Core signal source."""
        return await self._get(f"/insights/prediction-percentiles?asset={asset}", self._ttl_percentiles)

    async def get_volatility(self, asset: str) -> Optional[Dict]:
        """Forecast + realized vol. Used for vol regime detection and Kelly scaling."""
        return await self._get(f"/insights/volatility?asset={asset}", self._ttl_vol)

    async def get_lp_probabilities(self, asset: str) -> Optional[Dict]:
        """P(price > K) and P(price < K) at many strikes over 24h.
        Cross-validates synth_curve from prediction-percentiles."""
        return await self._get(f"/insights/lp-probabilities?asset={asset}", self._ttl_lp_probs)

    async def get_lp_bounds(self, asset: str) -> Optional[Dict]:
        """Range-stay probability and expected IL by range width.
        Directly prices the_pin strategy: P(price stays in [lower, upper] for 24h)."""
        return await self._get(f"/insights/lp-bounds?asset={asset}", self._ttl_lp_bounds)

    async def get_liquidation(self, asset: str) -> Optional[Dict]:
        """P(liquidation) by price-move threshold for long and short positions.
        Used to select optimal leverage for the Hyperliquid perp hedge."""
        return await self._get(f"/insights/liquidation?asset={asset}", self._ttl_liquidation)

    async def get_polymarket_signal(self, asset: str) -> Optional[Dict]:
        """SynthData's own pre-computed synth_probability vs polymarket_probability.
        Used as 4th confirmation source for CONVICTION tier signals."""
        return await self._get(f"/insights/polymarket/up-down/daily?asset={asset}", self._ttl_poly_signal)

    def get_cached_percentiles(self, asset: str) -> Optional[Dict]:
        """Return cached percentile data without making a new API call."""
        return self._cache.get(f"/insights/prediction-percentiles?asset={asset}")

    def credits_used(self) -> int:
        return self._call_count

    def credits_remaining(self) -> int:
        return max(0, SYNTHDATA_CREDIT_BUDGET - self._call_count)

    def get_status(self) -> Dict:
        return {
            "enabled": self.enabled,
            "credits_used": self.credits_used(),
            "credits_remaining": self.credits_remaining(),
            "credit_budget": SYNTHDATA_CREDIT_BUDGET,
            "cache_entries": len(self._cache),
            "in_backoff": self.in_backoff(),
            "last_error": self.last_error,
        }
