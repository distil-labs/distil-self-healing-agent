"""
Crash Reproduction Script — Simulates Firmware Schema Evolution

This script sends a telemetry payload that includes a NEW field
'vibration_hz', simulating a firmware update that the current
industrial gateway is not prepared to handle.

Expected result: The gateway logs a CRITICAL SCHEMA_MISMATCH and exits 1.
The captured error log is fed into the Distil Labs 'massive-iot-traces1'
model for automated root-cause diagnosis.
"""

import subprocess
import sys
import json
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
CONTRACT_PATH = PROJECT_ROOT / "config" / "demo_contract.json"
GATEWAY_PATH = Path(__file__).with_name("industrial_gateway.py")


def load_bad_payload() -> dict:
    """Load the schema-evolution payload from the shared demo contract."""
    with CONTRACT_PATH.open() as f:
        contract = json.load(f)
    return contract["payloads"]["bad"]


def main():
    payload = load_bad_payload()
    raw_json = json.dumps(payload)
    print(f"[reproduce_crash] Sending payload to industrial_gateway.py:")
    print(f"  {raw_json}\n")

    result = subprocess.run(
        [sys.executable, str(GATEWAY_PATH), raw_json],
        capture_output=True,
        text=True,
    )

    print("— STDOUT —")
    print(result.stdout)
    print("— STDERR —")
    print(result.stderr)
    print(f"— EXIT CODE: {result.returncode} —")

    if result.returncode != 0:
        print("\n[reproduce_crash] Gateway crashed as expected. "
              "Error log captured above for Distil Labs diagnosis.")
    else:
        print("\n[reproduce_crash] WARNING: Gateway did NOT crash. "
              "Check the shared approved schema.")

    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
