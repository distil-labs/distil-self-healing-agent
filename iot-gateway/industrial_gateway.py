"""
Industrial IoT Gateway — Schema Validation Service

This gateway validates incoming JSON telemetry payloads against a strict
APPROVED_SCHEMA. Any field not in the approved list triggers a CRITICAL
SCHEMA_MISMATCH error and halts the process.

Key variable for automated remediation:
    APPROVED_SCHEMA (list): The allowlist of accepted telemetry fields.
    Location: line ~20 of this file.
"""

import json
import sys
import logging
from datetime import datetime, timezone

logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S%z",
)
logger = logging.getLogger("industrial_gateway")

# ──────────────────────────────────────────────
# APPROVED_SCHEMA — the only fields the gateway will accept.
# To onboard a new sensor field, append it to this list.
# ──────────────────────────────────────────────
APPROVED_SCHEMA = ["device_id", "temp", "pressure"]

MQTT_TOPIC = "factory/v3/telemetry"


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
