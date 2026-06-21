// Intentional Budget API — pure helpers (no Worker/D1 dependencies, unit-testable in Node).
// Web Crypto (crypto.subtle), atob/btoa, TextEncoder are all available in both
// the Cloudflare Workers runtime AND Node 18+/22, so this file runs in tests too.

// ---------- base64 <-> bytes ----------
export function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- constant-time compare (auth) ----------
// Compare two byte arrays without short-circuiting on content.
export function ctEqualBytes(a, b) {
  let r = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) r |= (a[i] || 0) ^ (b[i] || 0);
  return r === 0;
}
export function timingSafeEqual(a, b) {
  return ctEqualBytes(new TextEncoder().encode(String(a || '')), new TextEncoder().encode(String(b || '')));
}

// Owner auth. Both sides are hashed to fixed 32-byte SHA-256 digests BEFORE comparing,
// so neither the secret's length nor its byte values create a timing oracle.
export async function authOK(authHeader, env) {
  const want = (env && env.APP_SECRET) || '';
  if (!want) return false; // fail closed if not configured
  const got = String(authHeader || '').replace(/^Bearer\s+/i, '');
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(got)),
    crypto.subtle.digest('SHA-256', enc.encode(want)),
  ]);
  return ctEqualBytes(new Uint8Array(ha), new Uint8Array(hb));
}

// ---------- CORS ----------
export function allowedOrigins(env) {
  const list = [];
  if (env && env.ALLOWED_ORIGIN) list.push(env.ALLOWED_ORIGIN);
  // Localhost is allowed ONLY when explicitly opted in for local dev (ALLOW_LOCALHOST=1),
  // never by default — so a deployed worker can't be read from a victim's localhost page.
  if (env && env.ALLOW_LOCALHOST === '1') list.push('http://localhost:4178', 'http://127.0.0.1:4178');
  return list;
}
export function originAllowed(origin, env) {
  return !!origin && allowedOrigins(env).includes(origin);
}
export function corsHeaders(origin, env) {
  const h = {
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (originAllowed(origin, env)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

// ---------- app-layer token encryption (AES-256-GCM) ----------
// ENC_KEY is a base64-encoded 32-byte key. Output = base64(iv[12] || ciphertext||tag).
async function importKey(env) {
  const raw = base64ToBytes(env.ENC_KEY);
  if (raw.length !== 32) throw new Error('ENC_KEY must be 32 bytes (base64).');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
export async function encryptToken(env, plaintext) {
  const key = await importKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext))
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return bytesToBase64(out);
}
export async function decryptToken(env, b64) {
  const key = await importKey(env);
  const data = base64ToBytes(b64);
  if (data.length < 12 + 16) throw new Error('ciphertext too short'); // 12B IV + 16B GCM tag minimum
  const iv = data.slice(0, 12);
  const ct = data.slice(12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(pt);
}

// ---------- categorization (Plaid Personal Finance Category -> 50/30/20 bucket) ----------
// Buckets: 'needs' | 'wants' | 'savings' | 'income' | 'ignore'
// Uses Plaid's `detailed` category for the few cases where `primary` is ambiguous
// (groceries vs eating out; insurance vs other services; savings/investment transfers).
export function defaultBucket(primary, detailed) {
  const p = primary || '';
  const d = detailed || '';

  // Money moved into savings/investment/retirement = the "20".
  if (d === 'TRANSFER_OUT_SAVINGS' || d === 'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS') return 'savings';
  // Groceries are a need; restaurants/bars/coffee fall through to wants.
  if (d === 'FOOD_AND_DRINK_GROCERIES') return 'needs';
  // Insurance is a need; other general services fall through to wants.
  if (d === 'GENERAL_SERVICES_INSURANCE') return 'needs';

  if (p === 'INCOME') return 'income';
  if (['RENT_AND_UTILITIES', 'TRANSPORTATION', 'MEDICAL', 'LOAN_PAYMENTS'].includes(p)) return 'needs';
  if (['ENTERTAINMENT', 'FOOD_AND_DRINK', 'GENERAL_MERCHANDISE', 'PERSONAL_CARE', 'TRAVEL',
       'HOME_IMPROVEMENT', 'GOVERNMENT_AND_NON_PROFIT', 'GENERAL_SERVICES'].includes(p)) return 'wants';
  // Generic transfers and bank fees are not budget spending until the user rules them.
  if (['TRANSFER_IN', 'TRANSFER_OUT', 'BANK_FEES'].includes(p)) return 'ignore';

  return 'wants';
}

// Apply user rules first (rule wins), then fall back to the default map.
// `rules` = [{ match_type:'merchant'|'name_contains'|'pfc', match_value, bucket }]
export function categorize(rules, txn, primary, detailed) {
  const name = String((txn && (txn.merchant_name || txn.name)) || '').toLowerCase();
  for (const r of rules || []) {
    const v = String(r.match_value || '').toLowerCase();
    if (r.match_type === 'merchant' && name && name === v) return { bucket: r.bucket, source: 'rule' };
    if (r.match_type === 'name_contains' && v && name.includes(v)) return { bucket: r.bucket, source: 'rule' };
    if (r.match_type === 'pfc' && (primary === r.match_value || detailed === r.match_value)) {
      return { bucket: r.bucket, source: 'rule' };
    }
  }
  return { bucket: defaultBucket(primary, detailed), source: 'auto' };
}
