/* Acceptance tests for WALLET VERIFICATION (owner order 2026-11-14).
 *
 * Same harness as test_local.js (real RTDB emulator + Telegram stub),
 * plus a TON stub serving BOTH on-chain APIs the server reads:
 *   - tonapi.io v2   (TONAPI_BASE override)  — address parse + jetton
 *     hold, so the real `wallet` action can bind wallets end-to-end;
 *   - toncenter v3   (TON_API_BASE override) — account transactions,
 *     used for wallet age (ascending) and the deposit-payment scan.
 * TON_API_KEY is deliberately NOT set: the feature must work keyless.
 *
 *   V1  userNo assignment: sequential at creation (1, 2), stable
 *       across calls; a pre-feature player (seeded directly, no
 *       userNo) gets the next number lazily from verifyInfo.
 *   V2  verifyInfo with no wallet: full instruction shape, ageDays
 *       null, comment VIKING-<userNo>.
 *   V3  wallet binding through the real `wallet` action; verifyInfo
 *       reports the on-chain age (800d) + ageOk; the age is cached
 *       (second call does not re-hit the TON stub).
 *   V4  another account binding the same wallet while the first
 *       account's claim is UNVERIFIED -> provisional takeover (owner
 *       order 2026-11-18: an unverified binding proves nothing and
 *       blocks nobody); once the wallet is VERIFIED to the first
 *       account (V5), the same bind -> 400 'This wallet is linked to
 *       another account'.
 *   V5  verifyCheck happy path (API-decoded text_comment): player
 *       verified, verifyClaims/{hash} written, wallets-registry node
 *       flagged verified, state exposes the verified fields. The
 *       payment is served with a BASE64 tx hash (the toncenter v3
 *       form — see V17) and must be claimed/stored under its hex.
 *   V6  verifyCheck again for the same wallet -> verified (already).
 *   V7  scan rejections: wrong comment / wrong sender / amount below
 *       the fee / tx already claimed by another user -> all 404
 *       'Payment not found yet', player stays unverified.
 *   V8  comment carried as raw body hex (opcode + UTF-8, no decoded
 *       body) still verifies.
 *   V9  wallet younger than 7 days (owner order 2026-11-17: the
 *       age rule moved from verification to withdrawals): verifyInfo
 *       still reports the true age (1d) but ageOk is true, and
 *       verifyCheck verifies him from the perfect payment — age no
 *       longer gates verification anywhere.
 *   V10 adminState players carry walletVerified.
 *   V11 referral entry flag: the inviter's referral entry for the
 *       invitee flips verified=true on verification and back to
 *       false when the invitee unlinks (void).
 *   V12 binding a DIFFERENT wallet voids the verification.
 *   V13 unlink voids the verification.
 *   V14 REGRESSION: wallet age must come from the OLDEST transaction.
 *       toncenter v3 orders via `sort=`; the tonapi name `sort_order`
 *       is ignored (newest-first fallback) — the stub now mirrors that
 *       contract, and a wallet with a 1-day-old newest tx and an
 *       800-day-old oldest tx must age at ~800, via a recorded
 *       `sort=asc` query.
 *   V15 a wrong age cached by the buggy build (fresh, but unstamped
 *       walletAgeV) is recomputed once, re-stamped (walletAgeV=2) and
 *       only then served from cache again.
 *   V16 verifyInfo as a brand-new player's FIRST-EVER call: player
 *       creation + ensureUserNo run against never-synced nodes (the
 *       cold-process conditions behind the intermittent live
 *       'User not found'/'Server error') and must answer 200 with a
 *       stable, persisted userNo.
 *   V17 REGRESSION: toncenter v3 returns tx.hash in BASE64, not hex.
 *       The shipped hex-only format guard in verifyCheck skipped
 *       EVERY real transaction — the owner really paid and still got
 *       'Payment not found yet'. The server now canonicalises the
 *       hash to hex before the guard, the verifyClaims key and the
 *       stored verifyTx. This block replays the owner's EXACT live
 *       hash string end-to-end; V5's fixture hash is base64 carrying
 *       '+', '/' and a trailing '='.
 *   V18 pending intent (fix round 2026-11-14): verifyInfo with a
 *       bound, unverified wallet sets verifyPendingAt and reports
 *       verifyPending:true — the marker the background watcher scans.
 *   V19 the watcher with NOBODY pending makes ZERO chain calls: a
 *       second server instance runs with VERIFY_WATCH_MS=250 (the
 *       env override is the test mechanism for the watcher; the main
 *       instance runs with VERIFY_WATCH_MS=0 so V1–V17 stay free of
 *       watcher races) and the TON stub counts deposit-wallet scans.
 *   V20 the watcher completes a pending player from a stubbed
 *       deposit tx with the app "closed" (NO verifyCheck call):
 *       verified, hash claimed, pending cleared, and the success
 *       messages fire exactly once (user photo DM + admin alert,
 *       both captured by the TG stub); later ticks resend nothing.
 *   V21 verifyCheck completing first -> the watcher does not resend
 *       (messages exactly once, from whichever path won).
 *   V22 loser path: verifyCheck on an already-verified player is a
 *       pure no-op — no messages.
 *   V23 pending is cleared on unlink and on binding a different
 *       wallet.
 *   V24 once per payment (owner order 2026-11-14, the MANSAWY
 *       duplicate): the watcher completes a player (one user DM +
 *       one admin alert, claim gains notifiedAt); the verification
 *       is then voided by binding a different wallet, the original
 *       wallet is rebound, pending re-arms, and the watcher
 *       re-completes from the SAME payment — the player IS verified
 *       again (verifiedAt advances) but NO second DM/alert fires
 *       and notifiedAt is untouched.
 *   V25 stranded claim: a claim pre-written for the player with NO
 *       notifiedAt and no completed flip (an earlier completion
 *       died mid-flight) still sends its messages on the eventual
 *       win — that win is the payment's first notification.
 *   V26 registry permanence belongs to VERIFIED claims (owner
 *       orders 2026-11-15 + 2026-11-18): a VERIFIED claim is
 *       permanent — unlink/switch never free it and no other account
 *       can take it. An UNVERIFIED claim is provisional: the node is
 *       kept on unlink/switch, but another account binding the
 *       address takes the claim over (binding alone proves nothing).
 *
 * Run:  node test_local5.js    (ports: app 18090, watcher app 18095, TG stub 18091, TON stub 18093, emu 9000)
 */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'NODE_USE_ENV_PROXY']) delete process.env[k];

const BOT_TOKEN = '424242:AAFakeDummyTokenForLocalTestsOnly';
const OWNER_ID = '700000001';
const EMU_PORT = 9000;
const APP_PORT = 18090;
const WATCH_PORT = 18095;
const TG_PORT = 18091;
const TON_PORT = 18093;
const NS = 'demo-viking-default-rtdb';
const EMU = `127.0.0.1:${EMU_PORT}`;
const DEPOSIT_UQ = 'UQBCoy7KjhL9VnKA_YOp4_hxmYKAQ8P8mIfx5FdIdSA6qvxE';

function cleanEnv(extra) {
  const env = { ...process.env };
  for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'NODE_USE_ENV_PROXY']) delete env[k];
  return { ...env, ...extra };
}
function toRawAddress(addr) {
  const s = String(addr || '').trim();
  const m = /^(-?\d+):([0-9a-fA-F]{64})$/.exec(s);
  if (m) return m[1] + ':' + m[2].toLowerCase();
  const b = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (b.length === 36) return b.readInt8(1) + ':' + b.subarray(2, 34).toString('hex');
  return s.toLowerCase();
}
const DEPOSIT_RAW = toRawAddress(DEPOSIT_UQ);

/* ---------- signed Telegram initData (same scheme as verifyInitData) ---------- */
function makeInitData(user, opts = {}) {
  const params = new URLSearchParams();
  params.set('user', JSON.stringify(user));
  params.set('auth_date', String(opts.authDate ?? Math.floor(Date.now() / 1000)));
  params.set('query_id', 'AAEtestquery');
  if (opts.startParam) params.set('start_param', opts.startParam);
  const dcs = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return params.toString();
}

/* ---------- Telegram stub (minimal: getMe + capture) ---------- */
const sentMessages = [];
const sentPhotos = [];
const tgStub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch (e) { /* ignore */ }
    const m = /\/bot[^/]+\/(\w+)$/.exec(req.url || '');
    const method = m ? m[1] : '';
    res.setHeader('Content-Type', 'application/json');
    if (method === 'getMe') return res.end(JSON.stringify({ ok: true, result: { id: 424242, is_bot: true, first_name: 'Test Viking', username: 'TestVikingBot' } }));
    if (method === 'sendMessage') sentMessages.push(body);
    if (method === 'sendPhoto') sentPhotos.push(body);
    return res.end(JSON.stringify({ ok: true, result: { message_id: sentMessages.length + sentPhotos.length } }));
  });
});

/* ---------- TON stub: tonapi v2 + toncenter v3 shapes ---------- */
let depositTxs = [];                 // scripted transactions OF the deposit wallet (desc)
let depositHits = 0;                 // /v3/transactions queries served FOR the deposit wallet (watcher scans + verifyCheck scans)
const walletFirstTx = {};            // rawAddr -> unix seconds of its first transaction
const walletTxs = {};                // rawAddr -> full tx list (stored newest-first) for multi-tx wallets
const ageHits = {};                  // rawAddr -> number of ascending age queries served
const ageQueryLog = {};              // rawAddr -> raw query string of the last /v3/transactions request for it
const tonStub = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('Content-Type', 'application/json');
  // tonapi: address parse — echo back the raw form (tests bind raw-form addresses)
  let m = /^\/tonapi\/address\/(.+)\/parse$/.exec(u.pathname);
  if (m) return res.end(JSON.stringify({ raw_form: toRawAddress(decodeURIComponent(m[1])) }));
  // tonapi: jetton hold — nobody holds anything in these tests
  if (/^\/tonapi\/accounts\/.+\/jettons\//.test(u.pathname)) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'not found' })); }
  // tonapi v2: deposit-wallet transactions with REAL before_lt paging,
  // in the shape the live tonapi serves (hex hash, utime, source as an
  // object, comment at decoded_body.text). Serves the same depositTxs
  // fixtures as the v3 route below, converted — the deposit-cursor
  // processor walks THIS endpoint (added 2026-11-16 with the cursor
  // root fix; the v3 route remains for verifyCheck's fallback scan).
  let tm = /^\/tonapi\/blockchain\/accounts\/(.+)\/transactions$/.exec(u.pathname);
  if (tm) {
    const account = toRawAddress(decodeURIComponent(tm[1]));
    if (account !== DEPOSIT_RAW) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'not found' })); }
    const limit = Number(u.searchParams.get('limit') || 100);
    const beforeLt = u.searchParams.get('before_lt');
    let list = depositTxs.slice();
    if (beforeLt !== null) list = list.filter((t) => Number(t.lt) < Number(beforeLt));
    const page = list.slice(0, limit).map((t) => {
      const mc = (t.in_msg && t.in_msg.message_content) || {};
      let comment = (mc.decoded && mc.decoded.comment) || '';
      if (!comment && typeof mc.body === 'string' && /^(?:[0-9a-fA-F]{2})+$/.test(mc.body)) {
        const buf = Buffer.from(mc.body, 'hex');
        if (buf.length > 4 && buf.readUInt32BE(0) === 0) comment = buf.subarray(4).toString('utf8');
      }
      const hashHex = /^[0-9a-fA-F]{64}$/.test(t.hash) ? t.hash : Buffer.from(t.hash, 'base64').toString('hex');
      return { hash: hashHex, lt: t.lt, utime: t.now, in_msg: { source: { address: t.in_msg.source }, destination: { address: DEPOSIT_RAW }, value: t.in_msg.value, decoded_body: comment ? { text: comment } : undefined } };
    });
    return res.end(JSON.stringify({ transactions: page }));
  }
  // toncenter v3: account transactions. Mirrors the REAL toncenter
  // contract: ordering is `sort=asc|desc` (default desc); the tonapi
  // parameter name `sort_order` is IGNORED, so a caller passing it
  // silently gets newest-first for every query (the shipped bug —
  // regression-covered by V14 below). ALSO mirrors the real hash
  // form: tx.hash is BASE64 (44 chars, may contain '+', '/' and a
  // trailing '='), never hex — scripted deposit transactions are
  // served via b64hex() below (regression-covered by V5/V17).
  if (u.pathname === '/v3/transactions') {
    const account = toRawAddress(u.searchParams.get('account') || '');
    const limit = Number(u.searchParams.get('limit') || 10);
    const sort = u.searchParams.get('sort') === 'asc' ? 'asc' : 'desc';
    ageQueryLog[account] = u.search;
    let list;
    if (account === DEPOSIT_RAW) { depositHits++; list = depositTxs.slice(); }
    else if (Array.isArray(walletTxs[account])) list = walletTxs[account].slice();
    else if (walletFirstTx[account]) list = [{ hash: Buffer.from('f1'.repeat(32), 'hex').toString('base64'), lt: '1', now: walletFirstTx[account], in_msg: { source: '', value: '0' } }];
    else list = [];
    if (sort === 'asc') { ageHits[account] = (ageHits[account] || 0) + 1; list.reverse(); } // stored newest-first; ascending serves oldest first
    return res.end(JSON.stringify({ transactions: list.slice(0, limit), address_book: {} }));
  }
  res.statusCode = 404;
  return res.end(JSON.stringify({ error: 'stub: unknown path ' + u.pathname }));
});

/* ---------- tiny assertion kit + http helpers ---------- */
let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS', name); }
  else { failed++; console.log('  FAIL', name, extra !== undefined ? '-> ' + JSON.stringify(extra) : ''); }
}
async function api(initData, action, body = {}) {
  const r = await fetch(`http://127.0.0.1:${APP_PORT}/`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData, action, ...body })
  });
  let j = null;
  try { j = await r.json(); } catch (e) { /* ignore */ }
  return { status: r.status, body: j };
}
async function dbGet(p) {
  const r = await fetch(`http://${EMU}/${p}.json?ns=${NS}`);
  return r.json();
}
async function dbPut(p, v) {
  await fetch(`http://${EMU}/${p}.json?ns=${NS}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v) });
}
async function dbPatch(p, v) {
  await fetch(`http://${EMU}/${p}.json?ns=${NS}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v) });
}
async function dbWipe() {
  for (const p of ['players', 'withdrawals', 'settings', 'meta', 'sigs', 'wallets', 'deviceIds', 'devices', 'premiumEmoji', 'verifyClaims', 'verifyUnresolved']) {
    await fetch(`http://${EMU}/${p}.json?ns=${NS}`, { method: 'DELETE' });
  }
}
function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try { if (await fn()) return resolve(); } catch (e) { /* retry */ }
      if (Date.now() - t0 > timeoutMs) return reject(new Error('timeout waiting for ' + label));
      setTimeout(tick, 400);
    };
    tick();
  });
}

const U = (id, first_name, username) => ({ id, first_name, username });
const A = U(700003001, 'Verify Ann', 'verifyann');
const B = U(700003002, 'Verify Bob', 'verifybob');
const LEGACY = U(700003003, 'Legacy Leo', 'legacyleo');
const C = U(700003004, 'Young Cy', 'youngcy');
const D = U(700003005, 'Copy Dan', 'copydan');
const INV = U(700003006, 'Inviter Ivy', 'inviterivy');
const V = U(700003007, 'Invitee Vic', 'inviteevic');
const E = U(700003008, 'Reg Eve', 'regeve');
const F = U(700003009, 'Cold Fred', 'coldfred');
const G = U(700003010, 'Real Ruth', 'realruth');
const H = U(700003011, 'Watch Walt', 'watchwalt');
const RACE = U(700003012, 'Race Rita', 'racerita');
const J = U(700003013, 'Unlink Uma', 'unlinkuma');
const K = U(700003014, 'Change Chad', 'changechad');
const L = U(700003015, 'Once Olga', 'onceolga');
const M = U(700003016, 'Strand Stan', 'strandstan');
const P1 = U(700003017, 'Perm Pete', 'permpete');
const P2 = U(700003018, 'Second Sara', 'secondsara');
const OWNER = U(700000001, 'Boss Man', 'bossman');
const WA = '0:' + 'aa'.repeat(32);
const WA2 = '0:' + 'ab'.repeat(32);
const WB = '0:' + 'bb'.repeat(32);
const WC = '0:' + 'cc'.repeat(32);
const WV = '0:' + 'dd'.repeat(32);
const WOTHER = '0:' + 'ee'.repeat(32);
const WE = '0:' + 'ff'.repeat(32);
const WG = '0:' + '99'.repeat(32);
const WH = '0:' + '12'.repeat(32);
const WI = '0:' + '34'.repeat(32);
const WJ = '0:' + '56'.repeat(32);
const WK1 = '0:' + '78'.repeat(32);
const WK2 = '0:' + '9a'.repeat(32);
const WL = '0:' + '23'.repeat(32);
const WL2 = '0:' + '45'.repeat(32);
const WM = '0:' + '67'.repeat(32);
const WP1 = '0:' + '89'.repeat(32);
const WP2 = '0:' + 'bc'.repeat(32);
const nowSec = () => Math.floor(Date.now() / 1000);
/* toncenter v3 serves tx.hash as base64 of the 32 hash bytes — script
 * deposit payments in that form; the canonical hex is what the server
 * must claim under verifyClaims/ and store as verifyTx. */
const b64hex = (hex) => Buffer.from(hex, 'hex').toString('base64');
const depTx = (hash, source, value, msgContent) => ({
  hash, lt: '1000', now: nowSec(),
  in_msg: { source, destination: DEPOSIT_RAW, value: String(value), message_content: msgContent }
});
const decodedComment = (text) => ({ decoded: { type: 'text_comment', comment: text } });
const hexComment = (text) => ({ body: Buffer.concat([Buffer.alloc(4), Buffer.from(text, 'utf8')]).toString('hex') });
const FEE_NANO = '50000000';

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viking-test5-'));
  const children = [];
  try {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const saPath = path.join(tmp, 'fake-sa.json');
    fs.writeFileSync(saPath, JSON.stringify({
      type: 'service_account', project_id: 'demo-viking', private_key_id: 'fake',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      client_email: 'fake@demo-viking.iam.gserviceaccount.com', client_id: '1',
      token_uri: 'https://oauth2.googleapis.com/token'
    }));

    const emuUp = await fetch(`http://${EMU}/.json?ns=${NS}`).then(() => true).catch(() => false);
    if (!emuUp) throw new Error('RTDB emulator is not listening on 127.0.0.1:9000 — start it first (the other suites spawn it via firebase-tools)');
    await dbWipe();

    await new Promise((r) => tgStub.listen(TG_PORT, '127.0.0.1', r));
    await new Promise((r) => tonStub.listen(TON_PORT, '127.0.0.1', r));

    const srv = spawn(path.join(__dirname, 'node_modules', '.bin', 'functions-framework'),
      ['--target=collectMining', '--port=' + APP_PORT], {
        cwd: __dirname,
        env: cleanEnv({
          BOT_TOKEN, OWNER_ID, ALLOWED_ORIGIN: '*',
          FIREBASE_DATABASE_URL: `http://${EMU}?ns=${NS}`,
          FIREBASE_DATABASE_EMULATOR_HOST: EMU,
          GOOGLE_APPLICATION_CREDENTIALS: saPath,
          TG_API_BASE: `http://127.0.0.1:${TG_PORT}`,
          TON_API_BASE: `http://127.0.0.1:${TON_PORT}/v3`,
          TONAPI_BASE: `http://127.0.0.1:${TON_PORT}/tonapi`,
          TONAPI_PAGE_GAP_MS: '0',
          VERIFY_WATCH_MS: '0' // watcher OFF on the main instance: V1–V17 must not race it (the watcher gets its own instance in V19+)
          // TON_API_KEY intentionally unset — keyless operation must work
        }),
        stdio: 'ignore'
      });
    children.push(srv);
    await waitFor(async () => (await fetch(`http://127.0.0.1:${APP_PORT}/`)).status === 405, 30000, 'server');

    const idA = makeInitData(A), idB = makeInitData(B), idC = makeInitData(C),
      idD = makeInitData(D), idI = makeInitData(INV), idO = makeInitData(OWNER),
      idE = makeInitData(E);
    const idH = makeInitData(H), idR = makeInitData(RACE), idJ = makeInitData(J), idK = makeInitData(K);
    let hNo = 0, rNo = 0;
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const photosTo = (id) => sentPhotos.filter((m) => String(m.chat_id) === String(id));
    const msgsTo = (id) => sentMessages.filter((m) => String(m.chat_id) === String(id));

    /* ---------------- V1: userNo assignment ---------------- */
    console.log('\n[V1: userNo — sequential at creation, stable, lazy for legacy players]');
    {
      let r = await api(idA, 'state');
      check('first created player gets userNo 1', r.status === 200 && r.body.player.userNo === 1, r.body.player && r.body.player.userNo);
      r = await api(idA, 'state');
      check('userNo is stable across calls', r.status === 200 && r.body.player.userNo === 1, r.body.player && r.body.player.userNo);
      r = await api(idB, 'state');
      check('second created player gets userNo 2', r.status === 200 && r.body.player.userNo === 2, r.body.player && r.body.player.userNo);
      // a pre-feature player: seeded directly, no userNo field at all
      await dbPut('players/700003003', { id: '700003003', name: 'Legacy Leo', username: 'legacyleo', mined: 0, referrals: [], walletAddr: '' });
      r = await api(makeInitData(LEGACY), 'verifyInfo');
      check('legacy player gets the next number lazily (3)', r.status === 200 && r.body.userNo === 3, r.body);
      const lp = await dbGet('players/700003003');
      check('the lazy number is persisted on the player', !!lp && lp.userNo === 3, lp && lp.userNo);
      r = await api(makeInitData(LEGACY), 'verifyInfo');
      check('the lazy number never changes afterwards', r.status === 200 && r.body.userNo === 3, r.body.userNo);
    }

    /* ---------------- V2: verifyInfo shape, no wallet ---------------- */
    console.log('\n[V2: verifyInfo with no wallet bound]');
    {
      const r = await api(idA, 'verifyInfo');
      check('answers 200', r.status === 200, r);
      check('userNo 1 + comment VIKING-1', r.body.userNo === 1 && r.body.comment === 'VIKING-1', r.body);
      check('deposit wallet is the configured UQ address', r.body.depositWallet === DEPOSIT_UQ, r.body.depositWallet);
      check('fee is 0.05 TON, min age 7', r.body.feeTon === 0.05 && r.body.minAgeDays === 7, r.body);
      check('no wallet -> wallet empty, ageDays null, ageOk true (never age-gated since 2026-11-17), not verified',
        r.body.wallet === '' && r.body.ageDays === null && r.body.ageOk === true && r.body.verified === false, r.body);
    }

    /* ---------------- V3: bind + age + cache ---------------- */
    console.log('\n[V3: wallet binding via the real wallet action; age from chain; age cached]');
    {
      walletFirstTx[WA] = nowSec() - 800 * 86400;
      let r = await api(idA, 'wallet', { address: WA });
      check('wallet action binds WA', r.status === 200 && r.body.success === true, r);
      r = await api(idA, 'verifyInfo');
      check('verifyInfo shows the bound wallet', r.status === 200 && r.body.wallet === WA, r.body);
      check('age is ~800 days and ageOk', r.body.ageDays >= 799 && r.body.ageDays <= 801 && r.body.ageOk === true, r.body.ageDays);
      const hits = ageHits[WA] || 0;
      r = await api(idA, 'verifyInfo');
      check('second verifyInfo serves the cached age (no new TON query)', (ageHits[WA] || 0) === hits && r.body.ageDays >= 799, { hits: ageHits[WA], before: hits });
      r = await api(idA, 'state');
      check('state shows the player not verified yet', r.body.player.walletVerified === false && r.body.player.userNo === 1, r.body.player);
    }

    /* ---------------- V4: unverified claim blocks nobody ---------------- */
    console.log('\n[V4: another account binding the same wallet while the claim is UNVERIFIED -> provisional takeover]');
    {
      let r = await api(idD, 'wallet', { address: WA });
      check('D binds WA while A\'s claim is unverified (provisional takeover)', r.status === 200 && r.body.success === true, r);
      let wdoc = await dbGet('wallets/' + WA.replace(':', '_'));
      check('registry node flipped to D, still unverified', !!wdoc && String(wdoc.userId) === '700003005' && wdoc.verified !== true, wdoc);
      r = await api(idA, 'wallet', { address: WA });
      check('A re-binds WA (same address on A\'s record — claim returns)', r.status === 200 && r.body.success === true, r);
      wdoc = await dbGet('wallets/' + WA.replace(':', '_'));
      check('registry node back to A', !!wdoc && String(wdoc.userId) === '700003001', wdoc);
    }

    /* ---------------- V5: verifyCheck happy path (decoded comment) ---------------- */
    console.log('\n[V5: verifyCheck confirms the on-chain payment (decoded text_comment, base64 hash)]');
    const HASH1 = 'fbefff' + '23'.repeat(29); // canonical hex of A's payment
    const HASH1_B64 = b64hex(HASH1);          // the form toncenter v3 actually serves
    {
      check('fixture: the served hash is base64 carrying +, / and a trailing =',
        HASH1_B64.includes('+') && HASH1_B64.includes('/') && HASH1_B64.endsWith('='), HASH1_B64);
      depositTxs = [depTx(HASH1_B64, WA, FEE_NANO, decodedComment('VIKING-1'))];
      const r = await api(idA, 'verifyCheck');
      check('verified, and the tx is reported in canonical hex', r.status === 200 && r.body.verified === true && r.body.tx === HASH1, r);
      const p = await dbGet('players/700003001');
      check('player marked verified for WA with tx + timestamp',
        !!p && p.walletVerified === true && p.verifiedWallet === WA && p.verifyTx === HASH1 && Number(p.verifiedAt) > 0,
        p && { v: p.walletVerified, w: p.verifiedWallet, tx: p.verifyTx });
      const claim = await dbGet('verifyClaims/' + HASH1);
      check('verifyClaims/{hash} records the claim', !!claim && String(claim.userId) === '700003001', claim);
      const wdoc = await dbGet('wallets/' + WA.replace(':', '_'));
      check('wallets-registry node flagged verified (owner kept)', !!wdoc && wdoc.verified === true && String(wdoc.userId) === '700003001', wdoc);
      const rD = await api(idD, 'wallet', { address: WA });
      check('now that WA is VERIFIED to A, D binding it -> 400 linked to another account', rD.status === 400 && /linked to another account/.test(rD.body.error || ''), rD);
      const s = await api(idA, 'state');
      check('state exposes walletVerified + verifiedWallet', s.body.player.walletVerified === true && s.body.player.verifiedWallet === WA, s.body.player);
    }

    /* ---------------- V6: already verified ---------------- */
    console.log('\n[V6: verifyCheck again -> already verified]');
    {
      const r = await api(idA, 'verifyCheck');
      check('verified:true (already)', r.status === 200 && r.body.verified === true && r.body.already === true, r);
    }

    /* ---------------- V7: scan rejections ---------------- */
    console.log('\n[V7: wrong comment / wrong sender / small amount / claimed tx -> 404]');
    {
      walletFirstTx[WB] = nowSec() - 900 * 86400;
      let r = await api(idB, 'wallet', { address: WB });
      check('B binds WB', r.status === 200 && r.body.success === true, r);
      r = await api(idB, 'verifyInfo');
      check('B has userNo 2, comment VIKING-2, ageOk', r.body.userNo === 2 && r.body.comment === 'VIKING-2' && r.body.ageOk === true, r.body);
      depositTxs = [depTx(b64hex('b1'.repeat(32)), WB, FEE_NANO, decodedComment('VIKING-999'))];
      r = await api(idB, 'verifyCheck');
      check('wrong comment -> 404 Payment not found yet', r.status === 404 && /Payment not found yet/.test(r.body.error || ''), r);
      depositTxs = [depTx(b64hex('b2'.repeat(32)), WOTHER, FEE_NANO, decodedComment('VIKING-2'))];
      r = await api(idB, 'verifyCheck');
      check('right comment from a DIFFERENT wallet -> 404', r.status === 404 && /Payment not found yet/.test(r.body.error || ''), r);
      depositTxs = [depTx(b64hex('b3'.repeat(32)), WB, '40000000', decodedComment('VIKING-2'))];
      r = await api(idB, 'verifyCheck');
      check('amount below the fee (0.04 TON) -> 404', r.status === 404 && /Payment not found yet/.test(r.body.error || ''), r);
      const CLAIMED = 'b4'.repeat(32); // claims live under the canonical HEX key
      await dbPut('verifyClaims/' + CLAIMED, { userId: '799999999', at: Date.now() });
      depositTxs = [depTx(b64hex(CLAIMED), WB, FEE_NANO, decodedComment('VIKING-2'))];
      r = await api(idB, 'verifyCheck');
      check('tx already claimed by another user -> 404', r.status === 404 && /Payment not found yet/.test(r.body.error || ''), r);
      const p = await dbGet('players/700003002');
      check('B is still unverified after all rejections', !!p && p.walletVerified !== true, p && p.walletVerified);
    }

    /* ---------------- V8: raw hex body comment ---------------- */
    console.log('\n[V8: comment as raw body hex (no decoded body) verifies; tx hash served as HEX]');
    {
      // served with a literal hex hash: the canonicaliser must pass it
      // through unchanged (hex stays an accepted form alongside base64)
      depositTxs = [depTx('b5'.repeat(32), WB, FEE_NANO, hexComment('VIKING-2'))];
      const r = await api(idB, 'verifyCheck');
      check('verified via the hex-parsed comment', r.status === 200 && r.body.verified === true && r.body.tx === 'b5'.repeat(32), r);
      const s = await api(idB, 'state');
      check('state shows B verified', s.body.player.walletVerified === true && s.body.player.verifiedWallet === WB, s.body.player);
      const p = await dbGet('players/700003002');
      check('the hex-served hash is stored verbatim as verifyTx', !!p && p.verifyTx === 'b5'.repeat(32), p && p.verifyTx);
      const claim = await dbGet('verifyClaims/' + 'b5'.repeat(32));
      check('verifyClaims/<hex> written for the hex-served tx', !!claim && String(claim.userId) === '700003002', claim);
    }

    /* ---------------- V9: wallet younger than 7 days ----------------
       Owner order 2026-11-17: the wallet-age rule MOVED from
       verification to withdrawals. A 1-day-old wallet now verifies
       like any other — verifyInfo still reports the true age but
       ageOk is unconditionally true, and verifyCheck completes from
       the perfect payment (claim written, player verified). */
    console.log('\n[V9: wallet age < 7 days no longer blocks verification (age gates withdrawals now)]');
    {
      let r = await api(idC, 'state');
      const cNo = r.body.player.userNo;
      walletFirstTx[WC] = nowSec() - 90000; // ~25 hours ago -> age 1 day
      r = await api(idC, 'wallet', { address: WC });
      check('C binds the young wallet', r.status === 200 && r.body.success === true, r);
      r = await api(idC, 'verifyInfo');
      check('age is 1 day but ageOk is true (verification is not age-gated)', r.body.ageDays === 1 && r.body.ageOk === true, r.body);
      depositTxs = [depTx(b64hex('c1'.repeat(32)), WC, FEE_NANO, decodedComment('VIKING-' + cNo))];
      r = await api(idC, 'verifyCheck');
      check('verifyCheck VERIFIES the young wallet from its perfect payment',
        r.status === 200 && r.body.verified === true && r.body.tx === 'c1'.repeat(32), r);
      const p = await dbGet('players/700003004');
      check('C is verified for the young wallet',
        !!p && p.walletVerified === true && p.verifiedWallet === WC, p && p.walletVerified);
      const claim = await dbGet('verifyClaims/' + 'c1'.repeat(32));
      check('the payment WAS claimed for C', !!claim && String(claim.userId) === '700003004', claim);
    }

    /* ---------------- V10: adminState carries walletVerified ---------------- */
    console.log('\n[V10: adminState players carry walletVerified]');
    {
      const r = await api(idO, 'adminState');
      check('answers 200', r.status === 200, r);
      const byIdMap = new Map((r.body.players || []).map((p) => [String(p.id), p]));
      check('A and B verified in the admin list',
        !!byIdMap.get('700003001') && byIdMap.get('700003001').walletVerified === true &&
        !!byIdMap.get('700003002') && byIdMap.get('700003002').walletVerified === true,
        [...byIdMap.keys()]);
      check('C IS verified in the admin list (young wallet — verified since the 2026-11-17 rule move)', !!byIdMap.get('700003004') && byIdMap.get('700003004').walletVerified === true, byIdMap.get('700003004') && byIdMap.get('700003004').walletVerified);
    }

    /* ---------------- V11: referral entry verified flag ---------------- */
    console.log('\n[V11: inviter referral entry tracks the invitee verification]');
    {
      await api(idI, 'state');
      const idV = makeInitData(V, { startParam: 'ref_700003006' });
      await api(idV, 'state');
      let r = await api(idI, 'state');
      let entry = (r.body.player.referrals || []).find((x) => String(x.id) === '700003007');
      check('referral entry exists, verified flag false', !!entry && entry.verified === false, entry);
      walletFirstTx[WV] = nowSec() - 1000 * 86400;
      r = await api(idV, 'wallet', { address: WV });
      check('V binds WV', r.status === 200 && r.body.success === true, r);
      r = await api(idV, 'verifyInfo');
      const vComment = r.body.comment;
      depositTxs = [depTx(b64hex('d1'.repeat(32)), WV, FEE_NANO, decodedComment(vComment))];
      r = await api(idV, 'verifyCheck');
      check('V verifies', r.status === 200 && r.body.verified === true, r);
      r = await api(idI, 'state');
      entry = (r.body.player.referrals || []).find((x) => String(x.id) === '700003007');
      check('inviter entry flips to verified=true', !!entry && entry.verified === true, entry);
      await dbPatch('players/700003007', { lastSyncAt: 0 }); // bypass the wallet() 8s sync cooldown path for unlink (unlink has none, kept for symmetry)
      r = await api(idV, 'unlink');
      check('V unlinks', r.status === 200 && r.body.success === true, r);
      r = await api(idI, 'state');
      entry = (r.body.player.referrals || []).find((x) => String(x.id) === '700003007');
      check('after the void, inviter entry flips back to verified=false', !!entry && entry.verified === false, entry);
    }

    /* ---------------- V12: wallet change voids ---------------- */
    console.log('\n[V12: binding a different wallet voids the verification]');
    {
      await dbPatch('players/700003001', { lastSyncAt: 0 }); // wallet() sync cooldown
      let r = await api(idA, 'wallet', { address: WA2 });
      check('A rebinds to WA2', r.status === 200 && r.body.success === true, r);
      r = await api(idA, 'state');
      check('verification voided: walletVerified false, verifiedWallet cleared, wallet is WA2',
        r.body.player.walletVerified === false && r.body.player.verifiedWallet === '' && r.body.player.walletAddr === WA2,
        r.body.player);
    }

    /* ---------------- V13: unlink voids ---------------- */
    console.log('\n[V13: unlink voids the verification]');
    {
      const r = await api(idB, 'unlink');
      check('B unlinks', r.status === 200 && r.body.success === true, r);
      const s = await api(idB, 'state');
      check('B verification voided with the binding',
        s.body.player.walletVerified === false && s.body.player.verifiedWallet === '' && s.body.player.walletAddr === '',
        s.body.player);
    }

    /* ---------------- V14: REGRESSION — age from the OLDEST tx ----------------
       The shipped build asked toncenter for ascending order with the
       tonapi parameter name (sort_order), which toncenter ignores: the
       "age" query returned the NEWEST transaction and a 793-day-old
       wallet showed as 1 day. The stub now mirrors the real contract
       (honours sort=, ignores sort_order), so a wallet whose newest tx
       is 1 day old but whose oldest is 800 days old MUST age at 800. */
    console.log('\n[V14: regression — wallet age comes from the oldest transaction (toncenter sort=)]');
    {
      walletTxs[WE] = [
        { hash: b64hex('e2'.repeat(32)), lt: '2', now: nowSec() - 86400, in_msg: { source: '', value: '0' } },       // newest: 1 day ago
        { hash: b64hex('e1'.repeat(32)), lt: '1', now: nowSec() - 800 * 86400, in_msg: { source: '', value: '0' } }  // oldest: 800 days ago
      ];
      let r = await api(idE, 'wallet', { address: WE });
      check('E binds WE', r.status === 200 && r.body.success === true, r);
      r = await api(idE, 'verifyInfo');
      check('age is ~800 days (oldest tx), not 1 (newest tx)', r.body.ageDays >= 799 && r.body.ageDays <= 801 && r.body.ageOk === true, r.body.ageDays);
      const q = ageQueryLog[WE] || '';
      check('the age query used toncenter sort=asc', q.includes('sort=asc'), q);
      check('the age query did NOT pass sort_order', !q.includes('sort_order'), q);
    }

    /* ---------------- V15: pre-fix age cache invalidated once ----------------
       Players verified under the buggy build carry a fresh but WRONG
       cached age with no walletAgeV stamp. It must be recomputed once
       (not served for 3h), then re-stamped and served from cache. */
    console.log('\n[V15: a stale age cache written by the buggy build (no walletAgeV) is recomputed once]');
    {
      await dbPatch('players/700003008', { walletAgeDays: 1, walletAgeAt: Date.now(), walletAgeFor: WE, walletAgeV: null });
      let r = await api(idE, 'verifyInfo');
      check('the stale wrong age (1d) is NOT served — recomputed to ~800', r.body.ageDays >= 799 && r.body.ageDays <= 801, r.body.ageDays);
      const p = await dbGet('players/700003008');
      check('the recomputed cache is stamped walletAgeV=2 with the true age',
        !!p && p.walletAgeV === 2 && p.walletAgeDays >= 799, p && { v: p.walletAgeV, d: p.walletAgeDays });
      const hits = ageHits[WE] || 0;
      r = await api(idE, 'verifyInfo');
      check('the re-stamped cache is then served without a new chain query',
        (ageHits[WE] || 0) === hits && r.body.ageDays >= 799, { hits: ageHits[WE], before: hits });
    }

    /* ---------------- V16: ensureUserNo on a cold process ----------------
       A brand-new player whose FIRST-EVER call is verifyInfo: the
       player node does not exist and no earlier call in this block has
       touched this user, so ensurePlayer's create and ensureUserNo's
       counter + player writes all run against nodes the (already
       warm) server has never synced for this user — the closest the
       harness gets to the cold-process unseen-node conditions behind
       the intermittent live 404/500s. It must answer 200 with a real
       number, never the last-resort 500. */
    console.log('\n[V16: verifyInfo as a brand-new player\'s first-ever call (cold nodes)]');
    {
      const idF = makeInitData(F);
      let r = await api(idF, 'verifyInfo');
      check('answers 200 (no spurious User not found / Server error)', r.status === 200, r);
      check('a positive userNo was assigned via the unseen-counters path',
        Number(r.body.userNo) > 0 && r.body.comment === 'VIKING-' + r.body.userNo, r.body);
      const p = await dbGet('players/700003009');
      check('the player was created and the number persisted',
        !!p && Number(p.userNo) === Number(r.body.userNo), p && p.userNo);
      r = await api(idF, 'verifyInfo');
      check('the number is stable on the next call', r.status === 200 && Number(r.body.userNo) === Number(p.userNo), r.body.userNo);
    }

    /* ---------------- V17: REGRESSION — the owner's real base64 hash ----------------
       Live incident 2026-11-14: the owner really paid the 0.05 TON fee
       (comment VIKING-1, from his bound wallet) and verifyCheck still
       answered 'Payment not found yet'. toncenter v3 had returned the
       transaction with hash "LV5AoZEPNXniK16RaB91w9vTyo0gLa62XD9/OAvCNXo="
       — BASE64 — and the shipped guard /^[0-9a-fA-F]{16,128}$/ skipped
       it, like every real transaction. This block replays that EXACT
       hash string end-to-end for a fresh user: it must verify, claim
       under the canonical hex (a base64 '/' could never be an RTDB
       key) and store the hex as verifyTx. */
    console.log('\n[V17: regression — the owner\'s exact live base64 tx hash verifies]');
    {
      const REAL_B64 = 'LV5AoZEPNXniK16RaB91w9vTyo0gLa62XD9/OAvCNXo=';
      const REAL_HEX = '2d5e40a1910f3579e22b5e91681f75c3dbd3ca8d202daeb65c3f7f380bc2357a';
      check('fixture: base64 and hex are the same 32 bytes', b64hex(REAL_HEX) === REAL_B64, REAL_B64);
      const idG = makeInitData(G);
      walletFirstTx[WG] = nowSec() - 900 * 86400;
      let r = await api(idG, 'wallet', { address: WG });
      check('G binds WG', r.status === 200 && r.body.success === true, r);
      r = await api(idG, 'verifyInfo');
      const gComment = r.body.comment;
      check('G has ageOk and its own VIKING-<userNo> comment', r.body.ageOk === true && /^VIKING-\d+$/.test(gComment || ''), r.body);
      depositTxs = [depTx(REAL_B64, WG, FEE_NANO, decodedComment(gComment))];
      r = await api(idG, 'verifyCheck');
      check('verified, and the answer carries the canonical hex hash',
        r.status === 200 && r.body.verified === true && r.body.tx === REAL_HEX, r);
      const claim = await dbGet('verifyClaims/' + REAL_HEX);
      check('verifyClaims/<hex> records the claim (no base64 key, no slash-split nodes)',
        !!claim && String(claim.userId) === '700003010', claim);
      const p = await dbGet('players/700003010');
      check('player verified with verifyTx in hex (tonviewer-ready form)',
        !!p && p.walletVerified === true && p.verifyTx === REAL_HEX, p && p.verifyTx);
    }

    /* ---------------- V18: pending intent marking ----------------
       The fix round's watcher contract: opening the verification
       card (verifyInfo) with a bound, unverified wallet records the
       intent (verifyPendingAt) and reports verifyPending:true, so a
       payment made afterwards completes even with the app closed. */
    console.log('\n[V18: verifyInfo marks pending intent and reports verifyPending]');
    {
      walletFirstTx[WH] = nowSec() - 800 * 86400;
      let r = await api(idH, 'state');
      hNo = r.body.player.userNo;
      r = await api(idH, 'wallet', { address: WH });
      check('H binds WH', r.status === 200 && r.body.success === true, r);
      r = await api(idH, 'verifyInfo');
      check('verifyInfo reports verifyPending:true', r.status === 200 && r.body.verifyPending === true, r.body);
      check('H comment is VIKING-<userNo>', r.body.comment === 'VIKING-' + hNo, r.body);
      const p = await dbGet('players/700003011');
      check('verifyPendingAt marker persisted on the player', !!p && Number(p.verifyPendingAt) > 0, p && p.verifyPendingAt);
    }

    /* ---------------- V19: idle watcher = zero chain calls ----------------
       Spawn the watcher instance (VERIFY_WATCH_MS=250 — the env
       override is the documented test mechanism) with every pending
       marker cleared: its ticks may read the players node but must
       never touch the chain (the TON stub counts deposit scans). */
    console.log('\n[V19: watcher with nobody pending makes ZERO chain calls]');
    {
      await dbPatch('players/700003004', { verifyPendingAt: 0 }); // C (verified in V9; the flip already cleared his marker — kept as a guard)
      await dbPatch('players/700003008', { verifyPendingAt: 0 }); // E (never paid, was pending from V14)
      await dbPatch('players/700003011', { verifyPendingAt: 0 }); // H (V20 re-marks via verifyInfo)
      const watchSrv = spawn(path.join(__dirname, 'node_modules', '.bin', 'functions-framework'),
        ['--target=collectMining', '--port=' + WATCH_PORT], {
          cwd: __dirname,
          env: cleanEnv({
            BOT_TOKEN, OWNER_ID, ALLOWED_ORIGIN: '*',
            FIREBASE_DATABASE_URL: `http://${EMU}?ns=${NS}`,
            FIREBASE_DATABASE_EMULATOR_HOST: EMU,
            GOOGLE_APPLICATION_CREDENTIALS: saPath,
            TG_API_BASE: `http://127.0.0.1:${TG_PORT}`,
            TON_API_BASE: `http://127.0.0.1:${TON_PORT}/v3`,
            TONAPI_BASE: `http://127.0.0.1:${TON_PORT}/tonapi`,
          TONAPI_PAGE_GAP_MS: '0',
            VERIFY_WATCH_MS: '250'
          }),
          stdio: 'ignore'
        });
      children.push(watchSrv);
      await waitFor(async () => (await fetch(`http://127.0.0.1:${WATCH_PORT}/`)).status === 405, 30000, 'watcher server');
      const hits0 = depositHits;
      await sleep(1400); // ~5 watcher ticks
      check('deposit scan never ran with nobody pending', depositHits === hits0, { hits: depositHits, before: hits0 });
    }

    /* ---------------- V20: watcher completes with the app closed ---------------- */
    console.log('\n[V20: the watcher completes a pending player (no verifyCheck call) + messages exactly once]');
    const HASHW = 'a0'.repeat(32);
    {
      let r = await api(idH, 'verifyInfo');
      check('verifyInfo re-marks H pending', r.status === 200 && r.body.verifyPending === true, r.body);
      depositTxs = [depTx(b64hex(HASHW), WH, FEE_NANO, decodedComment('VIKING-' + hNo))];
      const photos0 = photosTo(H.id).length, admin0 = msgsTo(OWNER_ID).length;
      // NO verifyCheck call anywhere in this block — the watcher alone must finish it.
      await waitFor(async () => { const p = await dbGet('players/700003011'); return !!p && p.walletVerified === true; }, 15000, 'watcher verification of H');
      const p = await dbGet('players/700003011');
      check('H verified by the watcher alone, for WH', !!p && p.walletVerified === true && p.verifiedWallet === WH, p && { v: p.walletVerified, w: p.verifiedWallet });
      check('verifyTx recorded in canonical hex', !!p && p.verifyTx === HASHW, p && p.verifyTx);
      check('pending marker cleared by the completion', !!p && !(Number(p.verifyPendingAt) > 0), p && p.verifyPendingAt);
      const claim = await dbGet('verifyClaims/' + HASHW);
      check('the payment hash is claimed for H', !!claim && String(claim.userId) === '700003011', claim);
      check('user received exactly ONE photo DM', photosTo(H.id).length === photos0 + 1, photosTo(H.id).length);
      const cap = (photosTo(H.id)[photosTo(H.id).length - 1] || {}).caption || '';
      check('caption celebrates the badge and carries the VIKING-<userNo> mark',
        /WALLET VERIFIED/.test(cap) && cap.includes('VIKING-' + hNo), cap);
      check('caption carries the shortened friendly wallet (ellipsis form)', cap.includes('...'), cap);
      check('admin received exactly ONE deposit alert', msgsTo(OWNER_ID).length === admin0 + 1, msgsTo(OWNER_ID).length);
      const atext = (msgsTo(OWNER_ID)[msgsTo(OWNER_ID).length - 1] || {}).text || '';
      check('admin alert carries the tonviewer tx link and the 0.05 fee',
        atext.includes('https://tonviewer.com/transaction/' + HASHW) && atext.includes('0.05'), atext);
      await sleep(1400); // several more ticks against a completed player
      check('later ticks resend NOTHING', photosTo(H.id).length === photos0 + 1 && msgsTo(OWNER_ID).length === admin0 + 1,
        { photos: photosTo(H.id).length, admin: msgsTo(OWNER_ID).length });
    }

    /* ---------------- V21: verifyCheck wins -> watcher silent ---------------- */
    console.log('\n[V21: verifyCheck completing first -> the watcher does not resend]');
    {
      walletFirstTx[WI] = nowSec() - 800 * 86400;
      let r = await api(idR, 'state');
      rNo = r.body.player.userNo;
      r = await api(idR, 'wallet', { address: WI });
      check('R binds WI', r.status === 200 && r.body.success === true, r);
      r = await api(idR, 'verifyInfo');
      check('R is pending before paying', r.status === 200 && r.body.verifyPending === true, r.body);
      const HASHR = 'a1'.repeat(32);
      depositTxs = [depTx(b64hex(HASHR), WI, FEE_NANO, decodedComment('VIKING-' + rNo))];
      // (If a watcher tick slips in first, verifyCheck answers
      // already:true with the same tx — either winner is correct;
      // what this block pins is: exactly one pair of messages total.)
      r = await api(idR, 'verifyCheck');
      check('R ends up verified with the payment tx', r.status === 200 && r.body.verified === true && r.body.tx === HASHR, r);
      const p = await dbGet('players/700003012');
      check('pending marker cleared by the completion', !!p && !(Number(p.verifyPendingAt) > 0), p && p.verifyPendingAt);
      const photos1 = photosTo(RACE.id).length, admin1 = msgsTo(OWNER_ID).length;
      check('exactly one pair of messages was sent (by the winner)', photos1 === 1 && admin1 >= 1, { photos: photos1, admin: admin1 });
      await sleep(1500); // watcher ticks keep running against the completed player
      check('the watcher resends NOTHING after the other path won',
        photosTo(RACE.id).length === photos1 && msgsTo(OWNER_ID).length === admin1,
        { photos: photosTo(RACE.id).length, admin: msgsTo(OWNER_ID).length });
    }

    /* ---------------- V22: loser path sends nothing ---------------- */
    console.log('\n[V22: loser path — verifyCheck on an already-verified player sends nothing]');
    {
      const photos2 = photosTo(RACE.id).length, admin2 = msgsTo(OWNER_ID).length;
      const r = await api(idR, 'verifyCheck');
      check('verifyCheck -> verified (already)', r.status === 200 && r.body.verified === true && r.body.already === true, r);
      check('no messages from the loser call', photosTo(RACE.id).length === photos2 && msgsTo(OWNER_ID).length === admin2,
        { photos: photosTo(RACE.id).length, admin: msgsTo(OWNER_ID).length });
    }

    /* ---------------- V23: pending cleared on unlink / wallet change ---------------- */
    console.log('\n[V23: pending cleared on unlink and on wallet change]');
    {
      let r = await api(idJ, 'wallet', { address: WJ });
      check('J binds WJ', r.status === 200 && r.body.success === true, r);
      r = await api(idJ, 'verifyInfo');
      let p = await dbGet('players/700003013');
      check('J pending after verifyInfo', !!p && Number(p.verifyPendingAt) > 0, p && p.verifyPendingAt);
      r = await api(idJ, 'unlink');
      check('J unlinks', r.status === 200 && r.body.success === true, r);
      p = await dbGet('players/700003013');
      check('unlink cleared the pending marker', !!p && !(Number(p.verifyPendingAt) > 0), p && p.verifyPendingAt);

      r = await api(idK, 'wallet', { address: WK1 });
      check('K binds WK1', r.status === 200 && r.body.success === true, r);
      r = await api(idK, 'verifyInfo');
      p = await dbGet('players/700003014');
      check('K pending after verifyInfo', !!p && Number(p.verifyPendingAt) > 0, p && p.verifyPendingAt);
      await dbPatch('players/700003014', { lastSyncAt: 0 }); // wallet() 8 s sync cooldown
      r = await api(idK, 'wallet', { address: WK2 });
      check('K rebinds to WK2', r.status === 200 && r.body.success === true, r);
      p = await dbGet('players/700003014');
      check('wallet change cleared the pending marker', !!p && !(Number(p.verifyPendingAt) > 0), p && p.verifyPendingAt);
    }

    /* ---------------- V24: once per payment — re-completion after a void resends NOTHING ----------------
       The live MANSAWY duplicate (2026-11-14): verified by the
       watcher at 08:41, verification voided from his app session,
       watcher re-completed him at 08:48 from the SAME payment —
       and both success messages fired a second time. The flip may
       legitimately be won again; the messages may not. */
    console.log('\n[V24: re-completion from the SAME payment after a void re-verifies but resends NOTHING]');
    {
      const idL = makeInitData(L);
      walletFirstTx[WL] = nowSec() - 800 * 86400;
      let r = await api(idL, 'state');
      const lNo = r.body.player.userNo;
      r = await api(idL, 'wallet', { address: WL });
      check('L binds WL', r.status === 200 && r.body.success === true, r);
      r = await api(idL, 'verifyInfo');
      check('L pending with its own comment', r.status === 200 && r.body.verifyPending === true && r.body.comment === 'VIKING-' + lNo, r.body);
      const HASHL = 'a2'.repeat(32);
      depositTxs = [depTx(b64hex(HASHL), WL, FEE_NANO, decodedComment('VIKING-' + lNo))];
      const photos0 = photosTo(L.id).length, admin0 = msgsTo(OWNER_ID).length;
      // NO verifyCheck — the watcher alone completes it, as live.
      await waitFor(async () => { const p = await dbGet('players/700003015'); return !!p && p.walletVerified === true; }, 15000, 'first verification of L');
      let p = await dbGet('players/700003015');
      const verifiedAt1 = Number(p.verifiedAt);
      check('L verified by the watcher (first completion), tx recorded', !!p && p.walletVerified === true && p.verifyTx === HASHL && verifiedAt1 > 0,
        p && { v: p.walletVerified, tx: p.verifyTx, at: p.verifiedAt });
      check('first completion sent exactly ONE user DM + ONE admin alert',
        photosTo(L.id).length === photos0 + 1 && msgsTo(OWNER_ID).length === admin0 + 1,
        { photos: photosTo(L.id).length, admin: msgsTo(OWNER_ID).length });
      let claim = await dbGet('verifyClaims/' + HASHL);
      check('the claim carries notifiedAt after the first send', !!claim && Number(claim.notifiedAt) > 0, claim);
      const notifiedAt1 = Number(claim.notifiedAt);
      // Void the verification the way the app does: bind a DIFFERENT wallet.
      await dbPatch('players/700003015', { lastSyncAt: 0 }); // wallet() 8 s sync cooldown
      r = await api(idL, 'wallet', { address: WL2 });
      check('L binds a different wallet (the void)', r.status === 200 && r.body.success === true, r);
      p = await dbGet('players/700003015');
      check('the verification is voided by the wallet change', !!p && p.walletVerified === false && p.verifiedWallet === '',
        p && { v: p.walletVerified, w: p.verifiedWallet });
      // Rebind the original wallet and re-arm the pending intent.
      await dbPatch('players/700003015', { lastSyncAt: 0 });
      r = await api(idL, 'wallet', { address: WL });
      check('L rebinds the original wallet', r.status === 200 && r.body.success === true, r);
      r = await api(idL, 'verifyInfo');
      check('verifyInfo re-arms pending', r.status === 200 && r.body.verifyPending === true, r.body);
      // depositTxs still serves the SAME payment — the watcher
      // re-completes from it via the same-user claim fall-through.
      await waitFor(async () => { const q = await dbGet('players/700003015'); return !!q && q.walletVerified === true && Number(q.verifiedAt) > verifiedAt1; }, 15000, 're-verification of L');
      p = await dbGet('players/700003015');
      check('L is verified AGAIN for the original wallet, from the same payment',
        !!p && p.walletVerified === true && p.verifiedWallet === WL && p.verifyTx === HASHL,
        p && { v: p.walletVerified, w: p.verifiedWallet, tx: p.verifyTx });
      check('verifiedAt advanced on the re-completion (a real second flip)', Number(p.verifiedAt) > verifiedAt1, { before: verifiedAt1, after: p.verifiedAt });
      check('NO second user DM and NO second admin alert (once per payment)',
        photosTo(L.id).length === photos0 + 1 && msgsTo(OWNER_ID).length === admin0 + 1,
        { photos: photosTo(L.id).length, admin: msgsTo(OWNER_ID).length });
      claim = await dbGet('verifyClaims/' + HASHL);
      check('notifiedAt untouched by the re-completion (the slot was already taken)',
        !!claim && Number(claim.notifiedAt) === notifiedAt1, claim);
      await sleep(1200); // a few more watcher ticks against the re-completed player
      check('later ticks still resend nothing',
        photosTo(L.id).length === photos0 + 1 && msgsTo(OWNER_ID).length === admin0 + 1,
        { photos: photosTo(L.id).length, admin: msgsTo(OWNER_ID).length });
    }

    /* ---------------- V25: stranded claim still announces on its eventual win ----------------
       An earlier completion claimed the payment but died before
       winning the flip: the claim exists with NO notifiedAt and
       the player was never verified. When a later completion wins,
       that win is the payment's FIRST notification — the messages
       must fire. */
    console.log('\n[V25: stranded claim (no notifiedAt, flip never won) still sends on its eventual win]');
    {
      const idM = makeInitData(M);
      walletFirstTx[WM] = nowSec() - 800 * 86400;
      let r = await api(idM, 'state');
      const mNo = r.body.player.userNo;
      r = await api(idM, 'wallet', { address: WM });
      check('M binds WM', r.status === 200 && r.body.success === true, r);
      r = await api(idM, 'verifyInfo');
      check('M pending with its own comment', r.status === 200 && r.body.verifyPending === true && r.body.comment === 'VIKING-' + mNo, r.body);
      const HASHM = 'a3'.repeat(32);
      // The stranded state, written directly: claim present, owned
      // by M, no notifiedAt; the player record stays unverified.
      await dbPut('verifyClaims/' + HASHM, { userId: '700003016', at: Date.now() });
      depositTxs = [depTx(b64hex(HASHM), WM, FEE_NANO, decodedComment('VIKING-' + mNo))];
      const photos0 = photosTo(M.id).length, admin0 = msgsTo(OWNER_ID).length;
      await waitFor(async () => { const p = await dbGet('players/700003016'); return !!p && p.walletVerified === true; }, 15000, 'stranded-claim verification of M');
      const p = await dbGet('players/700003016');
      check('M verified via the watcher from the pre-claimed payment', !!p && p.walletVerified === true && p.verifyTx === HASHM,
        p && { v: p.walletVerified, tx: p.verifyTx });
      check('the messages DO fire (first notification for this payment)',
        photosTo(M.id).length === photos0 + 1 && msgsTo(OWNER_ID).length === admin0 + 1,
        { photos: photosTo(M.id).length, admin: msgsTo(OWNER_ID).length });
      const claim = await dbGet('verifyClaims/' + HASHM);
      check('the claim now carries notifiedAt', !!claim && Number(claim.notifiedAt) > 0, claim);
    }

    /* ---------------- V26: permanence belongs to VERIFIED claims (owner orders 2026-11-15 + 2026-11-18) ----------------
       A VERIFIED claim is permanent: unlinking does NOT free it and
       switching wallets does NOT free it; another account can never
       take it and the owner can always re-link it. An UNVERIFIED
       claim is only a provisional binding: the node is kept on
       unlink/switch, but another account binding the address takes
       the claim over — binding alone proves no ownership. */
    console.log('\n[V26: unverified claims are provisional; verified claims are permanent]');
    {
      const idP1 = makeInitData(P1);
      const idP2 = makeInitData(P2);
      let r = await api(idP1, 'wallet', { address: WP1 });
      check('P1 binds WP1', r.status === 200 && r.body.success === true, r);
      r = await api(idP1, 'unlink');
      check('P1 unlinks WP1', r.status === 200 && r.body.success === true, r);
      const wdoc = await dbGet('wallets/' + WP1.replace(':', '_'));
      check('the registry node SURVIVES the unlink, still owned by P1', !!wdoc && String(wdoc.userId) === '700003017', wdoc);
      r = await api(idP2, 'wallet', { address: WP1 });
      check('P2 binding the unlinked UNVERIFIED WP1 -> provisional takeover succeeds', r.status === 200 && r.body.success === true, r);
      const wdocT = await dbGet('wallets/' + WP1.replace(':', '_'));
      check('the node flipped to P2 (still unverified)', !!wdocT && String(wdocT.userId) === '700003018' && wdocT.verified !== true, wdocT);
      await dbPatch('players/700003017', { lastSyncAt: 0 }); // wallet() sync cooldown
      r = await api(idP1, 'wallet', { address: WP1 });
      check('P1 re-links its own WP1 after unlink (claim returns)', r.status === 200 && r.body.success === true, r);
      await dbPatch('players/700003017', { lastSyncAt: 0 });
      r = await api(idP1, 'wallet', { address: WP2 });
      check('P1 switches to WP2', r.status === 200 && r.body.success === true, r);
      const wdoc1 = await dbGet('wallets/' + WP1.replace(':', '_'));
      check('WP1 stays registered to P1 after the switch', !!wdoc1 && String(wdoc1.userId) === '700003017', wdoc1);
      await dbPatch('players/700003018', { lastSyncAt: 0 }); // P2 bound WP1 above; cooldown before a different bind
      r = await api(idP2, 'wallet', { address: WP2 });
      check('P2 binding WP2 (bound to P1, unverified) -> provisional takeover succeeds', r.status === 200 && r.body.success === true, r);
      // The verified stamp is what makes a claim permanent:
      await dbPut('wallets/' + WP1.replace(':', '_'), { userId: '700003017', verified: true });
      await dbPatch('players/700003018', { lastSyncAt: 0 });
      r = await api(idP2, 'wallet', { address: WP1 });
      check('P2 binding WP1 once it is VERIFIED to P1 -> 400 linked to another account', r.status === 400 && /linked to another account/.test(r.body.error || ''), r);
      await dbPatch('players/700003017', { lastSyncAt: 0 });
      r = await api(idP1, 'wallet', { address: WP1 });
      check('P1 re-links its VERIFIED WP1 freely', r.status === 200 && r.body.success === true, r);
      const s = await api(idP1, 'state');
      check('P1 state shows WP1 bound', s.body.player.walletAddr === WP1, s.body.player);
    }
  } finally {
    tgStub.close();
    tonStub.close();
    for (const ch of children) { try { ch.kill('SIGKILL'); } catch (e) { /* already dead */ } }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
