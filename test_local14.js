'use strict';
/* Wallet bind must not be hostage to the chain read (live incident
 * 2026-11-15): wallet() awaited jettonHold BEFORE the ownership claim
 * and the bind write, so a tonapi failure (rate limit under the
 * signup flood) rejected the whole bind — TonConnect connected, the
 * app stayed "Not connected". The bind now persists regardless; the
 * hold is best-effort.
 *
 *   W1  jetton read FAILING: a fresh bind still succeeds + persists
 *   W2  read healthy again: same-wallet re-sync picks up the balance
 *   W3  read FAILING: binding a DIFFERENT wallet succeeds with hold 0
 *       (never credited with the previous wallet's balance)
 *   W4  read healthy: the new wallet's real balance syncs in
 *   W5  ownership is unaffected: another account binding a wallet
 *       VERIFIED to the first account still 400s even while the chain
 *       read is failing (since 2026-11-18 permanence attaches to the
 *       verified stamp; an unverified claim would transfer instead —
 *       that side is covered by test_local25)
 *
 * Run:  node test_local14.js   (ports: app 18140, TG 18141, TON 18143, emu 9000)
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
const APP_PORT = 18140;
const TG_PORT = 18141;
const TON_PORT = 18143;
const NS = 'demo-viking-default-rtdb';
const EMU = `127.0.0.1:${EMU_PORT}`;

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
const RAW = (ch) => '0:' + ch.repeat(64);

function makeInitData(user, opts = {}) {
  const params = new URLSearchParams();
  params.set('user', JSON.stringify(user));
  params.set('auth_date', String(Math.floor(Date.now() / 1000)));
  params.set('query_id', 'AAEtestquery');
  if (opts.startParam) params.set('start_param', opts.startParam);
  const dcs = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return params.toString();
}

const tgStub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    const m = /\/bot[^/]+\/(\w+)$/.exec(req.url || '');
    const method = m ? m[1] : '';
    res.setHeader('Content-Type', 'application/json');
    if (method === 'getMe') return res.end(JSON.stringify({ ok: true, result: { id: 424242, is_bot: true, first_name: 'Test Viking', username: 'TestVikingBot' } }));
    if (method === 'getChatMember') return res.end(JSON.stringify({ ok: true, result: { user: { id: 1 }, status: 'member' } }));
    return res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  });
});

/* TON stub with a toggleable jetton failure (the tonapi outage) */
let failJetton = false;
const jettonBalances = {}; // rawAddr -> whole coins
const tonStub = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('Content-Type', 'application/json');
  let m = /^\/tonapi\/address\/(.+)\/parse$/.exec(u.pathname);
  if (m) return res.end(JSON.stringify({ raw_form: toRawAddress(decodeURIComponent(m[1])) }));
  m = /^\/tonapi\/accounts\/(.+)\/jettons\//.exec(u.pathname);
  if (m) {
    if (failJetton) { res.statusCode = 500; return res.end(JSON.stringify({ error: 'rate limited' })); }
    const raw = toRawAddress(decodeURIComponent(m[1]));
    if (!(raw in jettonBalances)) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'not found' })); }
    return res.end(JSON.stringify({ balance: String(Math.round(jettonBalances[raw] * 1e9)), jetton: { decimals: 9 } }));
  }
  if (u.pathname === '/v3/transactions') {
    const old = Math.floor(Date.now() / 1000) - 400 * 86400;
    return res.end(JSON.stringify({ transactions: [{ hash: Buffer.from('f1'.repeat(32), 'hex').toString('base64'), lt: '1', now: old, in_msg: { source: '', value: '0' } }], address_book: {} }));
  }
  res.statusCode = 404;
  return res.end(JSON.stringify({ error: 'stub: unknown path ' + u.pathname }));
});

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
async function dbPatch(p, v) {
  await fetch(`http://${EMU}/${p}.json?ns=${NS}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v) });
}
async function dbWipe() {
  await fetch(`http://${EMU}/.json?ns=${NS}`, { method: 'DELETE' });
}
async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  for (;;) {
    try { if (await fn()) return; } catch (e) { /* keep waiting */ }
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + label);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const U1 = { id: 700003001, first_name: 'Binder One', username: 'binderone' };
const U2 = { id: 700003002, first_name: 'Binder Two', username: 'bindertwo' };
const WA = RAW('a'), WB = RAW('b');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viking-test14-'));
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
    if (!emuUp) throw new Error('RTDB emulator is not listening on 127.0.0.1:9000 — start it first');
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
          VERIFY_WATCH_MS: '0', REF_HOLD_WATCH_MS: '0'
        }),
        stdio: 'ignore'
      });
    children.push(srv);
    await waitFor(async () => (await fetch(`http://127.0.0.1:${APP_PORT}/`)).status === 405, 30000, 'server');
    const idU1 = makeInitData(U1);
    const idU2 = makeInitData(U2);
    await api(idU1, 'state', { deviceHash: 'DEV-U1' });
    await api(idU2, 'state', { deviceHash: 'DEV-U2' });
    jettonBalances[WA] = 500;
    jettonBalances[WB] = 750;

    console.log('\n[W1: bind while the chain read is failing]');
    failJetton = true;
    const w1 = await api(idU1, 'wallet', { address: WA });
    check('bind returns success despite the failed read', w1.status === 200 && w1.body && w1.body.success === true, w1);
    const p1 = await dbGet('players/700003001');
    check('walletAddr persisted', p1.walletAddr === WA, p1.walletAddr);
    check('hold falls back to 0', Number(p1.hold) === 0, p1.hold);

    console.log('\n[W2: healthy read syncs the real balance]');
    failJetton = false;
    const w2 = await api(idU1, 'wallet', { address: WA });
    check('re-sync success with hold 500', w2.status === 200 && Number(w2.body.hold) === 500, w2.body);

    console.log('\n[W3: different-wallet bind while the read is failing]');
    await dbPatch('players/700003001', { lastSyncAt: 0 }); // step outside the 8s anti-churn window
    failJetton = true;
    const w3 = await api(idU1, 'wallet', { address: WB });
    check('bind succeeds', w3.status === 200 && w3.body && w3.body.success === true, w3);
    const p3 = await dbGet('players/700003001');
    check('new wallet persisted', p3.walletAddr === WB, p3.walletAddr);
    check('hold is 0, NOT the old wallet\'s 500', Number(p3.hold) === 0, p3.hold);

    console.log('\n[W4: the new wallet\'s balance syncs when reads recover]');
    failJetton = false;
    const w4 = await api(idU1, 'wallet', { address: WB });
    check('hold 750', w4.status === 200 && Number(w4.body.hold) === 750, w4.body);

    console.log('\n[W5: ownership still enforced while reads fail]');
    // Permanence attaches to the VERIFIED stamp (2026-11-18): mark
    // U1's claim on WB verified, as completeVerification would have.
    await dbPatch('wallets/' + WB.replace(':', '_'), { verified: true });
    failJetton = true;
    const w5 = await api(idU2, 'wallet', { address: WB });
    check('another account binding the verified-owned wallet gets 400', w5.status === 400, w5);

    console.log(`\n=== test_local14: ${passed} passed, ${failed} failed ===`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    for (const ch of children) { try { ch.kill('SIGKILL'); } catch (e) { /* ignore */ } }
    tgStub.close(); tonStub.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
