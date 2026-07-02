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

// ---------------------------------------------------------------------------
// sync() coverage — Plaid HTTP layer stubbed via globalThis.fetch.
// ---------------------------------------------------------------------------
const { encryptToken } = await import('../src/lib.js');
const env2 = { ...env, PLAID_CLIENT_ID: 'cid', PLAID_SECRET: 'sec' };
const req2 = (path, opts = {}) => worker.fetch(new Request(base + path, opts), env2);
const realFetch = globalThis.fetch;

function stubPlaid(handler) {
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (!u.includes('plaid.com')) throw new Error('unexpected fetch: ' + u);
    const body = JSON.parse(opts.body);
    const out = handler(u, body);
    return new Response(JSON.stringify(out.body), { status: out.status || 200, headers: { 'content-type': 'application/json' } });
  };
}
const ptxn = (id, date, amount, primary, detailed, name) => ({
  transaction_id: id, date, amount, name: name || id, merchant_name: null,
  iso_currency_code: 'USD', pending: false,
  personal_finance_category: { primary, detailed },
});
async function seedItem(id, token) {
  const enc = await encryptToken(env2, token);
  db.prepare('INSERT INTO items (item_id, access_token_enc, cursor) VALUES (?, ?, NULL)').run(id, enc);
}
const clearBank = () => { db.prepare('DELETE FROM items').run(); db.prepare('DELETE FROM transactions').run(); };

await check('sync: 2-page pagination upserts rows, persists final cursor, preserves manual bucket, applies removals', async () => {
  clearBank();
  await seedItem('itA', 'tokA');
  // Pre-existing manual override that page 1 will re-deliver as modified.
  db.prepare("INSERT INTO transactions (txn_id,item_id,date,name,amount,iso_currency,bucket,bucket_source,pending) VALUES ('m1','itA','2026-06-02','Vanguard Transfer',500,'USD','savings','manual',0)").run();
  stubPlaid((u, body) => {
    assert.ok(u.endsWith('/transactions/sync'));
    if (!body.cursor) return { body: {
      added: [ptxn('p1', '2026-06-03', 40, 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_RESTAURANT'),
              ptxn('p2', '2026-06-04', 900, 'RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_RENT')],
      modified: [ptxn('m1', '2026-06-02', 500, 'TRANSFER_OUT', 'TRANSFER_OUT_OTHER_TRANSFER_OUT')],
      removed: [], next_cursor: 'c1', has_more: true } };
    assert.equal(body.cursor, 'c1');
    return { body: { added: [ptxn('p3', '2026-06-05', 25, 'ENTERTAINMENT', 'ENTERTAINMENT_TV_AND_MOVIES')],
      modified: [], removed: [{ transaction_id: 'p1' }], next_cursor: 'c2', has_more: false } };
  });
  const r = await req2('/sync', { method: 'POST', headers: AUTH });
  const b = await r.json();
  assert.equal(r.status, 200);
  assert.equal(b.added, 3); assert.equal(b.modified, 1); assert.equal(b.removed, 1);
  assert.equal(b.partial, false); assert.deepEqual(b.itemErrors, []);
  assert.equal(db.prepare('SELECT cursor, error_code FROM items WHERE item_id=?').get('itA').cursor, 'c2');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM transactions WHERE txn_id=?').get('p1').c, 0); // removed
  assert.equal(db.prepare('SELECT bucket FROM transactions WHERE txn_id=?').get('p2').bucket, 'needs');
  const m1 = db.prepare('SELECT bucket, bucket_source FROM transactions WHERE txn_id=?').get('m1');
  assert.equal(m1.bucket, 'savings'); assert.equal(m1.bucket_source, 'manual'); // resync didn't clobber
});

await check('sync: MUTATION_DURING_PAGINATION restarts from the original cursor', async () => {
  clearBank();
  await seedItem('itB', 'tokB');
  db.prepare("UPDATE items SET cursor='orig' WHERE item_id='itB'").run();
  let calls = 0;
  stubPlaid((u, body) => {
    calls++;
    if (calls === 1) {
      assert.equal(body.cursor, 'orig');
      return { status: 400, body: { error_code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' } };
    }
    assert.equal(body.cursor, 'orig'); // restarted from the ORIGINAL cursor, not a partial one
    return { body: { added: [ptxn('b1', '2026-06-06', 60, 'TRANSPORTATION', 'TRANSPORTATION_GAS')],
      modified: [], removed: [], next_cursor: 'bc2', has_more: false } };
  });
  const r = await req2('/sync', { method: 'POST', headers: AUTH });
  const b = await r.json();
  assert.equal(r.status, 200); assert.equal(b.added, 1); assert.deepEqual(b.itemErrors, []);
  assert.equal(calls, 2);
  assert.equal(db.prepare("SELECT cursor FROM items WHERE item_id='itB'").get().cursor, 'bc2');
});

await check('sync: one broken item (ITEM_LOGIN_REQUIRED) is isolated; healthy items still sync', async () => {
  clearBank();
  await seedItem('itC1', 'tokC1');
  await seedItem('itC2', 'tokC2');
  stubPlaid((u, body) => {
    if (body.access_token === 'tokC1') return { status: 400, body: { error_code: 'ITEM_LOGIN_REQUIRED' } };
    return { body: { added: [ptxn('c2t', '2026-06-07', 80, 'PERSONAL_CARE', 'PERSONAL_CARE_HAIR_AND_BEAUTY')],
      modified: [], removed: [], next_cursor: 'cc', has_more: false } };
  });
  const r = await req2('/sync', { method: 'POST', headers: AUTH });
  const b = await r.json();
  assert.equal(r.status, 200);
  assert.deepEqual(b.itemErrors, [{ item_id: 'itC1', code: 'ITEM_LOGIN_REQUIRED' }]);
  assert.equal(b.added, 1);
  assert.equal(db.prepare("SELECT error_code FROM items WHERE item_id='itC1'").get().error_code, 'ITEM_LOGIN_REQUIRED');
  assert.equal(db.prepare("SELECT error_code FROM items WHERE item_id='itC2'").get().error_code, null);
  // /status surfaces the error so the UI can prompt a re-link
  const s = await (await req2('/status', { headers: AUTH })).json();
  assert.equal(s.items.find((i) => i.item_id === 'itC1').error_code, 'ITEM_LOGIN_REQUIRED');
});

await check('POST /transactions/bucket sets a manual override; invalid bucket -> 400', async () => {
  const r = await req2('/transactions/bucket', { method: 'POST', headers: AUTH, body: JSON.stringify({ txn_id: 'c2t', bucket: 'needs' }) });
  assert.equal(r.status, 200); assert.equal((await r.json()).changed, true);
  const row = db.prepare("SELECT bucket, bucket_source FROM transactions WHERE txn_id='c2t'").get();
  assert.equal(row.bucket, 'needs'); assert.equal(row.bucket_source, 'manual');
  const bad = await req2('/transactions/bucket', { method: 'POST', headers: AUTH, body: JSON.stringify({ txn_id: 'c2t', bucket: 'bogus' }) });
  assert.equal(bad.status, 400);
});

await check('summary income negates (not abs): a clawback reduces income', async () => {
  clearBank();
  const ins = (id, date, amount, bucket) => db.prepare(
    'INSERT INTO transactions (txn_id,item_id,date,name,amount,iso_currency,bucket,bucket_source,pending) VALUES (?,?,?,?,?,?,?,?,0)'
  ).run(id, 'it1', date, id, amount, 'USD', bucket, 'auto');
  ins('i1', '2026-07-01', -2500, 'income'); // deposit
  ins('i2', '2026-07-15', 100, 'income');   // payroll clawback (money out of the income bucket)
  const b = await (await req2('/summary?month=2026-07', { headers: AUTH })).json();
  assert.equal(b.summary.income, 2400); // 2500 - 100, not 2600
});

globalThis.fetch = realFetch;

console.log(`\nALL PASSED — ${passed} handler checks`);
