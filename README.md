# SplitBook — personal expense journal (PWA)

A Splitwise-style app: create **books** (trip, flat, friends), add people, record expenses split
equally / by exact amount / by % / by shares, see balances and suggested settle-ups, and record payments.

* **Local-first & offline** – everything is saved on the device immediately (localStorage); the app shell is cached by a service worker.
* **Google sign-in + Drive storage** – data is one JSON file in your Drive's hidden *appDataFolder*
  (scope `drive.appdata`, so the app can't see any of your other files).
* **Offline sync** – edits made offline are queued and synced when you're back online (on reconnect,
  on app focus, every minute). Devices are merged per record with last-writer-wins; deletions are tombstones.
* **Recurring entries** – mark any expense *Every week / month / year* (Netflix, rent, bills). Past and due occurrences are created automatically, safe across devices (deterministic ids, no duplicates, deleted ones stay deleted).
* **Loans** – pick the 💸 *Loan* category to lend/borrow with optional interest (% per year, simple) and a due date. See repaid/outstanding, overdue badges, a home-screen reminder, one-tap repayment, and *add interest to balance*.
* **Sample data** – Settings → Demo loads realistic books (daily, trip, rent & bills, subscriptions, loans, EUR trip).
* Installable (Add to Home screen), dark mode, JSON export/import.

## Run

No build step. Serve the folder over HTTPS (or `localhost`):

```bash
cd splitbook && python3 -m http.server 8080   # http://localhost:8080
```

## Google setup (one time, ~3 minutes)

1. [Google Cloud Console](https://console.cloud.google.com) → new project → **APIs & Services → Library → enable "Google Drive API"**.
2. **OAuth consent screen**: External, add yourself as a *test user* (no verification needed for personal use). Add scope `.../auth/drive.appdata`.
3. **Credentials → Create credentials → OAuth client ID → Web application**.
   Add your app origin(s) under *Authorized JavaScript origins* (e.g. `http://localhost:8080`, `https://you.github.io`).
4. Put the Client ID in `config.js` (`GOOGLE_CLIENT_ID`) — on GitHub Pages the workflow injects it from the repo variable. Users never see or enter it.
5. Open the app → ⚙️ → **Sign in with Google**.

## Notes

* Designed for **one Google account across your devices**. To share a book with friends you'd enter
  their share as people in the book; they don't need the app.
* Access tokens last 1 h; the app refreshes them silently. If the browser blocks the refresh popup,
  tap the status pill (top bar) to reconnect.
* Amounts are stored as integer minor units, so splits never lose a cent (remainders use largest-remainder allocation).

## GitHub CI/CD & hosting (no local machine needed)

`.github/workflows/ci.yml` runs on every push/PR touching `splitbook/`:
syntax check + Playwright end-to-end test (mocked Google/Drive, offline sync, two-device merge).
Pushes to `main` that pass are deployed to **GitHub Pages**.

One-time repo setup:
1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
2. **Settings → Secrets and variables → Actions → Variables → New variable** `GOOGLE_CLIENT_ID` = your OAuth client ID (it is public, not a secret).
3. In Google Cloud, add `https://<your-user>.github.io` to *Authorized JavaScript origins* (origin only, no path).
4. Merge to `main`; the app appears at `https://<your-user>.github.io/<repo>/`. Open it on your phone and use *Add to Home screen*.

Each deploy stamps a new service-worker cache name, so installed apps pick up updates on next launch.
