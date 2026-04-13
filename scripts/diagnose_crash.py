"""
Diagnosis Script — Feeds crash logs into the Distil Labs SLM

This script:
  1. Runs reproduce_crash.py to capture the gateway error log.
  2. Constructs a diagnostic prompt from the captured log.
  3. Sends it to the Distil Labs 'massive-iot-traces1' model on inferx.net.
  4. Prints the structured diagnosis — ready for Warp Oz to consume.
"""

import json
import os
import re
import subprocess
import sys

import requests
from dotenv import load_dotenv

# Load .env from project root
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(PROJECT_ROOT, ".env"))

ENDPOINT = os.getenv("DISTIL_ENDPOINT")
API_KEY = os.getenv("DISTIL_API_KEY")
MODEL = os.getenv("DISTIL_MODEL")


def capture_crash_log() -> str:
    """Run reproduce_crash.py and return the combined stderr output."""
    gateway_dir = os.path.join(PROJECT_ROOT, "iot-gateway")
    result = subprocess.run(
        [sys.executable, "reproduce_crash.py"],
        capture_output=True,
        text=True,
        cwd=gateway_dir,
    )
    # The gateway's log lines go to stderr via the logging module
    # We also include stdout for full context
    full_output = ""
    if result.stdout:
        full_output += result.stdout
    if result.stderr:
        full_output += result.stderr
    return full_output


# Codebase context injected into the prompt so the SLM can ground
# its diagnosis against real file names, variables, and values.
CODEBASE_CONTEXT = """
CODEBASE MANIFEST:
- File: industrial_gateway.py
  - Variable: APPROVED_SCHEMA = ["device_id", "temp", "pressure"]
  - Variable: MQTT_TOPIC = "factory/v3/telemetry"
  - Behavior: Validates incoming JSON. Logs CRITICAL SCHEMA_MISMATCH and exits 1
    if any payload field is not in APPROVED_SCHEMA.
- File: reproduce_crash.py
  - Sends test payload: {"device_id": "plc-conveyor-07", "temp": 81.3, "pressure": 1.02, "vibration_hz": 42.7}
""".strip()


def build_prompt(crash_log: str) -> str:
    """Construct the diagnostic prompt for the SLM."""
    return (
        "You are an IoT infrastructure diagnostics engine.\n"
        "You have access to the following codebase information:\n\n"
        f"{CODEBASE_CONTEXT}\n\n"
        "--- CRASH LOG ---\n"
        f"{crash_log.strip()}\n"
        "--- END LOG ---\n\n"
        "Analyze the crash log above. Using ONLY the files and variables listed "
        "in the CODEBASE MANIFEST, produce a single JSON object with these fields:\n"
        '  "root_cause": short description of the failure,\n'
        '  "file": exact filename that must be edited,\n'
        '  "variable": exact variable name that must be changed,\n'
        '  "fix_action": what to do (e.g. append a value to a list),\n'
        '  "new_value": the updated value after the fix.\n\n'
        "Respond with ONLY the JSON object. No markdown, no explanation, no repetition.\n"
    )


def call_distil_slm(prompt: str) -> str:
    """Send the prompt to the Distil Labs SLM and return the response."""
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {API_KEY}",
    }
    payload = {
        "max_tokens": "250",
        "model": MODEL,
        "stream": "false",
        "temperature": "0",
        "prompt": prompt,
    }

    print("[diagnose] Calling Distil Labs SLM at inferx.net ...")
    resp = requests.post(ENDPOINT, headers=headers, json=payload, timeout=60)
    resp.raise_for_status()

    data = resp.json()
    # OpenAI-compatible completions format
    if "choices" in data and len(data["choices"]) > 0:
        raw_text = data["choices"][0].get("text", "")
        return extract_first_json(raw_text) if raw_text else json.dumps(data, indent=2)
    return json.dumps(data, indent=2)


def extract_first_json(text: str) -> str:
    """Pull the first valid JSON object from potentially noisy SLM output."""
    # Try to find a JSON block between { }
    match = re.search(r'\{[^{}]*\}', text, re.DOTALL)
    if match:
        candidate = match.group(0)
        try:
            parsed = json.loads(candidate)
            return json.dumps(parsed, indent=2)
        except json.JSONDecodeError:
            pass
    # Fallback: return the raw text stripped
    return text.strip()


def main():
    print("=" * 60)
    print("  SELF-HEALING LOOP — STEP 1: CAPTURE CRASH")
    print("=" * 60)
    crash_log = capture_crash_log()
    print(crash_log)

    print("=" * 60)
    print("  SELF-HEALING LOOP — STEP 2: DIAGNOSE VIA DISTIL LABS SLM")
    print("=" * 60)
    prompt = build_prompt(crash_log)
    print(f"[diagnose] Prompt length: {len(prompt)} chars\n")

    diagnosis = call_distil_slm(prompt)

    print("=" * 60)
    print("  DIAGNOSIS RESULT")
    print("=" * 60)
    print(diagnosis)

    # Write diagnosis to file for Warp Oz to pick up
    output_path = os.path.join(PROJECT_ROOT, "diagnosis_output.json")
    with open(output_path, "w") as f:
        f.write(diagnosis)
    print(f"\n[diagnose] Diagnosis saved to {output_path}")

    # Validate the diagnosis has the expected keys
    try:
        diag = json.loads(diagnosis)
        expected_keys = {"root_cause", "file", "variable", "fix_action", "new_value"}
        present = set(diag.keys()) & expected_keys
        missing = expected_keys - present
        print(f"[diagnose] Diagnosis keys present: {present}")
        if missing:
            print(f"[diagnose] WARNING — missing keys: {missing}")
        else:
            print("[diagnose] All expected keys present. Ready for Warp Oz.")
    except json.JSONDecodeError:
        print("[diagnose] WARNING — Output is not valid JSON. May need prompt tuning.")


if __name__ == "__main__":
    main()
