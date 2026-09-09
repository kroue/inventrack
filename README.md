# InvenTrack

A web-based inventory tracking and point-of-sale system with predictive analytics,
built for **Al-Bazar Enterprises** (Panggao Saduc, Marawi City, Lanao del Sur).

InvenTrack replaces a manual, handwritten stock process with one system that records
sales at the till, deducts stock in real time, forecasts demand from sales history,
and tells the owner what to reorder before a product runs out.

---

## Contents

- [What it does](#what-it-does)
- [Tech stack](#tech-stack)
- [The inventory logic](#the-inventory-logic)
- [Architecture](#architecture)
- [Roles and access](#roles-and-access)
- [Running it locally](#running-it-locally)
- [Setting up the backend](#setting-up-the-backend)
- [Deploying](#deploying)
- [The offline workflow](#the-offline-workflow)
- [Managing staff accounts](#managing-staff-accounts)
- [Diagnostics](#diagnostics)
- [Project structure](#project-structure)

---

## What it does

**Point of sale.** Cashiers scan a barcode or search for a product, and the cart
prices each line automatically. Completing a sale deducts stock, writes the audit
trail, and prints an 80mm receipt.

**Real-time inventory.** Every sale, delivery, return and adjustment moves stock in
one transaction, so the recorded quantity and the physical shelf stay in step.

**Demand forecasting.** Sales history feeds an Exponential Moving Average that
produces a daily sales velocity per product, which drives the reorder point and the
suggested order quantity.

**Automated restocking alerts.** When stock crosses its reorder point the database
raises an alert and emails the administrator, without anyone needing to open the app.

**Procurement workflow.** Restock list → purchase order → delivery verification,
supporting both supplier deliveries and pick-ups.

**Batch and expiry tracking.** Stock is held in batches with expiration dates. Sales
draw First Expired, First Out; near-expiry stock is marked down automatically; and
expired stock is withheld from sale entirely.

**Product movement analysis.** Products are ranked most-sold to least and classified
fast or slow moving over a rolling window.

**Offline fallback.** When the power or internet is out, cashiers record sales on a
prepared Excel form and upload it afterwards.

**Full audit trail.** Every stock movement is written to a stock log with its type,
quantity, reason and the user responsible.

---

## Tech stack

| Layer | Technology |
| --- | --- |
| Frontend | Angular 22 (standalone components, signals) |
| Styling | Tailwind CSS 4 |
| Backend | Supabase — PostgreSQL, Auth, Edge Functions |
| Business logic | PL/pgSQL functions + TypeScript services |
| Email | Resend, via a Supabase Edge Function |
| Spreadsheets | SheetJS (`xlsx`) |
| Hosting | Vercel |

---

## The inventory logic

The forecasting model lives in `src/app/services/inventory-logic.service.ts`.

### Daily sales velocity — Exponential Moving Average

```
V(i,t) = ( S(i,t) × α ) + ( V(i,t−1) × (1 − α) )
```

- `S(i,t)` — units of product *i* sold on day *t*
- `α` — smoothing factor, `2 / (n + 1)`
- `n` — window, fixed at **30 days**

The series is built dense: a day with no transactions counts as zero rather than
being skipped, because dropping empty days would overstate velocity. The recurrence
is seeded with the window mean.

### Reorder point

```
ROP(i) = ( V(i) × L(i) ) + ss(i)
```

`L` is the supplier lead time in days and `ss` the safety stock. An alert is raised
when `Q(i) ≤ ROP(i)`.

### Suggested order quantity

```
O(i) = ( V(i) × P ) − Q(i)
```

`P` is the projection period (30 days) and `Q` the current stock on hand.

### Expiry risk and markdown

Evaluated per batch, against the days remaining before its expiration date:

| Days remaining | State | Effect |
| --- | --- | --- |
| > 30 | Normal | Sold at retail price |
| 15 – 30 | Warning | Retail price, flagged on the dashboard |
| 0 – 14 | Near-Expiry | Marked down by the product's discount rate |
| < 0 | **Expired** | **Withheld from sale**; must be written off |

### FEFO depletion

A sale consumes batches in expiry order, and can span several. Each slice is priced
by the shelf life of the batch those particular units came from, so a line straddling
a near-expiry batch and a fresh one produces two priced segments and two `sale_items`
rows. Batch rows are locked with `FOR UPDATE` so two concurrent checkouts cannot sell
the same unit.

---

## Architecture

```
Angular SPA (Vercel)
        │  supabase-js
        ▼
Supabase ── PostgreSQL ── Row Level Security (Admin / Cashier)
        │        │
        │        ├── RPCs: process_pos_sale, import_offline_sales,
        │        │         record_stock_adjustment, reconcile_batch_inventory
        │        │
        │        └── trigger: stock ≤ reorder point → alerts
        │                            │  pg_net webhook
        │                            ▼
        └── Edge Functions ── send-alert-email ──► Resend ──► Admin inbox
                           └─ manage-staff  (service role: cashier accounts)
```

**Money and stock are server-authoritative.** The browser sends only product ids and
quantities; the database reads its own prices, chooses the batches, calculates the
markdown, and computes the total. The client's figures are a preview.

**Nothing sensitive is bundled.** Only the Supabase *anon* key ships to the browser.
The service-role key exists solely inside Edge Functions and a locked-down settings
table.

---

## Roles and access

| Capability | Admin | Cashier |
| --- | :---: | :---: |
| POS checkout | ✅ | ✅ |
| Offline sales upload | ✅ | ✅ |
| Dashboard and analytics | ✅ | — |
| Inventory, products, discount rates | ✅ | — |
| Procurement, suppliers, deliveries | ✅ | — |
| Stock log, sales history | ✅ | — |
| Staff accounts | ✅ | — |

Enforced in two places: Angular route guards for navigation, and PostgreSQL Row
Level Security for data. The role is read from the database — never inferred from
the token or the email address.

---

## Running it locally

### Prerequisites

- **Node.js 20 or newer** (developed on v24)
- **npm 10+**
- A Supabase project
- Supabase CLI, available through `npx` — no global install needed

### 1. Clone and install

```bash
git clone https://github.com/kroue/inventrack.git
```

```bash
cd inventrack && npm install
```

### 2. Add your Supabase credentials

Create `src/environments/environment.local.ts` — it is gitignored and never committed:

```ts
export const environment = {
  production: false,
  supabaseUrl: 'https://<your-project-ref>.supabase.co',
  supabaseAnonKey: '<your-anon-key>',
};
```

Both values are in the Supabase dashboard under **Settings → API**. Use the **anon**
key here, never the service-role key — this file is compiled into the browser bundle.

### 3. Start the dev server

```bash
npm start
```

Open `http://localhost:4200`. The app reloads on save.

> The service worker is disabled in development, so offline behaviour only appears in
> a production build.

### 4. Sign in

You need at least one Admin. See [Managing staff accounts](#managing-staff-accounts)
— public sign-up is disabled by design, so accounts are created deliberately.

---

## Setting up the backend

Only needed for a fresh Supabase project. Link the CLI once:

```bash
npx supabase link --project-ref <your-project-ref>
```

### Apply the database schema

```bash
npx supabase db push
```

This runs every migration in `supabase/migrations/` in order — tables, RLS policies,
the POS and procurement RPCs, the alerting triggers and the security hardening. Check
what would run first with `npx supabase db push --dry-run`.

### Deploy the Edge Functions

```bash
npx supabase functions deploy send-alert-email
```

```bash
npx supabase functions deploy manage-staff
```

### Configure email alerts

Set the Resend credentials as function secrets:

```bash
npx supabase secrets set RESEND_API_KEY=re_xxx ALERT_RECIPIENT=owner@example.com
```

Optionally set a sender on a domain you have verified in Resend. Without it the
shared test sender is used, which only delivers to your own Resend account address:

```bash
npx supabase secrets set ALERT_SENDER="InvenTrack <alerts@yourdomain.com>"
```

Then point the database at the function. Run this in the Supabase SQL editor — the
service-role key must not be pasted anywhere it could be committed:

```sql
INSERT INTO private.app_settings (key, value) VALUES
  ('alert_function_url', 'https://<your-project-ref>.supabase.co/functions/v1/send-alert-email'),
  ('alert_function_key', '<your-service-role-key>')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
```

Until this row exists, alerts are still recorded — they just do not send email.

### Turn off public sign-up

In **Authentication → Providers → Email**, disable *Allow new users to sign up*.
InvenTrack has no self-registration flow, and the endpoint is public otherwise.

---

## Deploying

Hosted on Vercel. `environment.prod.ts` is generated at build time from environment
variables, so no credentials live in the repository.

Set these in **Project Settings → Environment Variables**:

| Variable | Value |
| --- | --- |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | The anon key |

Build command must be `npm run build` — the `prebuild` hook is what generates the
environment file. The build **fails deliberately** if either variable is missing, or
if a service-role key is supplied where the anon key belongs, rather than shipping a
broken or unsafe bundle.

Output directory: `dist/inventrack/browser`.

```bash
npm run build
```

---

## The offline workflow

Sales cannot be recorded without a connection: stock deduction, batch allocation and
the locks preventing concurrent oversell all live on the server. Queuing sales in the
browser would let two terminals sell the same last unit, so InvenTrack uses a manual
fallback instead.

1. **Before an outage**, download the blank form from **Offline Sync**. A service
   worker caches it, but keep a saved copy — a power cut takes the device too.
2. **During the outage**, record each sale as a row: date, barcode, product name,
   quantity and unit price. **Barcode is required** — names are not used to identify
   products, because a mistyped name could deduct stock from the wrong item.
3. **Afterwards**, upload the file from **Offline Sync**.

The import runs in one transaction: a single bad row rejects the whole file and names
the row number. Stock is depleted FEFO exactly as the POS would, expired batches are
excluded, and the price on the sheet is recorded as what the customer actually paid.

While offline the app shows a banner explaining the state instead of failing silently.

---

## Managing staff accounts

**Cashiers are managed entirely in InvenTrack.** Under **Users → Add Staff**, choose
the Cashier role and set a temporary password. The `manage-staff` Edge Function
creates the Supabase Auth login and the staff record together, correctly linked.
Editing a cashier updates their login email; deleting one removes both the record and
the login — unless they have recorded transactions, in which case deletion is refused
and the account should be deactivated so the audit trail stays intact.

**Administrators are created in Supabase.** Add the user under **Authentication →
Users** in the dashboard, then add them in **Users → Add Staff** with the Admin role
to link the staff record. Adding an admin with no matching login is refused rather
than leaving an orphaned record.

Passwords are never stored by InvenTrack. Authentication is entirely Supabase Auth.

---

## Diagnostics

Admin-only functions, callable from the Supabase SQL editor:

```sql
SELECT alert_webhook_status();
```

Reports whether the notification service is configured, without revealing the key.
`key_length` should be roughly 200 — a service-role key is a JWT.

```sql
SELECT reconcile_batch_inventory();
```

Realigns the batch pool with `inventory.stock_quantity` if they ever disagree, writing
an `ADJUST` entry to the stock log for every correction. Safe to re-run.

```sql
SELECT probe_alert_webhook();
-- then, a few seconds later, with the returned id:
SELECT read_webhook_probe(<request_id>);
```

Tests the database → Edge Function link **without sending an email**. A `400` means
authentication succeeded and the deliberately malformed payload was rejected as
designed; `401` means the stored key is not accepted.

---

## Project structure

```
src/app/
  components/
    dashboard/       Analytics, forecasts, product movement, reports
    inventory/       Products, stock adjustment, markdown rates
    pos-checkout/    Till: scanning, FEFO cart, checkout, receipt
    procurement/     Restock list, purchase orders, deliveries, suppliers
    stock-log/       Audit trail and returns
    sales-history/   Past transactions
    offline-sync/    Excel template download and import
    users/           Staff accounts
    login/
  services/
    inventory-logic.service.ts   EMA, ROP, SOQ, expiry risk, analytics
    procurement.service.ts       Restock list, POs, deliveries
    supabase.service.ts          Client and RPC wrappers
    auth.service.ts              Session and role resolution
    connectivity.service.ts      Online/offline state
  guards/            Route protection by auth state and role
  models/            TypeScript interfaces mirroring the schema

supabase/
  migrations/        Schema, RLS, RPCs, triggers — applied in order
  functions/
    send-alert-email/  Low-stock and near-expiry email notifications
    manage-staff/      Cashier account lifecycle (service role)

public/templates/    Offline sales log spreadsheet
scripts/             Environment generation, template generation
```

### Useful commands

| Command | Purpose |
| --- | --- |
| `npm start` | Dev server on port 4200 |
| `npm run build` | Production build (runs `prebuild` first) |
| `npm test` | Unit tests (Vitest) |
| `npx supabase db push` | Apply pending migrations |
| `npx supabase migration list --linked` | Compare local and remote migrations |
| `node scripts/generate-offline-template.js` | Rebuild the Excel template |

> If you rename a column in `offline-sync.ts`, regenerate the Excel template — the
> header row and the importer must match exactly.

---

## Author

**Aljohn Arranguez** — undergraduate research project, InvenTrack v1.0.
