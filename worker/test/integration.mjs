// Integration test for the FULL Worker handler (src/index.js) without the Cloudflare
// runtime: we back env.DB with a real in-memory SQLite (node:sqlite) via a tiny D1 shim,
// and drive worker.fetch(Request, env) directly. Covers routing, auth, CORS, the kill
// switch, summary math, and rule validation. (Plaid network calls are exercised only to
// confirm the "not configured" guard fires — no Plaid account needed.)
//   run:  node --experimental-sqlite test/integration.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch (e) {
  console.log('SKIP integration: node:sqlite unavailable (' + e.message + ')');
  process.exit(0);
}

const __dir = dirname(fileURLToPath(import.meta.url));
const worker = (await import('../src/index.js')).default;

// --- minimal D1 shim over node:sqlite ---
class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...a) { this.args = a; return this; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  async first() { const r = this.db.prepare(this.sql).get(...this.args); return r ?? null; }
  async run() { return { success: true, meta: this.db.prepare(this.sql).run(...this.args) }; }
}
class D1 {
  constructor(db) { this.db = db; }
  prepare(sql) { return new Stmt(this.db, sql); }
  async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; }
}

const db = new DatabaseSync(':memory:');
db.exec(readFileSync(join(__dir, '..', 'schema.sql'), 'utf8'));

function b64key() { let b = ''; const a = crypto.getRandomValues(new Uint8Array(32)); for (const x of a) b += String.fromCharCode(x); return btoa(b); }
const env = {
  DB: new D1(db),
  PLAID_ENV: 'sandbox',
  ALLOWED_ORIGIN: 'https://gchipllc-del.github.io',
  APP_SECRET: 'test-secret',
  ENC_KEY: b64key(),
  // intentionally NO PLAID_CLIENT_ID / PLAID_SECRET
};

const AUTH = { Authorization: 'Bearer test-secret' };
const ORIGIN = { Origin: 'https://gchipllc-del.github.io' };
const base = 'https://api.test';
const req = (path, opts = {}) => worker.fetch(new Request(base + path, opts), env);

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('  ✓ ' + name); }

console.log('handler integration:');

await check('GET /health is public and ok', async () => {
  const r = await req('/health');
  const b = await r.json();
  assert.equal(r.status, 200); assert.equal(b.ok, true); assert.equal(b.env, 'sandbox');
});

await check('OPTIONS preflight returns 204 + CORS for allowed origin', async () => {
  const r = await req('/status', { method: 'OPTIONS', headers: ORIGIN });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://gchipllc-del.github.io');
});

await check('OPTIONS from disallowed origin omits ACAO', async () => {
  const r = await req('/status', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
});

await check('protected route rejects missing auth (401)', async () => {
  const r = await req('/status');
  assert.equal(r.status, 401);
});

await check('protected route rejects wrong auth (401)', async () => {
  const r = await req('/status', { headers: { Authorization: 'Bearer nope' } });
  assert.equal(r.status, 401);
});

await check('GET /status with auth returns empty state', async () => {
  const r = await req('/status', { headers: AUTH });
  const b = await r.json();
  assert.equal(r.status, 200); assert.equal(b.transactions, 0); assert.deepEqual(b.items, []); assert.equal(b.killed, false);
});

await check('POST /link/token surfaces NOT_CONFIGURED (no Plaid keys)', async () => {
  const r = await req('/link/token', { method: 'POST', headers: AUTH });
  const b = await r.json();
  assert.equal(r.status, 502); assert.equal(b.error, 'plaid_error'); assert.equal(b.code, 'NOT_CONFIGURED');
});

await check('unknown route -> 404', async () => {
  const r = await req('/nope', { headers: AUTH });
  assert.equal(r.status, 404);
});

await check('invalid rule -> 400', async () => {
  const r = await req('/rules', { method: 'POST', headers: AUTH, body: JSON.stringify({ match_type: 'bogus', match_value: 'x', bucket: 'needs' }) });
  assert.equal(r.status, 400);
});

await check('overlong rule match_value -> 400', async () => {
  const r = await req('/rules', { method: 'POST', headers: AUTH, body: JSON.stringify({ match_type: 'name_contains', match_value: 'x'.repeat(201), bucket: 'wants' }) });
  assert.equal(r.status, 400);
});

await check('malformed month -> 400', async () => {
  const r = await req('/summary?month=2026-0_', { headers: AUTH });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'bad_month');
});

// Seed transactions directly, then verify /summary math (Plaid sign convention).
await check('summary aggregates buckets with correct signs', async () => {
  const ins = (id, date, amount, bucket) => db.prepare(
    'INSERT INTO transactions (txn_id,item_id,date,name,amount,iso_currency,bucket,bucket_source,pending) VALUES (?,?,?,?,?,?,?,?,0)'
  ).run(id, 'it1', date, id, amount, 'USD', bucket, 'auto');
  ins('t1', '2026-06-03', 1200, 'needs');   // money out
  ins('t2', '2026-06-04', 300, 'needs');
  ins('t3', '2026-06-05', 500, 'wants');
  ins('t4', '2026-06-06', 400, 'savings');
  ins('t5', '2026-06-01', -2500, 'income');  // money in (negative in Plaid)
  ins('t6', '2026-05-15', 999, 'wants');     // different month, must be excluded
  const r = await req('/summary?month=2026-06', { headers: AUTH });
  const b = await r.json();
  assert.equal(r.status, 200);
  assert.equal(b.summary.income, 2500);
  assert.equal(b.summary.needs, 1500);
  assert.equal(b.summary.wants, 500);
  assert.equal(b.summary.savings, 400);
});

await check('valid rule applies + recategorizes existing txns', async () => {
  // name 'wants store' contains 'store' -> reclassify to needs
  db.prepare('INSERT INTO transactions (txn_id,item_id,date,name,amount,iso_currency,bucket,bucket_source,pending) VALUES (?,?,?,?,?,?,?,?,0)')
    .run('r1', 'it1', '2026-06-09', 'Corner Store', 50, 'USD', 'wants', 'auto');
  const r = await req('/rules', { method: 'POST', headers: AUTH, body: JSON.stringify({ match_type: 'name_contains', match_value: 'corner store', bucket: 'needs' }) });
  const b = await r.json();
  assert.equal(r.status, 200); assert.ok(b.recategorized >= 1);
  const row = db.prepare('SELECT bucket,bucket_source FROM transactions WHERE txn_id=?').get('r1');
  assert.equal(row.bucket, 'needs'); assert.equal(row.bucket_source, 'rule');
});

await check('kill switch blocks data routes (503), allows /status, then resume', async () => {
  let r = await req('/kill', { method: 'POST', headers: AUTH });
  assert.equal(r.status, 200);
  r = await req('/transactions?month=2026-06', { headers: AUTH });
  assert.equal(r.status, 503);
  r = await req('/status', { headers: AUTH });           // status still allowed while killed
  assert.equal(r.status, 200);
  assert.equal((await r.json()).killed, true);
  r = await req('/resume', { method: 'POST', headers: AUTH });
  assert.equal(r.status, 200);
  r = await req('/transactions?month=2026-06', { headers: AUTH });
  assert.equal(r.status, 200);
});

await check('disconnect with no items purges + returns ok', async () => {
  const r = await req('/disconnect', { method: 'POST', headers: AUTH });
  assert.equal(r.status, 200); assert.equal((await r.json()).ok, true);
  const c = db.prepare('SELECT COUNT(*) AS c FROM transactions').get();
  assert.equal(c.c, 0);
});

console.log(`\nALL PASSED — ${passed} handler checks`);
