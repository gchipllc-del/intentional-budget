# Intentional Budget API (worker)

A tiny **read-only** bank-sync backend for the Intentional PWA, implementing the
recommendation in [`../BANK_SYNC_SCOPING.md`](../BANK_SYNC_SCOPING.md):

**Plaid (data-only) → Cloudflare Worker → Cloudflare D1**, owner auth via a bearer key,
Plaid access tokens **encrypted (AES-256-GCM) before storage**.

> It can **read** transactions and balances. It can **never move money** — the Plaid
> integration only ever requests the `transactions` product; Transfer is never enabled.
> All bank data lives on **your own** Cloudflare account, never on anyone else's server.

---

## What runs where

| | |
|---|---|
| `src/index.js` | the Worker (routes, Plaid calls, D1, kill switch) |
| `src/lib.js`   | pure helpers: AES-GCM encryption, auth compare, CORS, categorization |
| `schema.sql`   | D1 tables (items, transactions, rules, settings, audit_log) |
| `wrangler.toml`| config (binding, non-secret vars). **No secrets here.** |
| `test/`        | Node tests — `npm test` (no Cloudflare runtime needed) |

Endpoints (all but `/health` need `Authorization: Bearer <APP_SECRET>`):
`/health`, `/status`, `/link/token`, `/link/exchange`, `/dev/sandbox-link` (sandbox only),
`/sync`, `/transactions?month=YYYY-MM`, `/summary?month=YYYY-MM`, `/rules`,
`/kill`, `/resume`, `/disconnect`.

---

## Run the tests (no accounts needed)
```bash
cd worker
npm install
npm test
```

---

## What only YOU can do (accounts + keys)

Claude can write all the code but **cannot create accounts or enter your API keys** — that's
a hard line for financial credentials. These three steps are yours:

1. **Create a free Plaid account** → https://dashboard.plaid.com/signup
   - Choose the **Personal use** path when offered.
   - Go to **Developers → Keys**, copy your **`client_id`** and your **Sandbox `secret`**.
2. **Create a free Cloudflare account** → https://dash.cloudflare.com/sign-up
   - Turn on 2FA (ideally a hardware key) — this account will hold your bank token.
3. Generate the two local secrets:
   ```bash
   openssl rand -hex 32      # use as APP_SECRET
   openssl rand -base64 32   # use as ENC_KEY  (must be 32 bytes)
   ```

---

## Phase 0 — prove it on sandbox (fake data, $0)
```bash
cd worker
npm install
cp .dev.vars.example .dev.vars     # then edit .dev.vars and paste your 4 values
npm run db:local                   # create local D1 tables

# Start the Worker locally (needs macOS 13.5+ / Linux for the local runtime).
# If your OS is too old for `wrangler dev`, skip to "Deploy" and test against the
# deployed Worker instead — same endpoints.
npm run dev                        # serves http://localhost:8787

# In another terminal — drive the full sandbox round-trip with no bank UI:
KEY="<your APP_SECRET>"
curl -s localhost:8787/health
curl -s -XPOST localhost:8787/dev/sandbox-link -H "Authorization: Bearer $KEY"     # mints a fake bank
curl -s -XPOST localhost:8787/sync             -H "Authorization: Bearer $KEY"     # pulls fake txns
curl -s        "localhost:8787/summary?month=$(date +%Y-%m)" -H "Authorization: Bearer $KEY"
```
You should see categorized needs/wants/savings/income totals from Plaid's fake data.

---

## Deploy to Cloudflare (gives a public HTTPS URL the app can use)
```bash
cd worker
npx wrangler login                 # opens your browser; YOU approve

# Create the database, then paste the printed id into wrangler.toml (database_id)
npx wrangler d1 create intentional
npm run db:remote                  # create tables on the deployed DB

# Store secrets (prompts you to paste each — they never touch the repo)
npx wrangler secret put PLAID_CLIENT_ID
npx wrangler secret put PLAID_SECRET
npx wrangler secret put APP_SECRET
npx wrangler secret put ENC_KEY

npm run deploy                     # prints https://intentional-budget-api.<you>.workers.dev
```
Then in the app: **⚙ Settings → Bank sync (beta)** → paste that URL + your `APP_SECRET`
→ **Test** → **Connect bank** → **Sync now**.

---

## Phase 1 — connect a real bank
1. In the Plaid dashboard, apply for the **Trial plan** (self-serve, usually same-day).
2. Set `PLAID_ENV = "production"` in `wrangler.toml`, and
   `npx wrangler secret put PLAID_SECRET` with your **production** secret.
3. Re-deploy. **Migrate owner auth to a passkey before this step** (see the security
   appendix in `../BANK_SYNC_SCOPING.md`); the bearer key is fine for sandbox only.

## Kill switch
```bash
curl -XPOST <api>/kill       -H "Authorization: Bearer $KEY"   # 503s everything
curl -XPOST <api>/resume     -H "Authorization: Bearer $KEY"
curl -XPOST <api>/disconnect -H "Authorization: Bearer $KEY"   # revoke at Plaid + purge
```
