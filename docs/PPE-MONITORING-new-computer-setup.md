# PPE Monitoring: New Computer Prerequisites

What a fresh laptop needs **before** you open the project. This covers tools only. It does not cover the project's own packages, which `just setup` installs for you.

**Target OS: Windows 10/11.** The host plays alarms through `winsound`, reads the battery through a Windows API, and the `justfile` uses PowerShell. Linux or macOS can run the Python tests and the dashboard, but not the real host or audio.

---

## 1. What you need (summary)

| # | Tool | Version | Needed for | Required? |
|---|------|---------|------------|-----------|
| 1 | Git | latest | cloning the repo | Yes |
| 2 | Python | **3.12** (`.python-version`) | host, tools, tests | Yes |
| 3 | Node.js | **22 LTS** (`.nvmrc`) | dashboard, e2e tests | Yes |
| 4 | just | latest | one-command tasks (`just setup`, `just test`, ...) | Yes |
| 5 | gcc (MinGW-w64) | any recent | firmware unit tests (`just test-fw`) | Only for firmware tests |
| 6 | USB-serial driver | matches your board | talking to the base ESP32 | Only with real hardware |
| 7 | uv | latest | regenerating lock files (`just lock`) | Optional |
| 8 | VS Code | latest | editing | Optional |

---

## 2. Install (Windows, PowerShell)

Open **PowerShell** (as a normal user) and run the blocks in order. Close and reopen PowerShell after installing, so the new `PATH` is picked up.

### 2.1 Git
```powershell
winget install --id Git.Git -e
```

### 2.2 Python 3.12
Use 3.12 exactly. The lock files are built for it.
```powershell
winget install --id Python.Python.3.12 -e
```
During install, make sure **"Add python.exe to PATH"** is ticked. The winget package normally does this.

### 2.3 Node.js 22 (use nvm-windows to pin the major version)
```powershell
winget install --id CoreyButler.NVMforWindows -e
```
Reopen PowerShell, then:
```powershell
nvm install 22
nvm use 22
```
Alternative: install Node 22 directly from <https://nodejs.org/en/download/prebuilt-installer> by picking v22.x.

### 2.4 just (task runner)
```powershell
winget install --id Casey.Just -e
```

### 2.5 gcc (only if you will run firmware tests)
```powershell
winget install --id BrechtSanders.WinLibs.POSIX.UCRT -e
```
If winget cannot find that ID, run `winget search winlibs`, or install MSYS2 from <https://www.msys2.org> and then run `pacman -S mingw-w64-ucrt-x86_64-gcc`.

### 2.6 uv and VS Code (optional)
```powershell
winget install --id astral-sh.uv -e
winget install --id Microsoft.VisualStudioCode -e
```

---

## 3. Hardware and drivers (only if you connect the real base station)

- **Base station:** a classic ESP32 DevKit with an SX1276 radio, connected by USB. The host talks to it over a COM port at 115200 baud.
- **USB-serial driver:** install the one your board's USB chip needs. The repo does not say which chip you have, so look at the small chip next to the USB port:
  - CP2102 or CP210x: Silicon Labs CP210x driver
  - CH340 or CH341: WCH CH341SER driver
- **Find the COM port:** Device Manager, then *Ports (COM & LPT)*. Put it in `host/config/settings.local.json` as `"serial_port": "COMx"`. The default in `settings.json` is `COM4`. `"auto"` does not work yet.
- **Speakers:** the host alarm and the 15-minute chime play through the laptop speaker. Check that Windows has a working output device.
- **Time zone data:** the host needs it (`tzdata`). It is pulled in by `just setup`, so you don't install anything extra.

---

## 4. Verify the prerequisites

Run each line. Every one should print a version.
```powershell
git --version          # any
python --version       # Python 3.12.x
node --version         # v22.x.x
npm --version          # any
just --version         # any
gcc --version          # only if you installed it
```
If `python` opens the Microsoft Store instead, turn off the aliases under *Settings, Apps, Advanced app settings, App execution aliases*, or use `py -3.12`.

---

## 5. After the prerequisites: first run

Once the tools above are installed, get the code and install the project's own packages:
```powershell
git clone https://github.com/raging-code/PPE-MONITORING.git
cd PPE-MONITORING

just setup                                  # Python packages from requirements-dev.lock, then the host package
cd dashboard; npm ci; cd ..                 # dashboard packages
cd e2e; npm ci; npx playwright install chromium; cd ..   # browser tests (optional)
```
Quick check that everything works:
```powershell
just test      # Python tests + frame vectors
just lint
just build     # builds dashboard/dist
```
Start without hardware (simulated data):
```powershell
python -m ppe_host.main --mode SIMULATOR
```
Then open <http://127.0.0.1:8420>. Dashboard dev server with hot reload: `just dev`. The host must also be running, because the dev server proxies to port 8420.

For real hardware, also create `host/config/secrets.json` with the `cmac_key` (32 hex characters). It is never committed. Then run `python -m ppe_host.cli doctor` to check the machine. See `docs/second-pc-checklist.md` for the full list.

---

## 6. Common problems

| Symptom | Fix |
|---------|-----|
| `python` / `node` / `just` not recognised | Close and reopen PowerShell. If it persists, sign out and in, or add the install folder to `PATH`. |
| `just setup` fails on hashes | You are on the wrong Python version. Check `python --version` is 3.12. |
| `npm ci` fails | Check `node --version` is 22. Run `nvm use 22`. |
| `just` recipes error on `Set-Location` | Run them from PowerShell, not cmd or Git Bash. |
| Port 8420 busy | Another host is running, or something else uses it. Close it, or change `bind_port` in `settings.local.json`. |
| COM port not found | Install the USB driver, replug the board, and re-check Device Manager. |
| `doctor` says audio FAIL | Fix the Windows sound output device. This is the primary alarm path. |
