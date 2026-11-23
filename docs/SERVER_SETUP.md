# PUIMS — Run it on your own machine

One computer runs everything: the database, PUIMS, automatic HTTPS and daily backups. Staff open PUIMS in a phone or PC browser.

## 1. Pick the machine (one of these)

| Option                                                                              | Good for                                                        | Address you will use                                               |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------ |
| **A. A computer in the unit** (mini PC or desktop, always on, Linux recommended)    | Unit Wi-Fi only; data never leaves the unit                     | Its address on the Wi-Fi, e.g. `192.168.1.50`                      |
| **B. A small cloud server** (Ubuntu, 2 CPU / 4 GB RAM / 40 GB disk) + a domain name | Phones anywhere, real certificate, nothing to install on phones | e.g. `puims.yourdomain.com` (point the domain's DNS to the server) |

Needs about 4 GB RAM and 10 GB free disk. Keep the machine's disk encrypted and its login password private.

## 2. Install Docker

- Linux: `curl -fsSL https://get.docker.com | sh`
- Windows / macOS: install **Docker Desktop**. On Windows, run the commands below in **WSL (Ubuntu)**.

## 3. Install PUIMS

Copy the PUIMS folder (unpack `puims-source.tar.gz`) onto the machine, open a terminal in it and run:

```bash
./puims-server.sh setup
```

It asks three things — the address (from step 1), the Chief RT's username and full name — then builds and starts everything (about 5–10 minutes the first time) and prints a **one-time sign-up link** for the Chief RT. Give that link to the Chief RT in person. They set a password and an authenticator app, then add the RTs under **RT Staff**.

Option B only: ports 80 and 443 must be open on the server's firewall.

## 4. Option A only: trust the certificate on each phone/PC (once)

```bash
./puims-server.sh cert
```

This saves `deploy/puims-certificate.crt`. Install it on each device that will use PUIMS:

- **Android:** Settings → Security → Encryption & credentials → Install a certificate → CA certificate.
- **iPhone/iPad:** open the file (AirDrop/email) → Settings → Profile Downloaded → Install; then Settings → General → About → Certificate Trust Settings → turn it on.
- **Windows:** double-click → Install Certificate → Local Machine → "Trusted Root Certification Authorities".
- **macOS:** double-click → Keychain Access → System → set "Always Trust".

Then open `https://192.168.1.50` (your address). Add it to the home screen for an app-like icon.

## 5. Everyday commands

| Command                                                | What it does                                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `./puims-server.sh status`                             | Is it running?                                                                   |
| `./puims-server.sh stop` / `start`                     | Stop / start (it also starts by itself after a reboot)                           |
| `./puims-server.sh backup`                             | Backup now (automatic backups run daily; last 14 kept in `deploy/backups/`)      |
| `./puims-server.sh restore deploy/backups/<file>.dump` | Restore a backup (asks you to type RESTORE)                                      |
| `./puims-server.sh update`                             | After copying in a newer PUIMS version: backs up, rebuilds, updates the database |
| `./puims-server.sh logs`                               | Recent app logs (no patient data in them)                                        |

## 6. Keep these safe

- **`deploy/.env`** — the passwords and the data key. Keep a copy on an encrypted USB stored safely. Without it, encrypted items (authenticator set-ups, stored original workbooks, offline keys) cannot be read after a rebuild.
- **`deploy/backups/`** — copy to another place regularly (encrypted USB or a second computer). A backup on the same machine does not survive a disk failure.

## What's already switched on

Offline capture (approved): the Chief RT approves each phone/PC under **Devices & Sync**. Contact info, payment, original workbooks and e-signatures are enabled as approved. Load the PFT guide under **Settings → PFT form template → Load guide…** and the scheduling workbook under **Import Center**.
