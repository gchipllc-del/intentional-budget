# Intentional — 50/30/20 Budget App

A sleek, installable phone app (PWA) built from the *Intentional Spending Tracker* spreadsheet.
Plan your income, **Needs (50%) / Wants (30%) / Savings (20%)**, log spending fast, and watch
your savings rate trend over time.

### 📱 Live app: **https://gchipllc-del.github.io/intentional-budget/**
Open that on your phone and install it to your home screen (steps below).

- **No accounts, no backend.** All data is stored *only on your device* (browser localStorage).
- **Works offline** once installed.
- **Installs to your home screen** on iPhone and Android with its own icon, full-screen.

---

## Files

| File | Purpose |
|------|---------|
| `index.html` | App shell |
| `app.css` | All styling (light + dark, safe-area aware) |
| `app.js` | All logic — 50/30/20 math, editing, trends, settings |
| `manifest.webmanifest` | Makes it an installable app |
| `sw.js` | Service worker → offline support |
| `icons/` | App icons (generated) |

It's a plain static site — **no build step, no dependencies.**

---

## Put it on your phone (free hosting)

A PWA needs to be served over **https** for the install + offline features to work. Two easy free options:

### Option A — Netlify Drop (fastest, ~60 seconds)
1. Go to **https://app.netlify.com/drop**
2. Drag the **whole `spending-tracker` folder** onto the page.
3. Netlify gives you a URL like `https://your-name.netlify.app`.
4. Open that URL on your phone → install (steps below).

### Option B — GitHub Pages
1. Create a new GitHub repo and push these files (see commands below).
2. Repo → **Settings → Pages** → Source: `main` branch, `/ (root)` → **Save**.
3. After a minute your app is at `https://<you>.github.io/<repo>/`.

```bash
cd /Users/jesse/Desktop/projects/spending-tracker
git init && git add . && git commit -m "Intentional budget PWA"
# create the repo on github.com first, then:
git remote add origin https://github.com/<you>/<repo>.git
git branch -M main && git push -u origin main
```

---

## Install it (home-screen app)

**iPhone (Safari):** open the URL → tap **Share** (□↑) → **Add to Home Screen** → **Add**.
**Android (Chrome):** open the URL → menu **⋮** → **Install app** (or **Add to Home screen**).

It now launches full-screen with its own icon, and works without internet.

---

## Using it

- **Budget tab** — your monthly 50/30/20 picture. Tap a category card to add/edit line items.
- **`+` button** — quick-log a purchase (amount, name, category) into the current month.
- **‹ Month ›** — move between months. Each month is saved separately and seeds from the
  previous month's line items so recurring bills carry over.
- **Trends tab** — savings-rate trend, where-your-money-goes bars, and every saved month.
- **⚙ Settings** — change currency, adjust the 50/30/20 targets, theme, and
  **Export / Import** a backup file (do this occasionally — your data lives only on the device).

---

## Bank sync (optional, beta)
By default the app is 100% manual and on-device. There's an **optional** read-only bank
import you can enable by deploying your own backend — it can read transactions but can
**never move money**, and the data lives on **your** Cloudflare account, not anyone else's.
- Setup + the exact account/key steps: [`worker/README.md`](worker/README.md)
- Why this design (providers, architecture, finance-grade security): [`BANK_SYNC_SCOPING.md`](BANK_SYNC_SCOPING.md)
- Turn it on in the app under **⚙ Settings → Bank sync (beta)**.

## Updating the app later
If you change any file, bump `CACHE` in `sw.js` (e.g. `intentional-v1` → `intentional-v2`)
and re-deploy, so installed phones pick up the new version.

> The preview/demo currently has sample data in it. On a fresh install it starts empty.
> To wipe sample data: **Settings → Erase everything**.
