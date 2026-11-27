"""Test helper for the sound card (P24-3c-3): records every call and never makes a sound. Set fail to an exception to make play() raise it, as a removed device does."""
import threading

class FakeBackend:
    def __init__(self, fail=None): self.calls, self.fail, self.lock, self.on_play = [], fail, threading.Lock(), threading.Event()
    def _rec(self, *c):
        with self.lock: self.calls.append(c)
    def play(self, path, loop=False, wait=False):
        self._rec('play', getattr(path, 'name', str(path)), loop, wait); self.on_play.set()
        if self.fail is not None: raise self.fail
    def beep(self, hz, ms): self._rec('beep', hz, ms)
    def stop(self): self._rec('stop')
    def played(self):
        with self.lock: return [c[1] for c in self.calls if c[0] == 'play']
