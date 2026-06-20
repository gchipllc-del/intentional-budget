# Connecting Intentional to bank accounts — options & plan

**Date:** 2026-06-20 · **Owner:** US solo developer, cost-sensitive, finance-grade security, runs own infra
**App:** Intentional — a 100%-on-device static GitHub Pages PWA (vanilla JS, `localStorage`, no backend, no build), budgeting into Needs/Wants/Savings (50/30/20)
**Status:** PLAN ONLY — no code. Goal: add an *optional*, *strictly read-only* bank-transaction import that auto-categorizes into the three buckets.

---

## 1. Executive summary & recommendation

The single hard fact that shapes everything: **bank sync cannot run in a pure static PWA.** The aggregator's client secret and the long-lived bank access token must never reach the browser (a GitHub Pages site is fully public — anything in its JS is readable by anyone). So a small backend is *mandatory*, no matter which provider is chosen. The whole design below sizes that minimum backend: **one HTTPS endpoint + one secret store + one tiny database**.

**Recommendation:**

| Decision | Choice | Why |
|---|---|---|
| **Aggregator** | **Plaid, on the free Trial plan, scoped to data-only products** (Transactions + Balance; Transfer NOT enabled) | Best US bank coverage; 10 free production "Items" is plenty for one person; read-only becomes a *structural* guarantee (the credential literally can't move money), not a promise-not-to-call-an-endpoint. |
| **Backend host** | **Cloudflare Workers** | Zero cold start (a "Sync now" button feels instant), built-in encrypted Secrets Store, free at this volume, $5/mo ceiling. |
| **Database** | **Cloudflare D1** (SQLite) | Native Worker binding, no extra network hop, free at one-user scale. |
| **Owner auth** | **Passkey / WebAuthn** (Touch ID on the Mac) | Phishing-resistant, hardware-bound, no shared secret sitting in `localStorage`. Start with a shared-secret v0 if needed, migrate before connecting a real bank. |
| **Secret custody** | Aggregator secret in **Cloudflare Secrets Store** (AES-256); access token **app-layer encrypted** before storing in D1. | Defense in depth; the browser holds zero secrets. |

**All-in monthly cost estimate: $0/month** at single-user volume (Workers free tier, D1 free tier, Plaid Trial free). **Ceiling $5/month** (Workers Paid) only if traffic ever exceeds 100k requests/day — it won't, for one person's budget app. The only other potential cost is an optional custom domain (~$10/year for the name).

**The honest catch (see §5):** this is a genuine privacy *downgrade* from the current 100%-on-device design. You trade "nothing ever leaves this browser" for "a third party holds my bank session and a server holds an encrypted bank token." Worth it only if auto-categorization saves enough manual entry to justify it — and only with an opt-in toggle + kill switch in place.

---

## 2. Provider comparison

> Read-only enforcement is the most security-relevant column. With Plaid, MX, Finicity, and SimpleFIN the read-only property is **structural** (no money-movement capability in the data scope you'd use). With Teller and Stripe the same API can also move money, so read-only is a **discipline** you self-enforce by never requesting those scopes. Costs are single-user estimates and exclude self-hosted backend hosting (~$0–5/mo, shared across all options).

| Provider | Data | Read-only | Bank coverage | Cheapest path to production | Solo-dev accessible? | ~Cost (1 user) | Best for |
|---|---|---|---|---|---|---|---|
| **Plaid** ⭐ | Transactions (pre-enriched merchant + category taxonomy), balances, identity, investments, liabilities, statements | **Structural** — Transfer is a separate product, off by default | Best in US; ~10,000+ institutions incl. Chase/BofA/Wells (OAuth) | Free **Trial plan** (10 production Items, real data, no contract, self-serve, mostly auto-approved) | **Yes** — self-serve, no sales gate; LLC not required (owner's G-Chip LLC more than satisfies any entity field) | **$0** (Trial). PAYG ~$1.50–2.00/linked acct/mo only beyond 10 Items *(third-party est.; official rates not public — med confidence)* | The recommended path: best coverage + free real-data tier + built-in categories |
| **Teller** | Transactions (enriched, with category + counterparty), balances, accounts, identity | **Discipline** — same API has Zelle Payments (BETA); read-only = never call/scope payments | US only; ~5,000–7,000 institutions *(sources disagree 5k vs 7k — med confidence)* | KYB review (company URL + demo + beneficial-owner info) using G-Chip LLC, then ~$0.30/enrollment/mo. Or stay in free Development (100-enrollment lifetime cap, real data) at $0 | **Mostly** — KYB + "contact Teller" gate, not instant; LLC satisfies it. Non-commercial single-user acceptance unconfirmed | **~$0.30/mo** (~$3.60/yr) prod; $0 in Development | Cheapest indie path if you accept self-enforced read-only |
| **SimpleFIN Bridge** | Accounts, balances, transactions (~90-day history, ~daily refresh); investments best-effort | **Structural** — read-only protocol, no money-movement endpoints | US/Canada via MX (16,000+ institutions); verify your banks first | Build free against reusable demo token, then **$15/yr** flat (covers 25 institutions) | **Yes** — fully self-serve, passkey/email login, no company, no review | **$15/yr** (~$1.25/mo) | Cheapest *structurally* read-only automated path; proven by Actual Budget |
| **Stripe Financial Connections** | Transactions (~180-day), balances, ownership; **cash accounts only** (no investments/liabilities); no built-in categories | **Discipline** — `payment_method` scope mints ACH-capable tokens; read-only = scope to data only | US only; ~5,000+ institutions | Free test mode, then **Stripe approval/registration** for live FC; ~$0.30/institution/mo + $0.10/balance call | **Partial** — test mode instant; live access gated by Stripe approval (criteria not published) | **~few $/mo** | Only if already deep in the Stripe ecosystem; otherwise awkward fit |
| **MX** | Transactions, balances, investments, identity, verification; auto-categorized | **Structural** — no money-movement in its API | US/Canada ~13,000–16,000+; strong credit unions | Free sandbox, then **enterprise sales contract** | **No** — production is sales-gated, custom contract | **~$15k/yr** *(Vendr avg — high confidence it's enterprise-priced)* | Enterprise/white-label, not solo dev |
| **Finicity (Mastercard)** | Transactions (up to 24 mo), balances, identity, investments, ACH details | **Structural** for the data APIs you'd use | US 10,000+ incl. all majors | Free sandbox ("Test Drive"), then **Mastercard sales/onboarding** | **Partial** — sandbox self-serve; production enterprise-gated, pricing undisclosed | **Undisclosed / custom** | Enterprise; overkill for one user |

**Net read of the table:** for a cost-sensitive solo dev, the real contest is **Plaid (Trial, $0) vs. SimpleFIN ($15/yr) vs. Teller (~$0–3.60/yr)**. MX and Finicity are enterprise-gated and economically unjustifiable for one user. Stripe FC works but is the wrong tool unless you're already on Stripe.

**Why Plaid over the two cheaper options:**
- vs. **SimpleFIN** — both are clean; SimpleFIN is structurally read-only and dirt cheap, but it depends on MX upstream (intermittent breakage), offers no categorization (you build all of it), caps history at ~90 days, and runs on a small/obscure operator with no SOC 2. Plaid gives richer pre-enriched data + a category taxonomy that does most of your Needs/Wants/Savings work, plus a stronger compliance posture (SOC 2 Type II, ISO 27001/27701). Plaid is **$0** at this scale, so SimpleFIN's price edge is moot. *SimpleFIN is the strong runner-up — pick it if you specifically want a structurally read-only protocol with no vendor approval step at all.*
- vs. **Teller** — Teller is the cheapest, but its read-only-ness is a *discipline* (the same API sends money via Zelle), which is a weaker story for a finance-grade auditor, and it requires a KYB conversation. Plaid's data-only scoping gives a structural guarantee with no sales gate.

---

## 3. Recommended backend architecture

**Shape:** keep the PWA exactly as it is (vanilla JS, GitHub Pages, no build). Add **one Cloudflare Worker** exposing a tiny JSON API, backed by **Cloudflare D1** (SQLite), with the aggregator secret in **Cloudflare Secrets Store**. One vendor, free at this scale.

```
GitHub Pages PWA (vanilla JS, unchanged)
   │  fetch() + WebAuthn session JWT; CORS locked to the exact Pages origin
   ▼
Cloudflare Worker   (free tier; $5/mo only if exceeded)
   ├─ POST /link/token        mint Plaid link_token (uses the secret)
   ├─ POST /link/exchange     public_token → access_token (uses the secret)
   ├─ POST /sync              pull transactions, categorize, store
   ├─ GET  /transactions      return categorized rows to the PWA
   ├─ GET/POST /categories    owner-editable mapping + rules
   ├─ POST /disconnect        kill switch: delete token + purge data
   ├─ Aggregator client secret → Cloudflare Secrets Store (AES-256)
   ├─ App-layer encrypt the access_token before it touches the DB
   └─ Cloudflare D1 (SQLite)
        • encrypted access token(s)
        • cached + categorized transactions
        • user rules / mapping table / manual overrides
   ▼
Plaid  (Trial plan: 10 production Items free)
        data-only products: Transactions + Balance — NO Transfer scope
```

**Why serverless over an always-on box:** the work is light, bursty, idempotent (exchange a token, or fetch 30–90 days of transactions). A single user does not justify a 24/7 instance. Cloudflare Workers specifically wins because it has **no cold start** (V8 isolates) — an interactive "Sync now" button feels instant — and because its Secrets Store and D1 co-locate, making the whole backend one vendor.

**Why D1:** one user produces a few thousand transaction rows per year — trivial. D1 is a native Worker binding (no network hop), free at this volume. *(If you ever open this to others, migrate to Neon or Supabase Postgres for richer SQL and row-level security — see §6/Phase 4.)*

**How it connects to the existing PWA:**
- The PWA keeps `localStorage` as its instant/offline cache; the Worker + D1 become the source of truth for *synced bank data only*. Hand-entered data can stay purely local if desired.
- The PWA `fetch()`es the Worker with a short-lived session token. **No build step is introduced.**
- **CORS is locked** to the exact origin (`https://<your-pages-origin>`), `Allow-Credentials: true`, with `OPTIONS` preflight handled — never `*`.
- Optional: front the Worker with a custom domain (`api.yourdomain`) so the API URL is stable if the Pages URL changes.

**The connect flow (where credentials go):** Plaid Link runs **client-side in the PWA**; the user's bank credentials go *directly from the widget to Plaid* and **never touch your backend**. Your Worker only ever sees opaque tokens. Sequence: PWA asks Worker for a `link_token` → user authenticates with their bank in Link → Link returns a `public_token` to the PWA → PWA sends it to the Worker → Worker exchanges it (with the secret) for a long-lived `access_token`, **encrypts it**, and stores it in D1. The access token never returns to the browser.

---

## 4. Finance-grade security must-haves (prioritized)

1. **Read-only by structure, not by promise.** Scope Plaid to data-only products (Transactions + Balance) and **never enable Transfer**. A leaked token must be able to *read* but never *move* money. (If Teller/Stripe were chosen instead, add a CI test asserting payment clients/scopes are never imported/requested — turning discipline into an enforced rail.)
2. **The aggregator secret never leaves the server.** Store it in Cloudflare Secrets Store (AES-256, not visible in dashboard/CLI after set), never in the repo, never in client JS. Only the Worker reads it at runtime.
3. **Access token encrypted at the app layer.** Encrypt with a key from Secrets Store *on top of* D1's at-rest encryption, before it ever hits the DB. The browser must never receive it.
4. **Phishing-resistant owner auth (passkey/WebAuthn).** No shared secret living in XSS-readable `localStorage`. The Worker verifies the WebAuthn assertion and issues a short-lived session JWT.
5. **Lock the API to one origin.** Strict CORS to the exact Pages origin; reject everything else. HTTPS-only.
6. **A kill switch.** `POST /disconnect` calls Plaid `/item/remove`, deletes the stored token, purges cached server data, and reverts the app to pure-local mode. This is both a security control and the privacy mitigation (§5).
7. **Data minimization & retention limits.** Cache only the transaction window you actually use; purge old raw data on a schedule. Consider storing only *categorized summaries* server-side and keeping raw detail on-device.
8. **Audit the secret-handling surface.** Verify webhook signatures (if you subscribe to refresh webhooks), log token-lifecycle events, rotate the API auth credential if ever exposed.
9. **Treat the backend as finance-grade.** The owner — not Plaid — is responsible for securing the backend; Plaid's certifications cover only Plaid's side. Defense in depth, validate all inputs, audit everything.

---

## 5. The privacy tradeoff (stated honestly)

**Today:** 100% on-device. Bank data exists nowhere but this browser's `localStorage`. No server, no token, nothing to breach remotely, nothing to subpoena, zero third parties. The cost is zero automation — every expense is hand-entered, single-device.

**With bank sync, you give that up — and it stays given up while sync is enabled:**

- A **third-party aggregator (Plaid) now holds your bank login session** and sees every transaction. This is the single biggest change and it is inherent to *any* bank-import feature — no architecture avoids it.
- **A long-lived bank access token now lives on a server** (D1), even encrypted. That is a remote asset that can be attacked; on-device data cannot be reached remotely.
- **Your transactions are now cached server-side**, not just on your laptop.
- The threat surface grows from "someone with my unlocked laptop" to "+ aggregator breach, + Cloudflare account compromise, + my API auth being defeated."

**Mitigations that preserve most of the original spirit** (all already in the design): strictly **opt-in and reversible** via the kill switch (§4.6); **structurally read-only** scope so a token leak can read but never move money; **app-layer token encryption**; **minimal retention**; **passkey auth** so a stolen shared secret can't reach the API.

**Bottom line:** bank sync is a real privacy downgrade — convenience bought with a third party plus a server holding a bank token. Recommend shipping it as an **off-by-default feature** the owner explicitly turns on, with one click to turn it all the way back off.

---

## 6. Phased roadmap

| Phase | Goal | Work | Rough effort |
|---|---|---|---|
| **Phase 0 — Sandbox proof** | Validate the whole pipeline against fake data, $0, no real bank | Plaid Sandbox keys; stand up the Worker + D1 + Secrets Store; implement `/link/token` and `/link/exchange`; pull sandbox transactions; prove the round-trip to the PWA over locked CORS | **1–2 days** |
| **Phase 1 — One bank, read-only** | Connect the owner's *own* real bank, read-only | Apply for Plaid **Trial plan** (self-serve, mostly same-day); scope to **data-only products**; run the live Link flow; encrypt + store the access token; `/sync` pulling 30–90 days; verify Transfer is NOT enabled; ship the **kill switch** | **1–3 days** (plus Plaid approval wait, usually same-day; up to 2–3 business days if flagged) |
| **Phase 2 — Categorization** | Auto-bucket into Needs/Wants/Savings | Map Plaid `personal_finance_category` → 3 buckets; merchant-name normalization; owner-editable rules table; per-transaction manual override + optional learning; **explicit savings-transfer detection** (transfers into savings/brokerage = the "20", not an expense) | **2–4 days** |
| **Phase 3 — Hardening** | Finance-grade lockdown | Migrate owner auth from shared-secret to **passkey/WebAuthn**; tighten CORS; data-minimization/retention purge job; audit secret handling + token lifecycle logging; verify webhook signatures if used; document the kill-switch + breach response | **2–4 days** |
| **Phase 4 — (Optional) open to others** | Multi-user, only if ever desired | Add `user_id` to every row; one encrypted token per user/Item; consider Supabase Auth + Postgres; model Plaid per-Item cost as the dominant expense; add privacy policy / DPA / breach response | **weeks, not days** — different compliance bar; out of current scope |

> Categorization pipeline detail (Phase 2), last-wins layering: (1) provider category as base → (2) merchant-name normalization (strip `SQ *`, `TST*`, `PAYPAL *`, store numbers; prefer Plaid's enriched `merchant_name`) → (3) user rules engine in D1 → (4) per-transaction manual override + optional auto-promotion to a rule → (5) savings-transfer special case. Keep the rules table owner-editable and server-side so it persists across devices.

---

## 7. Open questions / decisions before building

1. **Aggregator final call:** Plaid Trial (structural read-only, $0, best coverage, recommended) vs. SimpleFIN ($15/yr, structurally read-only, no approval step, but no categorization and weaker operator) vs. Teller (~$0–3.60/yr, cheapest, but read-only is self-enforced + KYB gate). Decide before Phase 0, since it shapes the integration.
2. **Auth ambition for v0:** ship a shared-secret v0 to move fast, or go straight to passkey/WebAuthn? Recommendation: shared-secret is acceptable *only* in Sandbox (Phase 0); **migrate to passkey before connecting a real bank** (Phase 1/3).
3. **Server-side retention policy:** store full raw transactions, or only categorized summaries server-side with raw detail kept on-device? This is the biggest lever on the privacy downgrade — decide retention window and what's cached where.
4. **Custom domain or not** for the Worker API (~$10/yr) — only matters for URL stability; skippable for v0.
5. **Plaid Trial-plan acceptance:** confirm same-day self-serve approval for a *personal-use* application (Plaid offers a "Personal use" signup path; G-Chip LLC satisfies any entity field if asked). Low risk, but verify before committing the integration.
6. **Pricing if you ever exceed 10 Items:** Plaid's per-Item rates aren't publicly listed (third-party estimate ~$1.50–2.00/linked acct/mo). Confirm in-dashboard before linking an 11th account; unlikely to matter for one person.
7. **What stays purely local:** decide whether hand-entered budget data remains 100% on-device (recommended) while only *synced* bank data goes server-side — preserving the original privacy model for everything you type yourself.
8. **(If multi-user is ever on the table)** the compliance bar changes entirely (privacy policy, DPA, breach response, possible SOC 2 expectations). Confirm this is explicitly out of scope for now.

---

## 8. Sources

**Plaid:** https://plaid.com/pricing/ · https://plaid.com/docs/account/billing/ · https://plaid.com/docs/transactions/ · https://support.plaid.com/hc/en-us/articles/39994173227159-What-is-the-Plaid-Trial-plan · https://support.plaid.com/hc/en-us/articles/16110110883479-How-are-Sandbox-Production-Trial-plan-and-Limited-Production-different · https://plaid.com/docs/transfer/

**Teller:** https://teller.io/ · https://teller.io/docs/guides/environments · https://teller.io/docs/api/account/payments

**SimpleFIN Bridge:** https://beta-bridge.simplefin.org/ · https://www.simplefin.org/protocol.html · https://beta-bridge.simplefin.org/info/security · https://actualbudget.org/docs/advanced/bank-sync/simplefin/

**Stripe Financial Connections:** https://stripe.com/pricing · https://docs.stripe.com/financial-connections/fundamentals · https://dashboard.stripe.com/settings/financial-connections

**MX:** https://docs.mx.com/api-reference/platform-api/overview/ · https://dashboard.mx.com/sign_up · https://www.vendr.com/buyer-guides/mx-technologies

**Finicity (Mastercard):** https://github.com/Mastercard/open-banking-us-openapi · https://developer.mastercard.com/open-finance-us/documentation/quick-start-guide/

**Hosting & data store:** https://developers.cloudflare.com/workers/platform/pricing/ · https://developers.cloudflare.com/d1/platform/pricing/ · https://developers.cloudflare.com/workers/configuration/secrets/ · https://securityboulevard.com/2026/04/secrets-at-the-edge-secure-patterns-for-cloudflare-workers/ · https://turso.tech/pricing · https://agentdeals.dev/neon-vs-supabase · https://www.saaspricepulse.com/compare/railway-vs-flyio-vs-render · https://expresstech.io/7-fly-io-alternatives-in-2026-real-pricing-after-the-free-tier-died/

**General:** https://www.openbankingtracker.com/blog/best-open-banking-api-providers-developers-2026

---

## Appendix A — Finance-grade security deep-dive

> Scope note: this appendix analyzes the security of the *already-chosen* design (static PWA on GitHub Pages → one Cloudflare Worker → D1, Plaid Trial on **data-only** products, passkey owner auth). It does not re-debate the architecture. It goes *beyond* the parent doc's §4 checklist; where it touches a §4 item it adds depth the checklist omits. Throughout, the single most important structural fact is restated because it shapes every threat: **the Plaid integration is provisioned for Transactions + Balance only; Transfer/Payment Initiation is never enabled, so no credential in this system can move money.** That is enforced at Plaid's product-authorization layer, not by our code, which is why it survives a total compromise of our own stack.

---

### A.1 Threat model

The honest frame for a single-owner app: the realistic adversaries are *opportunistic and automated* (credential-stuffing bots, npm supply-chain worms, leaked-secret scanners, a stolen/lost laptop) far more than a targeted human attacker. The design should make the cheap attacks fail and bound the damage of the expensive ones.

**The load-bearing invariant.** Because the Plaid Item is authorized only for **Transactions + Balance**, the worst outcome of *any* token theft is a **read of transaction history and balances** — a privacy breach, not a financial-loss breach. Plaid enforces product scope server-side; a stolen `access_token` cannot call Transfer endpoints that were never enabled for the Item ([Plaid Items API](https://plaid.com/docs/api/items/)). This is the difference between "embarrassing" and "catastrophic," and it is why the read-only decision is the single highest-leverage control in the whole design.

#### Per-component: what a compromise grants, and what it does *not*

| Component | If attacker controls it, they CAN | They CANNOT |
|---|---|---|
| **Browser / PWA (GitHub Pages JS)** | Run script in the Pages origin; read anything in `localStorage` (budget data, any UI state); call the Worker *as the owner if a valid session/passkey assertion is present*; phish the owner via injected UI; exfiltrate displayed transactions | Read the Plaid secret or the app-layer encryption key (both live only in the Worker/Secrets Store, never shipped to the browser); mint a passkey assertion without the hardware authenticator; move money (no Transfer scope exists) |
| **Plaid Link (client widget)** | Observe the *public* link token and the link flow; not a store of long-lived secrets | Yield the `access_token` (exchange happens Worker-side via `/item/public_token/exchange`); the `public_token` is short-lived and single-use |
| **Cloudflare Worker** | Read the Plaid secret + the encryption key at runtime (it legitimately needs both); decrypt and read all stored tokens; call Plaid Transactions/Balance freely; read/write D1 | Move money (Transfer never enabled at Plaid); persist beyond a redeploy unless it also altered code in the repo; reach other Cloudflare accounts |
| **D1 (SQLite)** | Read stored rows: ciphertext access tokens, transaction cache, audit log | Use the tokens *without* also obtaining the encryption key, which is **not** stored in D1 — it lives in Secrets Store / Worker binding (this is the whole point of app-layer encryption: D1-at-rest exposure ≠ token exposure) |
| **Secrets Store** | Hold the Plaid client secret and (optionally) the data key; account-takeover-adjacent | Be read back in plaintext through the dashboard — Secrets Store values are **write-only and not readable by anyone, including Cloudflare staff**, once created ([Cloudflare Secrets Store](https://developers.cloudflare.com/secrets-store/integrations/workers/)). A Worker *bound* to a secret can use it; an attacker who only has dashboard read cannot exfiltrate the value |
| **Plaid itself (vendor breach)** | Out of owner's control; could expose tokens/data for many customers at once | Be mitigated by owner except via fast revocation (`/item/remove`) and the read-only scope limiting blast radius to data, not funds |
| **Owner's bank session** | Not part of this system — credentials are entered into Plaid Link / the bank's own auth, never seen by our Worker or PWA | Be harvested by our app even if our app is fully compromised, because we never see bank credentials (Plaid's credential-less / OAuth model) |

#### Realistic attacker profiles, walked through this stack

- **XSS on the Pages site (most likely web attack).** Static vanilla JS with no third-party script tags is the *strongest* posture here — keep it that way. A successful XSS reads `localStorage` and can call the Worker *with the owner's active session*. Mitigations beyond §4: a strict **Content-Security-Policy** served via GitHub Pages-compatible `<meta http-equiv>` (no inline event handlers, `script-src 'self'` plus only Plaid's documented Link domain, `connect-src` limited to the Worker + Plaid), **Subresource Integrity** on the single Plaid Link script tag, and treating `localStorage` budget data as *already disclosed* in your risk acceptance (it is the realistic XSS loss). Note: passkeys do **not** save you from XSS — if the attacker rides a live session they can call the Worker; passkeys defeat *credential theft and replay*, not in-session abuse. The damage ceiling is still "read transactions," which is the point.
- **Stolen/lost laptop.** `localStorage` is plaintext on disk. A passkey on a separate hardware/platform authenticator with user-verification (biometric/PIN) means the thief gets the *cached* budget data but cannot freshly authenticate to the Worker. Mitigation beyond §4: enable full-disk encryption (FileVault) — it is the actual control for at-rest browser storage; the app cannot encrypt `localStorage` against someone with the unlocked machine.
- **Cloudflare account takeover.** This is the worst single-account event: attacker can read the Worker code, bind to secrets (use, not necessarily read), and read D1. **Mitigations:** hardware-key 2FA on the Cloudflare account, **scoped API tokens only (never the Global API Key)**, and accepting that this scenario still cannot move money. Treat Cloudflare-account 2FA as a tier-1 must-have (§A.7).
- **Plaid breach.** Owner has no preventive control; the response controls (revoke + re-link, §A.6) and the read-only scope are the entire defense. Document that you accept Plaid's vendor risk.
- **Supply-chain compromise of a Worker dependency.** A malicious npm version in the Worker build could exfiltrate the secret and token at runtime — this *bypasses* Secrets Store's at-rest protection because the Worker legitimately decrypts at runtime. This is why §A.4 (minimal/pinned deps, provenance) is not optional hygiene but a core control: the Worker is the one place where plaintext secret + plaintext token + outbound network all coexist.

---

### A.2 Compliance context for a US solo developer

Practical and honest, not legal advice. The recurring theme: **at true single-user scale (you reading only your *own* accounts), almost none of the consumer-finance privacy statutes are triggered — they regulate handling *other people's* data. The moment a second user connects a bank, the analysis flips.**

**GLBA / Regulation P (Privacy Rule) and the Safeguards Rule.** GLBA regulates "financial institutions" that provide financial products/services to **consumers/customers** — i.e., *other people* ([FTC, Gramm-Leach-Bliley Act](https://www.ftc.gov/business-guidance/privacy-security/gramm-leach-bliley-act)). The Privacy Rule (Reg P) governs how an institution shares a *consumer's* nonpublic personal information with third parties; the Safeguards Rule requires an information-security program to protect *customer* information. With a single owner reading only their **own** accounts, there is **no consumer/customer relationship** — you are not providing a financial service to anyone, so GLBA/Reg P do not impose obligations on you. The honest caveat: the FTC's definition of "financial institution" is famously broad, and an app that *aggregates account data for others* can look like a "financial institution" under it. **What changes if opened to others:** the instant another person links an account, you are arguably handling their nonpublic personal financial information, and the Safeguards Rule's program requirements (designated qualified individual, risk assessment, access controls, encryption, MFA, incident response, vendor oversight) become the realistic compliance bar — most of which this design already satisfies in spirit, which is fortunate but must then be *documented*, not just implemented.

**PCI-DSS.** **Out of scope for this app.** PCI-DSS governs **cardholder data** — the card Primary Account Number (PAN), cardholder name, expiration, service code ([PCI SSC FAQ](https://www.pcisecuritystandards.org/faqs/all/); [PCI Data Storage Do's and Don'ts](https://listings.pcisecuritystandards.org/pdfs/pci_fs_data_storage.pdf)). This app never touches card PANs; it reads **bank transaction and balance data** via Plaid, which is not cardholder data and is not in PCI scope. You do not store, process, or transmit a PAN, so PCI-DSS does not apply — even multi-user, as long as you never handle card numbers.

**Plaid's developer obligations (these *do* bind you now, even single-user).** Plaid's Developer Policy (effective April 19, 2026) requires that you access financial-institution data only for a **Permitted Use Case** reviewed/approved by Plaid and consented to by the end user, and limits how you may use and retain end-user data; violations can result in suspension/termination ([Plaid Developer Policy](https://plaid.com/developer-policy/)). Practical implications for this stack: (1) keep the products you enable matching your declared use case (budgeting/PFM = Transactions + Balance — do **not** quietly add products); (2) **data minimization** — only persist the transaction fields the categorizer needs; (3) honor deletion via `/item/remove`; (4) the "end user" is you, so consent is trivially satisfied, but the *data-use limits and retention discipline still apply* and are the main compliance surface at single-user scale.

**CCPA / state privacy (only relevant if multi-user, and even then likely not at hobby scale).** CCPA applies to a "business" meeting a threshold: for 2026, **annual gross revenue over ~$26.625M**, or buying/selling/sharing the personal information of **100,000+ California consumers/households**, or deriving **50%+ of revenue from selling/sharing** personal data ([Clym, CCPA Applicability 2026](https://www.clym.io/blog/ccpa-applicability-guide)). A solo developer's personal app meets **none** of these, so CCPA does not apply — single-user *or* small multi-user. If this ever became a real product with paying users you'd re-check, but the thresholds are far above a hobby project. Other state laws (e.g., Virginia, Colorado) have similar entity-size/volume thresholds and are equally unlikely to trigger.

**Bottom line for the owner.** Single-user, own-accounts-only: the legally *required* obligations are essentially just **Plaid's contractual Developer Policy** (use-case fidelity, data minimization, retention/deletion). GLBA, Reg P, PCI-DSS, and CCPA are **not triggered**. Everything else in this appendix is **best practice you're choosing because it's your money data**, not because a statute compels it. The single biggest *compliance* (not security) trap is **scope creep to other users** — that is the event that converts best practice into legal obligation, so treat "add a second user" as a decision requiring a fresh compliance review, not a feature toggle.

---

### A.3 Secrets & key management specifics

Two distinct secrets, managed differently:

**1. Plaid client secret (long-lived credential issued by Plaid).**
- **Custody:** Cloudflare Secrets Store account-level secret, bound to the Worker — **write-only, not readable after creation, RBAC-gated, with changes recorded in audit logs** ([Cloudflare Secrets Store](https://developers.cloudflare.com/secrets-store/integrations/workers/)). Prefer this over per-Worker secrets, which are tied to the Workers role so anyone who can edit the Worker can read/modify the secret ([Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)).
- **Rotation cadence:** rotate in the Plaid Dashboard on a fixed cadence (every 6–12 months is a reasonable solo-dev cadence) and **immediately** on any suspicion. Plaid supports having the new secret active before retiring the old, enabling zero-downtime rotation: generate new → update the Secrets Store value → verify a Worker call succeeds → retire the old in Plaid.
- **On suspected exposure:** rotate the Plaid secret first (it gates *all* Plaid calls), confirm the Worker picks up the new value, then proceed to token-level response (§A.6).

**2. App-layer encryption key (data key that encrypts each `access_token` before D1 storage).**
- **Pattern — envelope encryption.** Do not encrypt tokens directly with a single static key sitting next to the data. Use a **key-encryption key (KEK)** held in Secrets Store to wrap a **data-encryption key (DEK)**; store only the wrapped DEK alongside ciphertext, never the KEK in D1. This means a D1-at-rest dump yields ciphertext + wrapped DEK but **not** the KEK — so D1 exposure alone never yields a usable token. (At single-user, low-token scale you may simplify to one KEK in Secrets Store directly encrypting the token, but the envelope pattern is what lets you rotate the wrapping key without re-fetching tokens and is worth adopting from the start.)
- **Rotation:** rotate the KEK on a cadence (annually) and on suspicion. With envelope encryption, KEK rotation = re-wrap the DEK(s); the underlying token ciphertext need not change. Without it, rotation means decrypt-with-old, re-encrypt-with-new for every stored token — feasible at one-token scale, painful later.
- **On suspected exposure of the data key:** treat stored tokens as compromised → rotate KEK **and** invalidate the affected Plaid token via `/item/access_token/invalidate` (rotates to a fresh token) or `/item/remove` ([Plaid Items API](https://plaid.com/docs/api/items/)), then re-encrypt under the new key.

**Hygiene that prevents most real-world secret leaks (these cause more breaches than crypto weaknesses):**
- **Never** put secrets in `wrangler.toml`/`wrangler.jsonc` — that file is committed. Secrets go to Secrets Store / `wrangler secret`, never to config or `vars` ([Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)).
- **Never log the secret, the data key, raw `access_token`, or `public_token`.** Add a log scrubber/denylist and make it a code-review rule. The audit log (§4) should record *events*, not token values.
- **Keep secrets out of build artifacts and error responses** — ensure stack traces returned to the browser never echo environment values; return generic errors to the client and keep detail server-side.
- **No secrets in the repo or git history** — if one ever lands in a commit, rotation (not deletion) is the fix, because git history is forever.

---

### A.4 Supply-chain & dependency hygiene

The Worker is the most security-sensitive code in the system (it is the only place plaintext secret + plaintext token + outbound network coexist), so its dependency surface deserves disproportionate care. 2026's npm landscape — repeated scope-takeover/RAT campaigns dropping malicious versions into widely-used packages — makes this concrete, not theoretical ([Unit 42, npm threat landscape](https://unit42.paloaltonetworks.com/monitoring-npm-supply-chain-attacks/); [Mondoo, npm supply-chain security 2026](https://mondoo.com/blog/npm-supply-chain-security-package-manager-defenses-2026)).

- **Minimize dependencies to (near) zero.** The Worker can be written against the Workers runtime + Plaid's REST API directly using `fetch`, avoiding even the Plaid Node SDK if you want the smallest surface. Web Crypto (built into Workers) handles the app-layer encryption with **no** crypto dependency. Every dependency you don't add is an attack you can't suffer. The vanilla-JS PWA already follows this — keep the Worker equally lean.
- **Lockfile + integrity verification, always `npm ci`.** Commit `package-lock.json`; install with `npm ci` (not `npm install`) so builds verify the lockfile's integrity hashes and reject deviations ([Mondoo](https://mondoo.com/blog/npm-supply-chain-security-package-manager-defenses-2026)).
- **Pin exact versions, ideally to integrity hashes.** Pin direct deps to exact versions; the lockfile pins transitive ones. Review lockfile diffs in PRs — an unexpected transitive change is the early signal of a compromised release.
- **Disable lifecycle scripts** (`npm ci --ignore-scripts` where feasible): postinstall scripts are the dominant npm malware delivery vector.
- **Verify provenance / SLSA where available.** Run `npm audit signatures` and prefer packages published with **provenance attestations** (Sigstore-signed link from package → source commit → build) — npm shows a verified badge for these; signature-verifying installs would have rejected entire recent malicious waves ([Dev|Journal, npm provenance & SLSA baseline 2026](https://earezki.com/ai-news/2026-04-04-npm-provenance-and-slsa-the-supply-chain-hygiene-baseline-every-team-needs-in-2026/)). At minimal-dependency scale this is cheap and high-value.
- **Run `npm audit` and enable Dependabot** for the Worker repo; Dependabot understands SHA pins and updates pin + comment together.

**If GitHub Actions is used to deploy the Worker (optional — manual `wrangler deploy` from the laptop is also fine and has a smaller attack surface):**
- **Pin every action to a full commit SHA**, not a floating tag (`@v4`/`@main`). An upstream tag-move otherwise executes attacker code in CI with full job context ([StepSecurity, pinning GitHub Actions](https://www.stepsecurity.io/blog/pinning-github-actions-for-enhanced-security-a-complete-guide); [Wiz, hardening GitHub Actions](https://www.wiz.io/blog/github-actions-security-guide)).
- **Least-privilege `GITHUB_TOKEN`:** set `permissions:` to read-only at the workflow level, granting write only to the specific job that needs it ([Wiz](https://www.wiz.io/blog/github-actions-security-guide)).
- **Scope the Cloudflare deploy token tightly.** Use a custom **API token** (never the Global API Key), scoped to only `Workers Scripts:Edit` + `D1:Edit` + `Account Settings:Read`, restricted to the one account ([Cloudflare GitHub Actions docs](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)). Store it as a repo secret; rotate on suspicion. The goal: a CI leak's blast radius is "redeploy this Worker," not "the whole Cloudflare account."
- Prefer **OIDC short-lived tokens** over long-lived secrets where the provider supports it; OIDC tokens are scoped to a single run and expire in minutes ([Wiz](https://www.wiz.io/blog/github-actions-security-guide)).

---

### A.5 Backup & recovery security

- **D1 Time Travel is always on, free, and covers the last 30 days** — minute-granularity point-in-time restore by replaying the write-ahead log ([Cloudflare D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)). This is your first-line "oops I corrupted the table" recovery and requires no setup. It is *operational* recovery, not a security backup, and it expires at 30 days.
- **For durable/off-platform backups**, use `wrangler d1 export` to produce a SQL dump. **Critical caveat:** the export contains the **ciphertext access token** rows but, because of app-layer/envelope encryption, **not** a usable token unless the KEK also leaks — so a backup file is far less dangerous than a plaintext DB would be. Still, treat the export as sensitive.
- **Keep backups encrypted and access-controlled.** If storing dumps in R2 or locally, encrypt them at rest (e.g., into an R2 bucket with a separately-held key, or encrypt the dump file before it leaves the laptop) and never commit a dump to git. Do not co-locate the backup and the KEK.
- **Recovery without weakening secret custody.** The recovery design should be: restore D1 (Time Travel or import a dump) → the Worker re-reads the *current* KEK from Secrets Store → tokens decrypt as before. The KEK is **never** part of the D1 backup, so restoring data never reintroduces a secret. If the KEK itself is lost, stored tokens become permanently undecryptable — that is acceptable here because recovery is simply **re-linking the bank via Plaid Link** (one owner, one account), which is cheaper and safer than backing up the KEK alongside data. Design the system so re-link is always a viable recovery path; that removes the temptation to store the data key insecurely "just in case."

---

### A.6 Incident response / breach plan

Single-owner means you are the entire IR team — so the plan must be a short, pre-decided runbook. Keep it printed/offline so it works even if the app is down. Order matters: **stop the bleeding (kill switch) → cut Plaid access → rotate credentials → purge → re-establish.**

**Detection signals worth pre-wiring:** unexpected Worker request volume, Secrets Store audit-log changes you didn't make, Cloudflare login alerts, GitHub security alerts, Plaid Dashboard anomalies.

**The kill switch (from §4) is the first move in every scenario.** Define it concretely: a single flag (Worker env/KV value) the Worker checks at the top of every request and, when set, **refuses all Plaid calls and all data reads, returning 503**. Because it's checked per-request and toggled out-of-band, you can disable the integration in seconds without a redeploy. This buys time to investigate before deciding on the heavier steps below.

**By compromised component:**

- **Worker compromised (e.g., malicious dependency, or you can't trust the deployed code):** flip kill switch → **rotate the Plaid secret** (the Worker had it) → **rotate the KEK** (the Worker could decrypt tokens) → **`/item/access_token/invalidate` or `/item/remove`** the Plaid Item ([Plaid Items API](https://plaid.com/docs/api/items/)) → audit the dependency tree / lockfile diff to find the entry point → redeploy clean from a known-good commit → re-link the bank.
- **D1 compromised (data read):** because tokens are encrypted and the KEK isn't in D1, an attacker has ciphertext, not tokens — but **assume the worst and rotate the KEK + invalidate the Plaid token anyway**. Purge/rebuild the table from a clean Time Travel point or a verified backup. Note the disclosure: cached transactions were readable (privacy event); no funds exposure (no Transfer scope).
- **Plaid secret exposed:** rotate it immediately in the Plaid Dashboard, update Secrets Store, verify Worker calls, then rotate the data key as a precaution if the exposure vector could also have touched the Worker runtime.
- **Owner auth (passkey) compromised or device lost:** remove the lost authenticator's credential from the Worker's allowed-credential list, register a fresh passkey, and confirm no session minted by the old credential remains valid. Passkeys are phishing-resistant and bound to hardware, so this is the least likely auth-compromise mode — but the runbook should still exist.

**Universal closing steps for any incident:** `/item/remove` to fully revoke the Plaid Item and its `access_token` if you have *any* doubt about token integrity ([Plaid Items API](https://plaid.com/docs/api/items/)); purge cached transaction data; **re-link** the bank through Plaid Link to re-establish a clean Item; and write a two-line post-incident note (what, when, root cause, fix) — at solo scale that note is your entire institutional memory and the input to hardening the next layer.

---

### A.7 Prioritized: must-have vs. nice-to-have (single-user scale)

"Must-have" = do **before connecting a real bank**. "Nice-to-have" = sensible hardening as the project matures or before any second user.

| Control | Tier | Why at single-user scale |
|---|---|---|
| **Read-only Plaid products only (Transactions + Balance; Transfer never enabled)** | **MUST** | The one control that caps worst-case at "data read, no fund movement." Verify in the Plaid Dashboard before linking. |
| **Plaid secret + data key in Secrets Store; never in `wrangler.*`/repo/logs** | **MUST** | Write-only, RBAC, audited; prevents the most common real-world leak (secret-in-config). |
| **App-layer (envelope) encryption of `access_token` before D1** | **MUST** | Decouples D1-at-rest exposure from token exposure — the reason a DB dump isn't a fund-data breach. |
| **Hardware-key 2FA on Cloudflare + GitHub + Plaid accounts** | **MUST** | Account takeover is the worst single event; account 2FA is the cheapest defense and is *outside* the app code. |
| **Passkey/WebAuthn owner auth + CORS locked to exact Pages origin** | **MUST** | §4 items; phishing-resistant auth + origin lockdown stop the cheap web attacks. |
| **Kill switch (per-request flag, returns 503)** | **MUST** | First move in every incident; lets you stop everything in seconds without a redeploy. |
| **Minimal Worker deps + `npm ci` + lockfile + exact pins + `--ignore-scripts`** | **MUST** | The Worker is where secret+token+network meet; npm supply-chain is the realistic 2026 threat. |
| **Data minimization (store only fields the categorizer needs) + FileVault on the laptop** | **MUST** | Limits both Plaid-policy exposure and stolen-laptop / `localStorage` loss. |
| **Strict CSP + SRI on the Plaid Link script** | Should | Hardens against XSS, the most likely web attack; cheap to add to a static site. |
| **Scoped Cloudflare deploy token (Workers+D1 edit only) / OIDC if using CI** | Should | Bounds CI-leak blast radius; skip entirely if deploying manually from the laptop. |
| **Pinned GitHub Actions (SHA) + least-priv `GITHUB_TOKEN`** | Should (if CI used) | Only relevant once a deploy pipeline exists. |
| **Encrypted off-platform D1 backups (R2/local) beyond Time Travel** | Nice | Time Travel's 30-day PITR covers most operational needs; long-term encrypted dumps for durability. |
| **`npm audit signatures` / SLSA-provenance verification** | Nice | High value, low cost at minimal-dep scale; becomes a Should as deps grow. |
| **Written incident runbook + audit-log review habit** | Nice | At solo scale, the printed runbook in §A.6 *is* the program; formalize before any second user. |
| **Documented Safeguards-Rule-style program (qualified individual, risk assessment, vendor oversight)** | Deferred — **becomes MUST if opened to other users** | Not legally required single-user; the trigger is a second person's bank, not a feature flag. |

**The minimum bar before connecting a real bank:** every **MUST** row above. Each is implementable by a solo developer in this exact stack, and together they ensure that the worst realistic outcome of a full compromise is *someone reads your transaction history* — never *someone moves your money*.

---

### Appendix sources

- FTC — Gramm-Leach-Bliley Act overview: https://www.ftc.gov/business-guidance/privacy-security/gramm-leach-bliley-act
- IAPP — Guide to the Gramm-Leach-Bliley Act: https://iapp.org/resources/article/guide-to-the-gramm-leach-bliley-act
- PCI Security Standards Council — FAQs: https://www.pcisecuritystandards.org/faqs/all/
- PCI SSC — Data Storage Do's and Don'ts (PAN / cardholder data scope): https://listings.pcisecuritystandards.org/pdfs/pci_fs_data_storage.pdf
- Clym — CCPA Applicability 2026 (thresholds, ~$26.625M revenue): https://www.clym.io/blog/ccpa-applicability-guide
- Plaid — Developer Policy (effective April 19, 2026): https://plaid.com/developer-policy/
- Plaid — Items API (`/item/remove`, `/item/access_token/invalidate`): https://plaid.com/docs/api/items/
- Plaid — Do access tokens expire? (revocation via `/item/remove`): https://support.plaid.com/hc/en-us/articles/14977184144023-Do-access-tokens-expire
- Cloudflare — Secrets Store, Workers integration (write-only, RBAC, audit): https://developers.cloudflare.com/secrets-store/integrations/workers/
- Cloudflare — Workers secrets (per-Worker vs. account-level; keep out of config): https://developers.cloudflare.com/workers/configuration/secrets/
- Cloudflare — D1 Time Travel (30-day point-in-time recovery): https://developers.cloudflare.com/d1/reference/time-travel/
- Cloudflare — Workers + GitHub Actions deploy (scoped API tokens): https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/
- Cloudflare — Wrangler configuration: https://developers.cloudflare.com/workers/wrangler/configuration/
- StepSecurity — Pinning GitHub Actions to commit SHAs: https://www.stepsecurity.io/blog/pinning-github-actions-for-enhanced-security-a-complete-guide
- Wiz — Hardening GitHub Actions (least-priv GITHUB_TOKEN, OIDC, SHA pinning): https://www.wiz.io/blog/github-actions-security-guide
- Dev|Journal — npm provenance & SLSA baseline (2026): https://earezki.com/ai-news/2026-04-04-npm-provenance-and-slsa-the-supply-chain-hygiene-baseline-every-team-needs-in-2026/
- Mondoo — npm supply-chain security 2026 (npm ci, lockfiles, lifecycle scripts): https://mondoo.com/blog/npm-supply-chain-security-package-manager-defenses-2026
- Unit 42 (Palo Alto Networks) — npm threat landscape: https://unit42.paloaltonetworks.com/monitoring-npm-supply-chain-attacks/

