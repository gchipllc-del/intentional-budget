// Intentional Budget API — Cloudflare Worker
// READ-ONLY Plaid aggregation for a single owner. Never enables Transfer/Payments,
// so no credential in this system can move money. All money data is server-side here.
//
// Endpoints (all except /health and OPTIONS require Authorization: Bearer <APP_SECRET>):
//   GET  /health                 -> liveness, no auth
//   GET  /status                 -> linked items + txn count
//   POST /link/token             -> create a Plaid Link token (for the browser widget)
//   POST /link/exchange          -> public_token -> access_token (encrypted + stored)
//   POST /dev/sandbox-link       -> sandbox-only: mint+exchange a fake item (no UI needed)
//   POST /sync                   -> pull transactions, categorize, cache
//   GET  /transactions?month=YYYY-MM
//   GET  /summary?month=YYYY-MM  -> {income,needs,wants,savings} totals
//   POST /rules                  -> add a category rule + recategorize
//   POST /transactions/bucket    -> manual per-txn bucket override (survives resync)
//   POST /kill  /resume          -> soft kill switch (503 everything) / undo
//   POST /disconnect             -> remove items at Plaid + purge all cached data

import {
  corsHeaders, authOK, encryptToken, decryptToken, categorize,
} from './lib.js';

const validMonth = (m) => /^\d{4}-\d{2}$/.test(m);

const J = { 'content-type': 'application/json' };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (path === '/health' && request.method === 'GET') {
      return json({ ok: true, service: 'intentional-budget-api', env: env.PLAID_ENV || 'sandbox' }, 200, cors);
    }

    // Everything below requires owner auth.
    if (!(await authOK(request.headers.get('Authorization'), env))) return json({ error: 'unauthorized' }, 401, cors);

    // Soft kill switch: when set, refuse all data/Plaid calls except the ones
    // needed to inspect, resume, or fully disconnect.
    if (await isKilled(env) && !['/resume', '/status', '/disconnect'].includes(path)) {
      return json({ error: 'integration_disabled' }, 503, cors);
    }

    try {
      if (path === '/status' && request.method === 'GET') return await status(env, cors);
      if (path === '/link/token' && request.method === 'POST') return await linkToken(env, cors);
      if (path === '/link/exchange' && request.method === 'POST') return await linkExchange(request, env, cors);
      if (path === '/dev/sandbox-link' && request.method === 'POST') return await sandboxLink(request, env, cors);
      if (path === '/sync' && request.method === 'POST') return await sync(env, cors);
      if (path === '/transactions' && request.method === 'GET') return await getTransactions(url, env, cors);
      if (path === '/summary' && request.method === 'GET') return await getSummary(url, env, cors);
      if (path === '/rules' && request.method === 'POST') return await addRule(request, env, cors);
      if (path === '/transactions/bucket' && request.method === 'POST') return await setBucket(request, env, cors);
      if (path === '/kill' && request.method === 'POST') return await setKilled(env, cors, true);
      if (path === '/resume' && request.method === 'POST') return await setKilled(env, cors, false);
      if (path === '/disconnect' && request.method === 'POST') return await disconnect(env, cors);
      return json({ error: 'not_found' }, 404, cors);
    } catch (e) {
      // Never leak internals/secrets to the client. Plaid error codes are safe to surface.
      const code = e && e.plaidCode;
      console.log('handler_error', path, e && e.message);
      return json(code ? { error: 'plaid_error', code } : { error: 'server_error' }, code ? 502 : 500, cors);
    }
  },
};

// ---------- helpers ----------
function json(obj, statusCode, cors) {
  return new Response(JSON.stringify(obj), { status: statusCode, headers: { ...J, ...cors } });
}

function plaidBase(env) {
  return (env.PLAID_ENV === 'production') ? 'https://production.plaid.com' : 'https://sandbox.plaid.com';
}
async function plaid(env, apiPath, body) {
  if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET) {
    const e = new Error('plaid_not_configured'); e.plaidCode = 'NOT_CONFIGURED'; throw e;
  }
  const res = await fetch(plaidBase(env) + apiPath, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error('plaid_http_' + res.status);
    e.plaidCode = data.error_code || ('HTTP_' + res.status);
    throw e;
  }
  return data;
}

async function audit(env, event, detail) {
  try {
    await env.DB.prepare('INSERT INTO audit_log (event, detail) VALUES (?, ?)').bind(event, String(detail || '')).run();
  } catch (e) {
    // audit must never break the request, but a dropped audit record is itself notable
    console.log('audit_failed', event, e && e.message);
  }
}

async function isKilled(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key='killed'").first().catch(() => null);
  return !!(row && row.value === '1');
}
async function setKilled(env, cors, killed) {
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('killed', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).bind(killed ? '1' : '0').run();
  await audit(env, killed ? 'kill_switch_on' : 'kill_switch_off', '');
  return json({ ok: true, killed }, 200, cors);
}

// ---------- endpoints ----------
async function status(env, cors) {
  const items = await env.DB.prepare('SELECT item_id, institution, updated_at, error_code FROM items').all();
  const tx = await env.DB.prepare('SELECT COUNT(*) AS c FROM transactions').first();
  return json({
    ok: true,
    env: env.PLAID_ENV || 'sandbox',
    killed: await isKilled(env),
    items: items.results || [],
    transactions: tx ? tx.c : 0,
  }, 200, cors);
}

async function linkToken(env, cors) {
  const data = await plaid(env, '/link/token/create', {
    user: { client_user_id: 'owner' },
    client_name: 'Intentional',
    products: ['transactions'], // data-only; Transfer is never requested
    country_codes: ['US'],
    language: 'en',
  });
  return json({ link_token: data.link_token, expiration: data.expiration }, 200, cors);
}

async function storeItem(env, accessToken, itemId) {
  const enc = await encryptToken(env, accessToken);
  let inst = null;
  try {
    const it = await plaid(env, '/item/get', { access_token: accessToken });
    const instId = it.item && it.item.institution_id;
    if (instId) {
      const ig = await plaid(env, '/institutions/get_by_id', { institution_id: instId, country_codes: ['US'] });
      inst = ig.institution && ig.institution.name;
    }
  } catch (e) { /* institution name is best-effort */ }
  await env.DB.prepare(
    `INSERT INTO items (item_id, institution, access_token_enc, cursor, updated_at)
     VALUES (?, ?, ?, NULL, datetime('now'))
     ON CONFLICT(item_id) DO UPDATE SET access_token_enc=excluded.access_token_enc,
       institution=excluded.institution, updated_at=datetime('now')`
  ).bind(itemId, inst, enc).run();
  await audit(env, 'item_linked', inst || itemId);
  return { item_id: itemId, institution: inst };
}

async function linkExchange(request, env, cors) {
  const body = await request.json().catch(() => ({}));
  if (!body.public_token) return json({ error: 'missing_public_token' }, 400, cors);
  const ex = await plaid(env, '/item/public_token/exchange', { public_token: body.public_token });
  const out = await storeItem(env, ex.access_token, ex.item_id);
  return json({ ok: true, ...out }, 200, cors);
}

// Sandbox-only convenience: create a fake item without the Link UI, for end-to-end proof.
async function sandboxLink(request, env, cors) {
  if ((env.PLAID_ENV || 'sandbox') !== 'sandbox') return json({ error: 'sandbox_only' }, 403, cors);
  const body = await request.json().catch(() => ({}));
  const institution_id = body.institution_id || 'ins_109508'; // "First Platypus Bank" test institution
  const pt = await plaid(env, '/sandbox/public_token/create', {
    institution_id,
    initial_products: ['transactions'],
  });
  const ex = await plaid(env, '/item/public_token/exchange', { public_token: pt.public_token });
  const out = await storeItem(env, ex.access_token, ex.item_id);
  return json({ ok: true, sandbox: true, ...out }, 200, cors);
}

async function loadRules(env) {
  const r = await env.DB.prepare('SELECT match_type, match_value, bucket FROM rules').all();
  return r.results || [];
}

// Build (don't run) the upsert so sync() can apply a whole Plaid page as one atomic batch.
function upsertStmt(env, rules, itemId, t) {
  const primary = t.personal_finance_category ? t.personal_finance_category.primary : null;
  const detailed = t.personal_finance_category ? t.personal_finance_category.detailed : null;
  const cat = categorize(rules, t, primary, detailed);
  return env.DB.prepare(
    `INSERT INTO transactions
       (txn_id, item_id, date, name, merchant, amount, iso_currency, pfc_primary, pfc_detailed, bucket, bucket_source, pending)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(txn_id) DO UPDATE SET
       date=excluded.date, name=excluded.name, merchant=excluded.merchant, amount=excluded.amount,
       iso_currency=excluded.iso_currency, pfc_primary=excluded.pfc_primary, pfc_detailed=excluded.pfc_detailed,
       pending=excluded.pending,
       -- never clobber a manual override on resync
       bucket=CASE WHEN transactions.bucket_source='manual' THEN transactions.bucket ELSE excluded.bucket END,
       bucket_source=CASE WHEN transactions.bucket_source='manual' THEN 'manual' ELSE excluded.bucket_source END`
  ).bind(
    t.transaction_id, itemId, t.date, t.name || null, t.merchant_name || null,
    t.amount, t.iso_currency_code || 'USD', primary, detailed, cat.bucket, cat.source, t.pending ? 1 : 0
  );
}

async function sync(env, cors) {
  const items = await env.DB.prepare('SELECT item_id, access_token_enc, cursor FROM items').all();
  const rules = await loadRules(env);
  let added = 0, modified = 0, removed = 0, partial = false;
  const itemErrors = [];
  for (const it of (items.results || [])) {
    // One broken item (e.g. ITEM_LOGIN_REQUIRED after a bank forces re-auth) must not
    // block the others: record its error on the item row and keep going.
    try {
      const token = await decryptToken(env, it.access_token_enc);
      let cursor = it.cursor || null;
      let hasMore = true;
      let guard = 0, restarts = 0;
      while (hasMore && guard++ < 50) {
        let res;
        try {
          res = await plaid(env, '/transactions/sync', cursor ? { access_token: token, cursor } : { access_token: token });
        } catch (e) {
          // Plaid documents this as EXPECTED during long paginations; required handling
          // is a restart from the item's original cursor (upserts are idempotent).
          if (e && e.plaidCode === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' && restarts++ < 3) {
            cursor = it.cursor || null;
            continue;
          }
          throw e;
        }
        const stmts = [];
        for (const t of (res.added || [])) { stmts.push(upsertStmt(env, rules, it.item_id, t)); added++; }
        for (const t of (res.modified || [])) { stmts.push(upsertStmt(env, rules, it.item_id, t)); modified++; }
        for (const t of (res.removed || [])) {
          stmts.push(env.DB.prepare('DELETE FROM transactions WHERE txn_id=?').bind(t.transaction_id));
          removed++;
        }
        if (stmts.length) await env.DB.batch(stmts); // one atomic batch per page, not per txn
        cursor = res.next_cursor;
        hasMore = !!res.has_more;
      }
      if (hasMore) partial = true; // hit the pagination guard with pages left
      await env.DB.prepare("UPDATE items SET cursor=?, updated_at=datetime('now'), error_code=NULL WHERE item_id=?")
        .bind(cursor, it.item_id).run();
    } catch (e) {
      const code = (e && e.plaidCode) || 'ERROR';
      itemErrors.push({ item_id: it.item_id, code });
      await env.DB.prepare('UPDATE items SET error_code=? WHERE item_id=?').bind(code, it.item_id).run();
    }
  }
  await audit(env, 'sync', `+${added} ~${modified} -${removed}${partial ? ' partial' : ''}${itemErrors.length ? ` item_errors=${itemErrors.length}` : ''}`);
  return json({ ok: true, added, modified, removed, partial, itemErrors }, 200, cors);
}

async function getTransactions(url, env, cors) {
  const month = url.searchParams.get('month');
  if (month && !validMonth(month)) return json({ error: 'bad_month' }, 400, cors);
  // BETWEEN on zero-padded YYYY-MM-DD uses idx_txn_date; LIKE-prefix would full-scan on D1.
  const sql = month
    ? 'SELECT txn_id,date,name,merchant,amount,iso_currency,pfc_primary,bucket,bucket_source,pending FROM transactions WHERE date BETWEEN ? AND ? ORDER BY date DESC'
    : 'SELECT txn_id,date,name,merchant,amount,iso_currency,pfc_primary,bucket,bucket_source,pending FROM transactions ORDER BY date DESC LIMIT 200';
  const stmt = month ? env.DB.prepare(sql).bind(month + '-01', month + '-31') : env.DB.prepare(sql);
  const rows = await stmt.all();
  return json({ month: month || null, transactions: rows.results || [] }, 200, cors);
}

async function getSummary(url, env, cors) {
  const month = url.searchParams.get('month');
  if (month && !validMonth(month)) return json({ error: 'bad_month' }, 400, cors);
  const sql = month
    ? 'SELECT bucket, SUM(amount) AS total, COUNT(*) AS c FROM transactions WHERE date BETWEEN ? AND ? GROUP BY bucket'
    : 'SELECT bucket, SUM(amount) AS total, COUNT(*) AS c FROM transactions GROUP BY bucket';
  const stmt = month ? env.DB.prepare(sql).bind(month + '-01', month + '-31') : env.DB.prepare(sql);
  const rows = await stmt.all();
  // Plaid amounts: positive = money out (spending), negative = money in (income/deposits).
  const out = { income: 0, needs: 0, wants: 0, savings: 0, ignore: 0 };
  for (const r of (rows.results || [])) {
    const total = r.total || 0;
    // Negate (not abs): a month whose income bucket nets positive (clawback > deposits)
    // must report negative income truthfully, not fabricate it.
    if (r.bucket === 'income') out.income += -total;
    else if (out[r.bucket] !== undefined) out[r.bucket] += total;
  }
  return json({ month: month || null, summary: out }, 200, cors);
}

async function addRule(request, env, cors) {
  const body = await request.json().catch(() => ({}));
  const { match_type, bucket } = body;
  const mv = body.match_value == null ? '' : String(body.match_value).trim();
  const okType = ['merchant', 'name_contains', 'pfc'].includes(match_type);
  const okBucket = ['needs', 'wants', 'savings', 'income', 'ignore'].includes(bucket);
  if (!okType || !okBucket || !mv || mv.length > 200) return json({ error: 'invalid_rule' }, 400, cors);
  await env.DB.prepare('INSERT INTO rules (match_type, match_value, bucket) VALUES (?, ?, ?)')
    .bind(match_type, mv, bucket).run();
  // Recategorize existing non-manual transactions atomically (single D1 batch).
  const rules = await loadRules(env);
  const all = await env.DB.prepare("SELECT txn_id,name,merchant,pfc_primary,pfc_detailed FROM transactions WHERE bucket_source!='manual'").all();
  const stmts = [];
  for (const t of (all.results || [])) {
    const cat = categorize(rules, { name: t.name, merchant_name: t.merchant }, t.pfc_primary, t.pfc_detailed);
    stmts.push(env.DB.prepare('UPDATE transactions SET bucket=?, bucket_source=? WHERE txn_id=?').bind(cat.bucket, cat.source, t.txn_id));
  }
  if (stmts.length) await env.DB.batch(stmts);
  await audit(env, 'rule_added', `${match_type}:${mv}=>${bucket}`);
  return json({ ok: true, recategorized: stmts.length }, 200, cors);
}

// Manual per-transaction override; survives resync via the ON CONFLICT manual-preservation CASE.
async function setBucket(request, env, cors) {
  const body = await request.json().catch(() => ({}));
  const txnId = body.txn_id == null ? '' : String(body.txn_id);
  const { bucket } = body;
  if (!txnId || txnId.length > 100 || !['needs', 'wants', 'savings', 'income', 'ignore'].includes(bucket)) {
    return json({ error: 'invalid_bucket' }, 400, cors);
  }
  const r = await env.DB.prepare("UPDATE transactions SET bucket=?, bucket_source='manual' WHERE txn_id=?")
    .bind(bucket, txnId).run();
  const changed = !!(r && r.meta && (r.meta.changes === undefined || r.meta.changes > 0));
  await audit(env, 'bucket_manual', `${txnId}=>${bucket}`);
  return json({ ok: true, changed }, 200, cors);
}

async function disconnect(env, cors) {
  const items = await env.DB.prepare('SELECT item_id, access_token_enc FROM items').all();
  let revokeFailures = 0;
  for (const it of (items.results || [])) {
    try {
      const token = await decryptToken(env, it.access_token_enc);
      await plaid(env, '/item/remove', { access_token: token });
    } catch (e) { revokeFailures++; } // still purge locally; surface the count below
  }
  await env.DB.prepare('DELETE FROM transactions').run();
  await env.DB.prepare('DELETE FROM items').run();
  // Clear the kill switch so a fresh re-link starts from a clean state.
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('killed', '0') ON CONFLICT(key) DO UPDATE SET value='0'").run();
  await audit(env, 'disconnect', `items removed + data purged; revoke_failures=${revokeFailures}`);
  // If any Plaid revoke failed, the token may still be valid at Plaid — tell the owner to remove it there.
  return json({ ok: true, revokeFailures }, 200, cors);
}
