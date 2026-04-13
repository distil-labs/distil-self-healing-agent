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

# Simulated payload from an upgraded sensor firmware (v2.4)
# that now reports vibration data the gateway doesn't expect.
PAYLOAD = {
    "device_id": "plc-conveyor-07",
    "temp": 81.3,
    "pressure": 1.02,
    "vibration_hz": 42.7,  # <-- NEW field causing the crash
}


def main():
    raw_json = json.dumps(PAYLOAD)
    print(f"[reproduce_crash] Sending payload to industrial_gateway.py:")
    print(f"  {raw_json}\n")

    result = subprocess.run(
        [sys.executable, "industrial_gateway.py", raw_json],
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
              "Check APPROVED_SCHEMA.")

    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
