// Node test harness for the pure logic in src/lib.js.
// Runs without the Cloudflare Workers runtime (works on any Node 18+/22), so it
// verifies the security-critical bits even on a host where `wrangler dev` can't run.
//   run:  npm test     (from the worker/ directory)

import assert from 'node:assert/strict';
import {
  timingSafeEqual, authOK, originAllowed, corsHeaders,
  encryptToken, decryptToken, bytesToBase64, defaultBucket, categorize,
} from '../src/lib.js';

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
  console.log('  ✓ ' + name);
}

// ---- auth / constant-time compare ----
console.log('auth:');
ok('equal strings match', timingSafeEqual('abc123', 'abc123'));
ok('different strings reject', !timingSafeEqual('abc123', 'abc124'));
ok('different lengths reject', !timingSafeEqual('abc', 'abcd'));
ok('authOK accepts correct bearer', await authOK('Bearer s3cr3t', { APP_SECRET: 's3cr3t' }));
ok('authOK rejects wrong bearer', !(await authOK('Bearer nope', { APP_SECRET: 's3cr3t' })));
ok('authOK rejects right secret wrong length attempt', !(await authOK('Bearer s3cr3', { APP_SECRET: 's3cr3t' })));
ok('authOK fails closed when unconfigured', !(await authOK('Bearer anything', {})));
ok('authOK rejects missing header', !(await authOK(null, { APP_SECRET: 's3cr3t' })));

// ---- CORS ----
console.log('cors:');
const prodEnv = { PLAID_ENV: 'production', ALLOWED_ORIGIN: 'https://gchipllc-del.github.io' };
ok('allows configured origin', originAllowed('https://gchipllc-del.github.io', prodEnv));
ok('rejects other origin', !originAllowed('https://evil.example', prodEnv));
ok('rejects empty origin', !originAllowed('', prodEnv));
ok('localhost allowed only with ALLOW_LOCALHOST=1', originAllowed('http://localhost:4178', { ALLOW_LOCALHOST: '1', ALLOWED_ORIGIN: 'https://x' }));
ok('localhost NOT allowed without opt-in (even sandbox)', !originAllowed('http://localhost:4178', { PLAID_ENV: 'sandbox', ALLOWED_ORIGIN: 'https://x' }));
ok('localhost NOT allowed in production', !originAllowed('http://localhost:4178', prodEnv));
const ch = corsHeaders('https://gchipllc-del.github.io', prodEnv);
ok('cors echoes allowed origin', ch['Access-Control-Allow-Origin'] === 'https://gchipllc-del.github.io');
ok('cors omits header for disallowed origin', corsHeaders('https://evil.example', prodEnv)['Access-Control-Allow-Origin'] === undefined);

// ---- encryption round-trip + tamper detection ----
console.log('encryption:');
const key = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
const env = { ENC_KEY: key };
const secretToken = 'access-sandbox-1234567890-do-not-leak';
const ct1 = await encryptToken(env, secretToken);
const ct2 = await encryptToken(env, secretToken);
ok('ciphertext != plaintext', ct1 !== secretToken);
ok('ciphertext does not contain plaintext', !ct1.includes(secretToken));
ok('random IV => different ciphertexts', ct1 !== ct2);
ok('decrypt restores plaintext', (await decryptToken(env, ct1)) === secretToken);
let tampered = false;
try {
  const bad = ct1.slice(0, -4) + (ct1.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
  await decryptToken(env, bad);
} catch (e) { tampered = true; }
ok('GCM rejects tampered ciphertext', tampered);
let wrongKey = false;
try { await decryptToken({ ENC_KEY: bytesToBase64(crypto.getRandomValues(new Uint8Array(32))) }, ct1); }
catch (e) { wrongKey = true; }
ok('wrong key cannot decrypt', wrongKey);
let badKeyLen = false;
try { await encryptToken({ ENC_KEY: bytesToBase64(new Uint8Array(16)) }, 'x'); } catch (e) { badKeyLen = true; }
ok('rejects non-32-byte key', badKeyLen);

// ---- categorization ----
console.log('categorization:');
ok('rent -> needs', defaultBucket('RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_RENT') === 'needs');
ok('groceries -> needs', defaultBucket('FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES') === 'needs');
ok('restaurant -> wants', defaultBucket('FOOD_AND_DRINK', 'FOOD_AND_DRINK_RESTAURANT') === 'wants');
ok('insurance -> needs', defaultBucket('GENERAL_SERVICES', 'GENERAL_SERVICES_INSURANCE') === 'needs');
ok('childcare -> needs', defaultBucket('GENERAL_SERVICES', 'GENERAL_SERVICES_CHILDCARE') === 'needs');
ok('education -> needs', defaultBucket('GENERAL_SERVICES', 'GENERAL_SERVICES_EDUCATION') === 'needs');
ok('car repair -> needs', defaultBucket('GENERAL_SERVICES', 'GENERAL_SERVICES_AUTOMOTIVE') === 'needs');
ok('other general service -> wants', defaultBucket('GENERAL_SERVICES', 'GENERAL_SERVICES_OTHER_GENERAL_SERVICES') === 'wants');
ok('entertainment -> wants', defaultBucket('ENTERTAINMENT', 'ENTERTAINMENT_TV_AND_MOVIES') === 'wants');
ok('savings transfer -> savings', defaultBucket('TRANSFER_OUT', 'TRANSFER_OUT_SAVINGS') === 'savings');
ok('investment transfer -> savings', defaultBucket('TRANSFER_OUT', 'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS') === 'savings');
ok('income -> income', defaultBucket('INCOME', 'INCOME_WAGES') === 'income');
ok('generic transfer -> ignore', defaultBucket('TRANSFER_OUT', 'TRANSFER_OUT_OTHER_TRANSFER_OUT') === 'ignore');
ok('credit card payment -> ignore (transfer leg)', defaultBucket('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT') === 'ignore');
ok('car payment -> needs', defaultBucket('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CAR_PAYMENT') === 'needs');
ok('tax payment -> needs', defaultBucket('GOVERNMENT_AND_NON_PROFIT', 'GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT') === 'needs');
ok('donation -> wants', defaultBucket('GOVERNMENT_AND_NON_PROFIT', 'GOVERNMENT_AND_NON_PROFIT_DONATIONS') === 'wants');
ok('overdraft fee -> needs', defaultBucket('BANK_FEES', 'BANK_FEES_OVERDRAFT_FEES') === 'needs');
ok('cc interest -> needs', defaultBucket('BANK_FEES', 'BANK_FEES_INTEREST_CHARGE') === 'needs');
ok('unknown -> wants fallback', defaultBucket('SOMETHING_NEW', '') === 'wants');
ok('null -> wants fallback', defaultBucket(null, null) === 'wants');

// rules override the default map
const rules = [
  { match_type: 'name_contains', match_value: 'netflix', bucket: 'wants' },
  { match_type: 'merchant', match_value: 'Vanguard', bucket: 'savings' },
  { match_type: 'pfc', match_value: 'MEDICAL', bucket: 'needs' },
];
ok('rule name_contains wins', categorize(rules, { name: 'NETFLIX.COM' }, 'ENTERTAINMENT', null).source === 'rule');
ok('rule merchant exact wins', categorize(rules, { merchant_name: 'Vanguard' }, 'TRANSFER_OUT', 'TRANSFER_OUT_OTHER').bucket === 'savings');
ok('rule pfc wins', categorize(rules, { name: 'Dr Smith' }, 'MEDICAL', 'MEDICAL_PRIMARY_CARE').source === 'rule');
ok('no rule => auto', categorize(rules, { name: 'Random Store' }, 'GENERAL_MERCHANDISE', null).source === 'auto');

console.log(`\nALL PASSED — ${passed} assertions`);
