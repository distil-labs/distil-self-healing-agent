"""
Industrial IoT Gateway — Schema Validation Service

This gateway validates incoming JSON telemetry payloads against a strict
APPROVED_SCHEMA. Any field not in the approved list triggers a CRITICAL
SCHEMA_MISMATCH error and halts the process.

Key variable for automated remediation:
    config/demo_contract.json -> iot_gateway.approved_schema
"""

import logging
import json
import sys
from pathlib import Path

logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S%z",
)
logger = logging.getLogger("industrial_gateway")

PROJECT_ROOT = Path(__file__).resolve().parents[1]
CONTRACT_PATH = PROJECT_ROOT / "config" / "demo_contract.json"


def load_gateway_contract() -> tuple[list[str], str]:
    """Load the shared demo contract that defines the active gateway schema."""
    with CONTRACT_PATH.open() as f:
        contract = json.load(f)
    gateway = contract["iot_gateway"]
    return list(gateway["approved_schema"]), gateway["mqtt_topic"]


# APPROVED_SCHEMA is intentionally sourced from config/demo_contract.json so
# the gateway, Worker, dashboard, and prompt all share the same allowlist.
APPROVED_SCHEMA, MQTT_TOPIC = load_gateway_contract()


def validate_payload(payload: dict) -> None:
    """
    Validate that every key in *payload* is present in APPROVED_SCHEMA.

    Raises SystemExit(1) on the first unexpected field.
    """
    for field in payload:
        if field not in APPROVED_SCHEMA:
            logger.critical(
                "SCHEMA_MISMATCH: Unexpected field '%s' detected in MQTT topic '%s'",
                field,
                MQTT_TOPIC,
            )
            sys.exit(1)

    logger.info("Payload validated successfully for topic '%s'", MQTT_TOPIC)


def ingest(raw_json: str) -> None:
    """Parse raw JSON string and run schema validation."""
    logger.info("Gateway received message on topic '%s'", MQTT_TOPIC)
    try:
        payload = json.loads(raw_json)
    except json.JSONDecodeError as exc:
        logger.critical("MALFORMED_JSON: %s", exc)
        sys.exit(1)

    validate_payload(payload)
    logger.info("Telemetry accepted: %s", payload)


if __name__ == "__main__":
    # Accept a JSON string from stdin or as a CLI argument
    if len(sys.argv) > 1:
        raw = sys.argv[1]
    else:
        raw = sys.stdin.read()

    ingest(raw)
