"""
Warp Oz Polling Script — Pulls diagnosis from the Self-Healing Loop dashboard.

This script polls the /api/diagnosis endpoint on the Cloudflare Worker
every few seconds. When a diagnosis is available, it:
  1. Saves it to diagnosis_output.json
  2. Prints it for Warp Oz to consume
  3. Clears the diagnosis from the server (DELETE)

Usage:
    python3 warp_oz_poll.py                          # defaults to http://localhost:8788
    python3 warp_oz_poll.py https://self-healing-api.<account>.workers.dev
"""

import json
import sys
import time

import requests

BASE_URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8788"
POLL_ENDPOINT = f"{BASE_URL}/api/diagnosis"
POLL_INTERVAL = 3  # seconds
OUTPUT_FILE = "diagnosis_output.json"


def poll():
    print(f"[warp_oz_poll] Polling {POLL_ENDPOINT} every {POLL_INTERVAL}s ...")
    print(f"[warp_oz_poll] Waiting for diagnosis...\n")

    while True:
        try:
            resp = requests.get(POLL_ENDPOINT, timeout=10)
            resp.raise_for_status()
            data = resp.json()

            if data.get("status") == "ready" and data.get("diagnosis"):
                diagnosis = data["diagnosis"]
                timestamp = data.get("timestamp", "unknown")

                print("=" * 60)
                print(f"  DIAGNOSIS RECEIVED at {timestamp}")
                print("=" * 60)
                print(json.dumps(diagnosis, indent=2))

                # Save to file for Warp Oz to consume
                with open(OUTPUT_FILE, "w") as f:
                    json.dump(diagnosis, f, indent=2)
                print(f"\n[warp_oz_poll] Saved to {OUTPUT_FILE}")

                # Clear the diagnosis from the server
                try:
                    requests.delete(POLL_ENDPOINT, timeout=10)
                    print("[warp_oz_poll] Cleared diagnosis from server.")
                except Exception:
                    print("[warp_oz_poll] Warning: could not clear diagnosis from server.")

                print("\n[warp_oz_poll] Handing off to Warp Oz for remediation.")
                return diagnosis

            else:
                sys.stdout.write(".")
                sys.stdout.flush()

        except requests.ConnectionError:
            sys.stdout.write("x")
            sys.stdout.flush()
        except Exception as e:
            print(f"\n[warp_oz_poll] Error: {e}")

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    diagnosis = poll()
    print("\n[warp_oz_poll] Diagnosis ready. Warp Oz should now execute remediation.")
    print(f"[warp_oz_poll] See {OUTPUT_FILE} and warp_instructions.md for next steps.")
