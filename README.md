# 📚 Panels — Comic Reader

A self-hosted, sleek comic reader with SMB NAS support, user management, and progress tracking.

Supports **CBR** (RAR) and **CBZ** (ZIP) files.

---

## ✨ Features

- **SMB / local library** — reads directly from your NAS share or a mounted path
- **Series folders** — each folder is a series; the first page of the first comic is the series cover
- **Volume sub-folders** — supports `Serie/stripboek.cbr` and `Serie/Jaargang/stripboek.cbr`
- **Cover art** — automatically extracted from the first page of each comic
- **User accounts** — multiple users, each with their own reading progress
- **Continue reading** — picks up exactly where you left off
- **Full-screen reader** — keyboard navigation, click zones, progress bar
- **Admin panel** — user management + library re-scan

---

## 🚀 Quick Start (Docker)

```bash
git clone <repo> panels
cd panels
docker compose up -d
```

Open **http://localhost:3000** — you'll be guided through a one-time setup wizard to:
1. Connect your SMB share (or local path)
2. Create the admin account

After setup, trigger a **Library Scan** from the admin panel. Covers are extracted and cached automatically.

---

## 📁 Expected Folder Structure on NAS

```
Comics/                        ← SMB share root
├── Asterix/
│   ├── Asterix de Galliër.cbr
│   ├── De Gouden Sikkel.cbr
│   └── ...
├── Lucky Luke/
│   ├── Jaargang 1/
│   │   ├── De Colts van Billy the Kid.cbr
│   │   └── ...
│   └── Jaargang 2/
│       └── ...
└── Tintin/
    ├── De blauwe lotus.cbz
    └── ...
```

- **Top-level folders** → series
- **CBR / CBZ directly in series folder** → issues (flat)
- **Sub-folder inside series** → volume / jaargang grouping

---

## ⚙️ Configuration

### SMB Share (NAS)

| Field    | Example            |
|----------|--------------------|
| Host/IP  | `192.168.1.100`    |
| Share    | `Comics`           |
| Username | `guest` (or yours) |
| Password | (leave blank for guest) |
| Domain   | `WORKGROUP`        |

### Local / Mounted Path

If you already have the NAS mounted (e.g. via `/etc/fstab` or Unraid share):

```
/mnt/user/Comics
```

---

## 🐳 Running Without Docker

**Requirements:** Node.js 18+, `npm`

```bash
npm install
node server.js
```

Data is stored in `./data/` and page cache in your system temp folder.

---

## 🔑 Reader Controls

| Action          | Keyboard / Mouse             |
|-----------------|------------------------------|
| Next page       | `→` `↓` `Space` · click right half |
| Previous page   | `←` `↑` · click left half   |
| Jump to page    | Type in page number field    |
| Seek anywhere   | Click progress bar           |
| Fullscreen      | `F` or ⛶ button             |
| Exit reader     | `Esc` or ← button            |

Progress is saved automatically after each page turn.

---

## 🛠️ Tech Stack

- **Backend** — Node.js + Express
- **Database** — SQLite (via `better-sqlite3`)
- **SMB** — `@marsaud/smb2`
- **CBR** — `node-unrar-js` (WebAssembly RAR)
- **CBZ** — `adm-zip`
- **Images** — `sharp` (cover thumbnails)
- **Sessions** — `express-session` + SQLite store
- **Frontend** — Vanilla JS SPA (no build step)
