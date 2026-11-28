"""ADR 0069: the laptop battery is read with ctypes and GetSystemPowerStatus, not psutil. Requirements: REQ-DB-002."""
import sys
import pytest
from ppe_host.io import health as H
from ppe_host.io.health import default_battery as REAL_DEFAULT_BATTERY      # taken at import time, before conftest replaces it for every test

def test_on_battery_with_a_percentage():
    assert H.battery_from_status(0, 0, 54) == (True, 54)

def test_on_mains_is_not_on_battery():
    assert H.battery_from_status(1, 8, 100) == (False, 100)

def test_unknown_is_never_on_battery():
    assert H.battery_from_status(255, 255, 255) == (False, None)
    assert H.battery_from_status(255, 0, 40) == (False, None)

def test_no_system_battery_is_not_on_battery():
    assert H.battery_from_status(0, 128, 255) == (False, None)
    assert H.battery_from_status(1, 128, 255) == (False, None)

def test_an_unknown_percentage_is_none():
    assert H.battery_from_status(0, 0, 255) == (True, None)

def test_default_battery_uses_the_raw_status(monkeypatch):
    monkeypatch.setattr(H, '_read_power_status', lambda: (0, 0, 21))
    assert REAL_DEFAULT_BATTERY() == (True, 21)
    monkeypatch.setattr(H, '_read_power_status', lambda: (1, 8, 77))
    assert REAL_DEFAULT_BATTERY() == (False, 77)

def test_default_battery_is_unknown_when_the_call_gives_nothing(monkeypatch):
    monkeypatch.setattr(H, '_read_power_status', lambda: None)
    assert REAL_DEFAULT_BATTERY() == (False, None)

def test_off_windows_the_call_is_not_made(monkeypatch):
    monkeypatch.setattr(H.sys, 'platform', 'linux')
    assert H._read_power_status() is None

def test_the_struct_matches_system_power_status():
    import ctypes
    assert ctypes.sizeof(H._SystemPowerStatus) == 12      # 4 bytes, then two 4-byte values: the size of SYSTEM_POWER_STATUS

@pytest.mark.skipif(sys.platform != 'win32', reason='GetSystemPowerStatus exists only on Windows')
def test_on_windows_the_real_call_answers():
    raw = H._read_power_status()
    assert raw is not None and len(raw) == 3 and all(isinstance(x, int) for x in raw)
    on_battery, pct = REAL_DEFAULT_BATTERY()
    assert isinstance(on_battery, bool) and (pct is None or 0 <= pct <= 100)
