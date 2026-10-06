![License](https://img.shields.io/badge/License-MIT-yellow.svg) ![Platform](https://img.shields.io/badge/Platform-Windows-blue.svg)

This extension is MIT-licensed on its own; it is bundled with ModPacer (GPL-3.0) and Vortex Collection Tools, and the badge above is not the licence of those tools.

# Vortex Bridge

> **A small Vortex extension that lets Vortex Collection Tools read your current rules live — no more waiting for Vortex to finish saving, no more closing Vortex first.**

---

## ⚡ Overview

[Vortex Collection Tools](../../vortex-tools/vortex-collection-tools) reads Vortex's own database
from disk, which has a real limitation: a rule you just changed in Vortex can sit invisible for a
while in an internal write-ahead log before it's safely readable — so a scan run right after can miss
your latest edit. The usual fix is closing Vortex first. Vortex Bridge is a tiny extension
that runs *inside* Vortex itself and reads its live, in-memory state directly — no waiting, no
closing Vortex, no stale reads.

### 📋 At a Glance

| Feature | Details |
| :--- | :--- |
| **Requirements** | Vortex 1.4.0+, Skyrim SE |
| **Data Safety** | Only changes things in Vortex when one of your tools asks it to, like installing an update or setting mod rules |
| **Compatibility** | Vortex Collection Tools and ModPacer (companion projects) |
| **Status** | Proof of concept — read + write endpoints confirmed live against a real running Vortex |

---

## ✨ Key Features

* **Live rules and mod data, no waiting:** Exposes your mods' current load-order rules, full mod
  list, and download list straight from Vortex's own running state, the instant Vortex Collection
  Tools asks — not a snapshot that might be a few seconds behind.
* **Nothing to configure:** Install it, and it quietly listens on your own machine for Vortex
  Collection Tools to ask it questions. No settings screen needed for what it does today.

---

## 📦 Getting Started

This is a plain, unbuilt extension (no compile step). Two ways to install:

**Option 1: Through Vortex (easiest)**
1. Open Vortex and go to Settings > Extensions.
2. Click "Install from File" and choose `vortex-bridge.zip` (from the Vortex Collection
   Tools release).
3. Restart Vortex.

**Option 2: Manual install**
1. Extract `vortex-bridge.zip` to get the `vortex-bridge` folder.
2. Copy that folder into `%APPDATA%\Vortex\plugins\` (full path: 
   `%APPDATA%\Vortex\plugins\vortex-bridge\`).
3. Restart Vortex.

Either way, check Vortex's own log for `[vortex-bridge] listening on http://127.0.0.1:59595`
to confirm it started. That's it — Vortex Collection Tools will pick it up automatically once both are
running.

> [!NOTE]
> Vortex calls every extension's init function twice during startup (its own main + renderer
> processes) — you may see the startup log line twice, or a harmless "port already in use" error
> from whichever process starts second. That's expected, not a bug.

---

## ⚠️ Important Notes

> [!NOTE]
> This is an early proof of concept, built to confirm a local Vortex extension can safely expose
> live state to an external tool. It currently covers rules (read + write), the full mod list, and
> the download list — more will be added as Vortex Collection Tools needs it.

---

## 🛠️ Technical Details & Contributions

How it works, why it's safe, and what's still to build — all in [`TECHNICAL.md`](TECHNICAL.md).
