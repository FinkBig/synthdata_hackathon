"""Standalone config for Synth-Vol Triangulator."""

import os

BINANCE_BASE_URL = "https://api.binance.com"
BINANCE_SYMBOLS = {"BTC": "BTCUSDT", "ETH": "ETHUSDT"}

DERIVE_BASE_URL = "https://api.lyra.finance/public"
POLYMARKET_GAMMA_URL = "https://gamma-api.polymarket.com"
SYNTHDATA_BASE_URL = "https://api.synthdata.co"
SYNTHDATA_MONTHLY_LIMIT = 4500
SYNTHDATA_402_BACKOFF_SEC = 3600

ASSETS = ["BTC", "ETH"]
EDGE_THRESHOLD_PCT = 0.03      # 3% minimum edge to flag signal
MOCK_MODE = os.environ.get("MOCK_MODE", "0") == "1"

# Polymarket asset names used in question text
POLYMARKET_ASSETS = ["BTC", "ETH", "SOL", "BNB"]

# Map display names → tickers for Polymarket question parsing
TICKER_TO_NAME = {
    "BTC": "Bitcoin",
    "ETH": "Ethereum",
    "SOL": "Solana",
    "BNB": "Binance Coin",
}
