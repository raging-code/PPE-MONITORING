"""clock.py: the injected Clock interface (design 1, Clock abstraction; 14.1). Every host timer reads wall_ms() and mono_ms() from a
Clock, never from time.*, so tests and REPLAY control time. P5 holds the interface and FakeClock; P12b adds the real clock here."""
from typing import Protocol
from .core.rule_engine import Now

class Clock(Protocol):
    def wall_ms(self) -> int: ...   # UTC milliseconds (display and stored timestamps)
    def mono_ms(self) -> int: ...   # monotonic milliseconds (all timers)

def now_of(clock):
    return Now(clock.wall_ms(), clock.mono_ms())

def _ms(v, name):
    if isinstance(v, bool) or not isinstance(v, int) or v < 0: raise ValueError(f'{name} must be a non-negative int')
    return v

class FakeClock:
    """Test clock that moves only when told to."""
    def __init__(self, wall_ms=0, mono_ms=0):
        self._wall, self._mono = _ms(wall_ms, 'wall_ms'), _ms(mono_ms, 'mono_ms')
    def wall_ms(self): return self._wall
    def mono_ms(self): return self._mono
    def advance(self, ms):
        """Time passes: both clocks move forward by ms."""
        ms = _ms(ms, 'ms'); self._wall += ms; self._mono += ms
    def set_wall(self, ms):
        """A laptop clock step (NTP): wall time jumps, monotonic time does not."""
        self._wall = _ms(ms, 'wall_ms')
    def now(self):
        return now_of(self)
