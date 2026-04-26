"""
Diagnosis Script — Captures the IoT crash and routes diagnosis through the Worker.

Default flow:
  1. Runs reproduce_crash.py to capture the gateway error log.
  2. Sends the crash log to the Cloudflare Worker /api/diagnose endpoint.
  3. Saves the returned structured diagnosis for Warp Oz.
  4. Uses the Worker's stored /api/diagnosis handoff so the dashboard and Oz
     polling path share the same state.

Use --direct to call the Distil endpoint directly for Worker debugging.
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import urljoin

import requests

try:
    from dotenv import load_dotenv
except ImportError:
    def load_dotenv(*_args, **_kwargs):
        return False

PROJECT_ROOT = Path(__file__).resolve().parents[1]
CONTRACT_PATH = PROJECT_ROOT / "config" / "demo_contract.json"
OUTPUT_PATH = PROJECT_ROOT / "diagnosis_output.json"

load_dotenv(PROJECT_ROOT / ".env")

ENDPOINT = os.getenv("DISTIL_ENDPOINT")
API_KEY = os.getenv("DISTIL_API_KEY")
MODEL = os.getenv("DISTIL_MODEL")
DEFAULT_WORKER_URL = os.getenv("WORKER_URL", "http://localhost:8788")


def load_contract() -> dict:
    with CONTRACT_PATH.open() as f:
        return json.load(f)


def capture_crash_log() -> str:
    """Run reproduce_crash.py and return the combined stdout/stderr output."""
    gateway_dir = PROJECT_ROOT / "iot-gateway"
    result = subprocess.run(
        [sys.executable, "reproduce_crash.py"],
        capture_output=True,
        text=True,
        cwd=gateway_dir,
    )

    full_output = ""
    if result.stdout:
        full_output += result.stdout
    if result.stderr:
        full_output += result.stderr
    return full_output


def build_codebase_context(contract: dict) -> str:
    gateway = contract["iot_gateway"]
    diagnosis = contract["diagnosis"]
    return "\n".join(
        [
            "CODEBASE MANIFEST:",
            f"- File: {gateway['schema_file']}",
            f"  - Field: {gateway['schema_path']} = {json.dumps(gateway['approved_schema'])}",
            f"  - Remediation: {diagnosis['fix_action']}",
            f"  - Updated value: {json.dumps(diagnosis['new_value'])}",
            f"- File: {gateway['file']}",
            f"  - MQTT topic: {gateway['mqtt_topic']}",
            f"  - Behavior: {gateway['behavior']}",
            "- File: iot-gateway/reproduce_crash.py",
            f"  - Sends test payload: {json.dumps(contract['payloads']['bad'])}",
        ]
    )


def build_prompt(crash_log: str) -> str:
    """Construct the diagnostic prompt for direct Distil calls."""
    contract = load_contract()
    return (
        "You are an IoT infrastructure diagnostics engine.\n"
        "You have access to the following codebase information:\n\n"
        f"{build_codebase_context(contract)}\n\n"
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


def extract_first_json(text: str) -> str:
    """Pull the first valid JSON object from potentially noisy SLM output."""
    for start, char in enumerate(text):
        if char != "{":
            continue

        depth = 0
        in_string = False
        escaped = False

        for index in range(start, len(text)):
            current = text[index]

            if in_string:
                if escaped:
                    escaped = False
                elif current == "\\":
                    escaped = True
                elif current == '"':
                    in_string = False
                continue

            if current == '"':
                in_string = True
            elif current == "{":
                depth += 1
            elif current == "}":
                depth -= 1
                if depth == 0:
                    candidate = text[start : index + 1]
                    try:
                        return json.dumps(json.loads(candidate), indent=2)
                    except json.JSONDecodeError:
                        break

    try:
        return json.dumps(json.loads(text.strip()), indent=2)
    except json.JSONDecodeError:
        return text.strip()


def call_worker(worker_url: str, crash_log: str) -> tuple[dict, bool]:
    """Send the crash log to the Worker diagnosis API."""
    endpoint = urljoin(worker_url.rstrip("/") + "/", "api/diagnose")
    resp = requests.post(endpoint, json={"crash_log": crash_log}, timeout=60)
    resp.raise_for_status()
    data = resp.json()

    if "diagnosis" not in data:
        raise RuntimeError(f"Worker response did not include diagnosis: {data}")
    return data["diagnosis"], bool(data.get("stored"))


def publish_to_worker(worker_url: str, diagnosis: dict) -> None:
    """Publish a diagnosis for Warp Oz polling."""
    endpoint = urljoin(worker_url.rstrip("/") + "/", "api/diagnosis")
    resp = requests.post(endpoint, json={"diagnosis": diagnosis}, timeout=10)
    resp.raise_for_status()


def call_distil_slm(prompt: str) -> dict:
    """Send the prompt directly to the Distil Labs SLM and return parsed JSON."""
    if not ENDPOINT or not API_KEY or not MODEL:
        raise RuntimeError("DISTIL_ENDPOINT, DISTIL_API_KEY, and DISTIL_MODEL are required for --direct")

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {API_KEY}",
    }
    payload = {
        "max_tokens": 250,
        "model": MODEL,
        "stream": False,
        "temperature": 0,
        "prompt": prompt,
    }

    print("[diagnose] Calling Distil Labs SLM directly ...")
    resp = requests.post(ENDPOINT, headers=headers, json=payload, timeout=60)
    resp.raise_for_status()

    data = resp.json()
    if "choices" in data and data["choices"]:
        raw_text = data["choices"][0].get("text", "")
        parsed_text = extract_first_json(raw_text) if raw_text else json.dumps(data, indent=2)
    else:
        parsed_text = json.dumps(data, indent=2)

    return json.loads(parsed_text)


def save_diagnosis(diagnosis: dict) -> None:
    with OUTPUT_PATH.open("w") as f:
        json.dump(diagnosis, f, indent=2)
        f.write("\n")
    print(f"\n[diagnose] Diagnosis saved to {OUTPUT_PATH}")


def validate_diagnosis(diagnosis: dict) -> None:
    expected_keys = {"root_cause", "file", "variable", "fix_action", "new_value"}
    present = set(diagnosis.keys()) & expected_keys
    missing = expected_keys - present
    print(f"[diagnose] Diagnosis keys present: {present}")
    if missing:
        print(f"[diagnose] WARNING - missing keys: {missing}")
    else:
        print("[diagnose] All expected keys present. Ready for Warp Oz.")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Capture and diagnose the IoT schema crash.")
    parser.add_argument(
        "--worker-url",
        default=DEFAULT_WORKER_URL,
        help="Worker base URL used for the canonical diagnosis flow.",
    )
    parser.add_argument(
        "--direct",
        action="store_true",
        help="Call the Distil endpoint directly instead of routing through the Worker.",
    )
    parser.add_argument(
        "--no-publish",
        action="store_true",
        help="Do not publish the diagnosis back to /api/diagnosis.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    print("=" * 60)
    print("  SELF-HEALING LOOP - STEP 1: CAPTURE CRASH")
    print("=" * 60)
    crash_log = capture_crash_log()
    print(crash_log)

    print("=" * 60)
    print("  SELF-HEALING LOOP - STEP 2: DIAGNOSE")
    print("=" * 60)

    stored_by_worker = False
    if args.direct:
        prompt = build_prompt(crash_log)
        print(f"[diagnose] Prompt length: {len(prompt)} chars\n")
        diagnosis = call_distil_slm(prompt)
    else:
        print(f"[diagnose] Calling Worker at {args.worker_url} ...")
        diagnosis, stored_by_worker = call_worker(args.worker_url, crash_log)

    print("=" * 60)
    print("  DIAGNOSIS RESULT")
    print("=" * 60)
    print(json.dumps(diagnosis, indent=2))

    save_diagnosis(diagnosis)

    if not args.no_publish:
        if stored_by_worker:
            print(f"[diagnose] Worker stored diagnosis at {args.worker_url}/api/diagnosis")
        else:
            publish_to_worker(args.worker_url, diagnosis)
            print(f"[diagnose] Published diagnosis to {args.worker_url}/api/diagnosis")

    validate_diagnosis(diagnosis)


if __name__ == "__main__":
    main()
