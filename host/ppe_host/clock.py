"""clock.py: the injected Clock interface (design 1, Clock abstraction; 14.1). Every host timer reads wall_ms() and mono_ms() from a
Clock, never from time.*, so tests and REPLAY control time. P5 holds the interface and FakeClock; P12b adds the real clock here."""
import time
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

class RealClock:
    """The real clock (P12b): wall_ms from the system clock (it can step with NTP), mono_ms from time.monotonic (it cannot). The only place outside tests that reads time.*."""
    def wall_ms(self): return time.time_ns() // 1_000_000
    def mono_ms(self): return time.monotonic_ns() // 1_000_000
class ScaledClock:
    """S7-3 (ADR 0059): the Clock of REPLAY. Time starts at the base clock's values when it is made and then runs `speed` times as fast as the base (1, 4 or 16), so every host timer that reads
    it (15 s / 60 s link loss, 30 s stillness, 10 s CO hysteresis, 120 s heat, the dedup window) runs at replay speed. pause() stops it (neither wall_ms nor mono_ms moves), resume() starts it again.
    wall_ms is the wall time at the start plus the scaled elapsed time; it does not follow a step of the base's wall clock (an NTP step cannot reorder a replay). The OS watchdog and its liveness stamps
    must NOT use this clock: a 3 s stall limit read at 16x would be 0.19 s of real time (Runtime keeps the base clock for them)."""
    def __init__(self, base, speed=1):
        if isinstance(speed, bool) or not isinstance(speed, (int, float)) or not speed > 0: raise ValueError('speed must be a number above 0')
        import threading
        self.base, self.speed, self._lock = base, speed, threading.Lock()
        self._mono0, self._wall0 = base.mono_ms(), base.wall_ms()
        self._acc, self._since, self._paused = 0.0, self._mono0, False      # scaled ms elapsed up to the last pause or resume, and the base mono_ms of the last resume
    def _elapsed(self): return self._acc if self._paused else self._acc + (self.base.mono_ms() - self._since) * self.speed
    def mono_ms(self):
        with self._lock: return self._mono0 + int(self._elapsed())
    def wall_ms(self):
        with self._lock: return self._wall0 + int(self._elapsed())
    @property
    def paused(self): return self._paused
    def pause(self):
        with self._lock:
            if not self._paused: self._acc = self._elapsed(); self._paused = True
    def resume(self):
        with self._lock:
            if self._paused: self._since = self.base.mono_ms(); self._paused = False
    def set_speed(self, speed):
        """S7-7a (ADR 0064): change the speed of a running or a paused clock without a jump. The scaled time up to now is kept (the old speed is applied to it), the base reference is moved to
        now and only then does the new speed count, so mono_ms and wall_ms never step and never run backwards. A paused clock only takes the new value; it counts from the next resume."""
        if isinstance(speed, bool) or not isinstance(speed, (int, float)) or not speed > 0: raise ValueError('speed must be a number above 0')
        with self._lock:
            if not self._paused: self._acc = self._elapsed(); self._since = self.base.mono_ms()
            self.speed = speed
    def now(self): return now_of(self)
