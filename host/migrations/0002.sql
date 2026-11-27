-- Migration 0002: system_event_types gains FW_REPORTED, ABI_MISMATCH and ABI_OK (P24-5e, ADR 0050)
INSERT INTO system_event_types(kind) VALUES ('FW_REPORTED'),('ABI_MISMATCH'),('ABI_OK');
