"""
Production-style telemetry sender for the demo IoT gateway.

This represents the example production service sending telemetry into the
Worker ingest API. The dashboard can trigger a demo event, but this script is
the production-service path described in the architecture.
"""

import argparse
import json
import os
from pathlib import Path

import requests

PROJECT_ROOT = Path(__file__).resolve().parents[1]
CONTRACT_PATH = PROJECT_ROOT / "config" / "demo_contract.json"
DEFAULT_WORKER_URL = os.getenv("WORKER_URL", "http://localhost:8788")


def load_payload(kind: str) -> dict:
    with CONTRACT_PATH.open() as f:
        contract = json.load(f)
    return contract["payloads"][kind]


def main() -> None:
    parser = argparse.ArgumentParser(description="Send IoT telemetry to the Worker ingest API.")
    parser.add_argument("--worker-url", default=DEFAULT_WORKER_URL)
    parser.add_argument("--good", action="store_true", help="Send the accepted telemetry payload.")
    args = parser.parse_args()

    payload = load_payload("good" if args.good else "bad")
    endpoint = f"{args.worker_url.rstrip('/')}/api/telemetry"

    print(f"[send_telemetry] POST {endpoint}")
    print(json.dumps(payload, indent=2))

    resp = requests.post(endpoint, json=payload, timeout=30)
    print(f"[send_telemetry] status={resp.status_code}")
    print(json.dumps(resp.json(), indent=2))
    resp.raise_for_status()


if __name__ == "__main__":
    main()
