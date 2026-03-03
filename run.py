#!/usr/bin/env python3
"""Entry point for the Synth-Vol Triangulator backend.

Usage:
    python run.py                    # Live mode (requires SYNTHDATA_API_KEY)
    MOCK_MODE=1 python run.py        # Demo mode (no API keys needed)
"""

import logging
import os

import uvicorn
from dotenv import load_dotenv

load_dotenv()  # loads .env if present (file is gitignored)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)

if __name__ == "__main__":
    mock_mode = os.environ.get("MOCK_MODE", "0") == "1"
    port = int(os.environ.get("PORT", 8000))

    print(f"""
╔══════════════════════════════════════════════════╗
║  Synth-Vol Triangulator — Backend                ║
╠══════════════════════════════════════════════════╣
║  Mode: {"DEMO (mock data)" if mock_mode else "LIVE (real API data)"}
║  Backend: http://localhost:{port}
║  Health:  http://localhost:{port}/health
╚══════════════════════════════════════════════════╝
""")

    if not mock_mode and not os.environ.get("SYNTHDATA_API_KEY"):
        print("⚠  SYNTHDATA_API_KEY not set — SynthData curves will be unavailable.")
        print("   Run with MOCK_MODE=1 for a full demo experience.\n")

    uvicorn.run(
        "api.main:app",
        host="0.0.0.0",
        port=port,
        reload=False,
        log_level="info",
    )
