"""services/fw_check.py (P24-5e, ADR 0050): the firmware version and ABI the base reports in its heartbeat (design 1, firmware note 4: "reported and checked").
FwState.update(fw, abi) returns the system_events rows to write, edge-triggered so a steady heartbeat writes nothing:
  FW_REPORTED  the first fw tag of the session, and every change of it (detail = the tag; the caller also records it in sessions.fw_version). Never a mismatch: the host has no expected fw.
  ABI_MISMATCH the reported abi differs from the host's BEACON_ABI_VER (detail names both). A runtime row, not an exit: exit codes are for start-up only (14.5).
  ABI_OK       the abi agrees again after a mismatch. The first agreeing heartbeat is silent.
Old firmware sends neither field (both None): nothing is written. Pure logic, no I/O."""
from .. import abi as host_abi

class FwState:
    def __init__(self, expected_abi=None):
        self.expected_abi = host_abi.BEACON_ABI_VER if expected_abi is None else expected_abi
        self.fw = None; self.abi_bad = False

    @property
    def mismatch(self): return self.abi_bad

    def update(self, fw, abi):
        out = []
        if fw is not None and fw != self.fw:
            self.fw = fw; out.append(('FW_REPORTED', fw))
        if abi is not None:
            bad = abi != self.expected_abi
            if bad and not self.abi_bad: out.append(('ABI_MISMATCH', 'base reports abi %d, host expects %d' % (abi, self.expected_abi)))
            elif not bad and self.abi_bad: out.append(('ABI_OK', 'base reports abi %d' % abi))
            self.abi_bad = bad
        return out
