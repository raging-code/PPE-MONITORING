Host-only settings (Rev 3.21, Proposed). These keys live in config/settings.json beside the ones listed above. They are not in constants.json because the firmware and the dashboard do not read them, so they stay out of shared/constants.json (Rev 3.27: key counts are checked by the generator test, 12.1). The defaults are the values already quoted in the text of sections 1, 3.8 and 4. They are part of settings_hash, except the nine rows marked 'Not in settings_hash' (Rev 3.42), so changing any other one closes the open session as ABANDONED on the next start and the new session logs CONFIG_CHANGED (2.3). (The 5 s LAPTOP OFFLINE timeout is base firmware, not a host setting.)

| Setting | Default | Used for |
|---|---|---|
| ws_auth_timeout_s | 3 | A /ws or /ws/tick socket must send its auth frame within this time or it is closed with code 4401 (3.8). |
| ws_send_queue_max | 64 | Length of each dashboard connection's bounded send queue, in messages. |
| ws_send_timeout_s | 1 | A client that cannot accept a message within this time is closed with code 4408 and CLIENT_DROPPED is logged. |
| login_backoff_cap_s | 5 | Upper limit of the growing delay after failed logins (section 4). |
| session_hours | 12 | Hours a PIN login session lasts (ADR 0056, Proposed); above 0 and at most 168. A session also ends at once on log out, on a new PIN, on rotate-token and on disable-operator. Not in settings_hash. |
| zero_socket_alarm_s (deleted) | 10 | Deleted (Rev 3.30, Proposed, confirm with the adviser): the host alarm is primary (3.12), so no rule starts a laptop alarm from a missing dashboard tab; a real alert sounds on the host regardless and the CLI ack stops it, and the base panel shows LAPTOP OFFLINE if the host stops. Remove this key from settings.json. |
| no_audio_alarm_s | 5 | Deleted (Rev 3.27): the host alarm no longer depends on browser audio (3.12). Remove this key from settings.json. |
| replay_chunk_rows | 2000 | Rows per asynchronous chunk during recovery, with a liveness heartbeat after each chunk. |
| pre_replay_queue_max | 500 | Live serial frames buffered while RECOVERING. |
| counters_interval_s | 60 | Seconds between COUNTERS rows in system_events (rejected_frames, write_rejected, pre_replay_dropped, retry_buffer_dropped, serial_framing_errors, queue and drop totals); recovery restores totals from the latest row (1, Rev 3.40, Proposed). |
| host_alarm_budget_ms | 300 | Budget from broadcast to host alarm sound start that the latency test checks (3.9, 5; provisional, Rev 3.40). Not in settings_hash (Rev 3.42). |
| checkpoint_interval_s | 60 | Dormant in Tier 1 (2.10): checkpoints are not written, so this key is not read. Ignore it until checkpoints are restored. Not in settings_hash (Rev 3.42). |
| advisory_heartbeat_s | 300 | Heartbeat row per node in advisory_summaries when the advisory risk has not changed (14.3, 2.11). Proposed, unmeasured. |
| audio_check_interval_s | 60 | How often the host verifies the audio path; a failed playback writes AUDIO_FAULT once and the next success writes AUDIO_OK (3.12). |
| host_chime_interval_min | 15 | Interval of the two-note host chime while no safety alert is unacknowledged (3.12). |
| host_volume_min_pct | 30 | Endpoint volume below this counts as AUDIO FAULT, only if the optional pycaw check is accepted (3.12, Proposed). |
| serial_write_timeout_ms | 200 | write_timeout for the host_tick serial write (provisional). |
| commit_wait_ms | 120 | Longest wait for writer confirmation before a unit counts as stalled and LOGGING FAULT is raised (section 1; moved from constants.json in Rev 3.27). |
| checkpoint_max_bytes | 16384 | Dormant in Tier 1 (2.10): size limit of state_json in a checkpoint row. Not in settings_hash (Rev 3.42). |
| host_budget_ms | 200 | Host share of the man-down path, frame received to broadcast, that the latency test checks (5). Not in settings_hash (Rev 3.42). |
| dashboard_budget_ms | 500 | Dashboard share of the man-down path, message received to pop-up visible, that the latency test checks (5). Not in settings_hash (Rev 3.42). |
| recovering_target_s | 3 | Target for the RECOVERING replay of a 24 h database that the soak test checks (2.9, 5). Not in settings_hash (Rev 3.42). |
| session_resume_max_min | 30 | A restart resumes the open session only if its last stored row is younger than this (2.3). |
| host_bat_warn_pct | 30 | Laptop battery at or below this shows the host battery warning banner (section 1, provisional). Not in settings_hash (Rev 3.42). |
| host_disk_min_gb | 1 | Free disk below this shows the DISK LOW warning banner (section 1, provisional). Not in settings_hash (Rev 3.42). |
| task_stall_s | 3 | A liveness stamp older than this makes the OS watchdog restart the process (section 1). |
| supervisor_restart_target_s | 5 | Target for the supervisor to have the process running again after a stall exit, checked by D8 (5). Not in settings_hash (Rev 3.42). |
| co_rising_enabled | false | Rev 3.24 feature flag. co_rising stays off until the adviser supplies the window and slope (Section 9, item 10); changing it closes the open session as ABANDONED and the new session logs CONFIG_CHANGED. Host-only (settings.json). |
| weak_signal_enabled | false | Rev 3.24 feature flag. weak_signal stays off until the range-test RSSI/SNR floors are recorded (Section 9, item 10); changing it closes the open session as ABANDONED and the new session logs CONFIG_CHANGED. Host-only. |
