/* Task-system changes (owner order 2026-11-17):
 *
 *   R1  CHANNEL TASKS RENEW EVERY 24 HOURS (were one-time): a claim
 *       stamps taskNAt; an immediate re-claim is refused with the
 *       renewal error; once taskNAt is 25 h old the task claims
 *       again, and the success response carries nextAt ~= now + 24 h.
 *   R2  LEGACY MIGRATION: a player with taskNDone=true but NO
 *       taskNAt (claimed before the renewal feature) is claimable
 *       immediately once; no migration timestamp is invented.
 *   R3  HOLD TASKS (new action `holdTask`): five tiers — hold
 *       1250/2500/5000/10000/20000 $VIKING in the bound wallet ->
 *       claim 300/500/1000/1500/2500, each tier renewable every
 *       24 h on its own timer (holdTaskAt[tier]). The hold is read
 *       FRESH from the chain at claim time: no wallet -> 400, hold
 *       below the tier -> 403, success credits + stamps the tier
 *       timer and writes the fresh hold back; an immediate re-claim
 *       of the same tier -> 400, while a higher tier is judged on
 *       its own requirement. (Since the 2026-11-18 exploit fix, hold
 *       tasks also require the bound wallet to be the player's
 *       VERIFIED wallet — the R3 fixtures below are seeded verified;
 *       the unverified rejection itself is covered by test_local25.)
 *
 * Same harness as test_local5.js (real RTDB emulator + Telegram stub
 * where everyone is a channel member + TON stub); the TON stub serves
 * per-wallet jetton balances from `holdByWallet` (raw address ->
 * coins), which is how the holdTask chain reads are scripted.
 *
 * Run:  node test_local23.js   (ports: app 18230, TG stub 18231, TON stub 18233, emu 9000)
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
const APP_PORT = 18230;
const TG_PORT = 18231;
const TON_PORT = 18233;
const NS = 'demo-viking-default-rtdb';
const EMU = `127.0.0.1:${EMU_PORT}`;
const RAW = (ch) => '0:' + ch.repeat(64);

function cleanEnv(extra) {
  const env = { ...process.env };
  for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'NODE_USE_ENV_PROXY']) delete env[k];
  return { ...env, ...extra };
}
function toRawAddress(addr) {
  const s = String(addr || '').trim();
  const m = /^(-?\d+):([0-9a-fA-F]{64})$/.exec(s);
  if (m) return m[1] + ':' + m[2].toLowerCase();
  try {
    const b = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (b.length === 36) return b.readInt8(1) + ':' + b.subarray(2, 34).toString('hex');
  } catch (e) { /* fall through */ }
  return s.toLowerCase();
}

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

/* ---------- Telegram stub: everyone is a channel member ---------- */
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
    if (method === 'getChatMember') return res.end(JSON.stringify({ ok: true, result: { user: { id: Number(body.user_id) }, status: 'member' } }));
    return res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  });
});

/* ---------- TON stub: per-wallet jetton balances ---------- */
const holdByWallet = {}; // rawAddr -> coins (number); absent -> tonapi 404 -> hold 0
const tonStub = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('Content-Type', 'application/json');
  let m = /^\/tonapi\/address\/(.+)\/parse$/.exec(u.pathname);
  if (m) return res.end(JSON.stringify({ raw_form: toRawAddress(decodeURIComponent(m[1])) }));
  m = /^\/tonapi\/accounts\/(.+)\/jettons\//.exec(u.pathname);
  if (m) {
    const addr = toRawAddress(decodeURIComponent(m[1]));
    if (!(addr in holdByWallet)) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'not found' })); }
    return res.end(JSON.stringify({ balance: String(Math.round(holdByWallet[addr] * 1e9)), jetton: { decimals: 9 } }));
  }
  if (/^\/tonapi\/jettons\//.test(u.pathname)) return res.end(JSON.stringify({ metadata: { decimals: '9' } }));
  if (u.pathname === '/v3/jetton/wallets') {
    const owner = toRawAddress(u.searchParams.get('owner_address') || '');
    const bal = owner in holdByWallet ? holdByWallet[owner] : 0;
    return res.end(JSON.stringify({ jetton_wallets: bal > 0 ? [{ address: RAW('f'), balance: String(Math.round(bal * 1e9)), owner, jetton: 'EQtest' }] : [], address_book: {} }));
  }
  if (u.pathname === '/v3/transactions') return res.end(JSON.stringify({ transactions: [], address_book: {} }));
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
async function dbPatch(p, v) {
  await fetch(`http://${EMU}/${p}.json?ns=${NS}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v) });
}
async function dbWipe() {
  await fetch(`http://${EMU}/.json?ns=${NS}`, { method: 'DELETE' });
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
const approx = (a, b, tol) => Math.abs((Number(a) || 0) - b) <= tol;

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viking-test23-'));
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
          VERIFY_WATCH_MS: '0', VERIFY_SWEEP_MS: '0', REF_HOLD_WATCH_MS: '0', REF_REPAIR_MS: '0'
          // TON_API_KEY intentionally unset — keyless operation must work
        }),
        stdio: 'ignore'
      });
    children.push(srv);
    await waitFor(async () => (await fetch(`http://127.0.0.1:${APP_PORT}/`)).status === 405, 30000, 'server');

    console.log('\n[R1: channel task renews every 24 hours]');
    {
      const idX = makeInitData(U(700023001, 'Renew', 'renew1'));
      await api(idX, 'state');
      let r = await api(idX, 'task', { n: 1 });
      check('first claim succeeds (+50)', r.status === 200 && r.body.success === true && r.body.reward === 50, r);
      check('success carries nextAt ~= now + 24h', approx(r.body.nextAt, Date.now() + 86400000, 10000), r.body);
      let p = await dbGet('players/700023001');
      check('task1Done set, task1At stamped, mined = 50', p.task1Done === true && Number(p.task1At) > 0 && p.mined === 50, p);
      r = await api(idX, 'task', { n: 1 });
      check('immediate re-claim -> 400 renewal error', r.status === 400 && /renews every 24 hours/.test(r.body.error || ''), r);
      p = await dbGet('players/700023001');
      check('no double credit from the refused claim', p.mined === 50, p.mined);
      await dbPatch('players/700023001', { task1At: Date.now() - 25 * 3600000 });
      r = await api(idX, 'task', { n: 1 });
      check('claim 25h later succeeds again (+50)', r.status === 200 && r.body.success === true && r.body.reward === 50, r);
      check('renewed success nextAt ~= now + 24h', approx(r.body.nextAt, Date.now() + 86400000, 10000), r.body);
      p = await dbGet('players/700023001');
      check('mined = 100 total from the two claims, earnTasks = 100', p.mined === 100 && p.earnTasks === 100, p);
    }

    console.log('\n[R2: legacy migration — taskNDone without taskNAt is claimable once]');
    {
      const idY = makeInitData(U(700023002, 'Legacy', 'legacy1'));
      await api(idY, 'state');
      await dbPatch('players/700023002', { task2Done: true, task2At: 0 });
      const r = await api(idY, 'task', { n: 2 });
      check('legacy player (done, no At) claims immediately', r.status === 200 && r.body.success === true && r.body.reward === 50, r);
      const p = await dbGet('players/700023002');
      check('claim stamped task2At and credited 50', Number(p.task2At) > 0 && p.mined === 50, p);
    }

    console.log('\n[R3: hold tasks — fresh chain read, per-tier 24h timers]');
    {
      // no wallet bound -> 400
      const idNW = makeInitData(U(700023003, 'NoWallet', 'nowallet1'));
      await api(idNW, 'state');
      let r = await api(idNW, 'holdTask', { tier: 1 });
      check('no wallet -> 400 Connect wallet first', r.status === 400 && /Connect wallet first/.test(r.body.error || ''), r);

      // bound wallet, hold 1000 < 1250 -> 403
      const W_LOW = RAW('d');
      holdByWallet[W_LOW] = 1000;
      const idLow = makeInitData(U(700023004, 'LowHold', 'lowhold1'));
      await api(idLow, 'state');
      await dbPatch('players/700023004', { walletAddr: W_LOW, walletVerified: true, verifiedWallet: W_LOW });
      r = await api(idLow, 'holdTask', { tier: 1 });
      check('hold 1000 < 1250 -> 403 naming the requirement', r.status === 403 && /Hold at least 1,250/.test(r.body.error || ''), r);
      let p = await dbGet('players/700023004');
      check('refused claim credits nothing and stamps nothing', (p.mined || 0) === 0 && !(p.holdTaskAt && p.holdTaskAt['1']), p);

      // bound wallet, hold 1300: tier 1 succeeds, tier 2 (2500) refused
      const W_OK = RAW('e');
      holdByWallet[W_OK] = 1300;
      const idZ = makeInitData(U(700023005, 'Holder', 'holder1'));
      await api(idZ, 'state');
      await dbPatch('players/700023005', { walletAddr: W_OK, walletVerified: true, verifiedWallet: W_OK });
      r = await api(idZ, 'holdTask', { tier: 1 });
      check('hold 1300 -> tier 1 succeeds (+300)', r.status === 200 && r.body.success === true && r.body.reward === 300, r);
      check('success carries nextAt ~= now + 48h', approx(r.body.nextAt, Date.now() + 172800000, 10000), r.body);
      p = await dbGet('players/700023005');
      check('mined = 300, earnTasks = 300, holdTaskAt[1] stamped, fresh hold written back (1300)',
        p.mined === 300 && p.earnTasks === 300 && Number((p.holdTaskAt || {})['1']) > 0 && p.hold === 1300, p);
      r = await api(idZ, 'holdTask', { tier: 1 });
      check('immediate tier-1 re-claim -> 400 renewal error', r.status === 400 && /renews every 48 hours/.test(r.body.error || ''), r);
      r = await api(idZ, 'holdTask', { tier: 2 });
      check('tier 2 with hold 1300 -> 403 (needs 2500)', r.status === 403 && /Hold at least 2,500/.test(r.body.error || ''), r);
      r = await api(idZ, 'holdTask', { tier: 6 });
      check('tier 6 -> 400 Bad task', r.status === 400 && /Bad task/.test(r.body.error || ''), r);
      p = await dbGet('players/700023005');
      check('refusals credited nothing extra', p.mined === 300, p.mined);
      // tier 1 renews after 48h (owner order 2026-11-17, was 24h):
      // at 25h the claim must STILL be refused; at 49h it succeeds.
      await dbPatch('players/700023005', { holdTaskAt: { '1': Date.now() - 25 * 3600000 } });
      r = await api(idZ, 'holdTask', { tier: 1 });
      check('tier 1 still refused at 25h (48h window)', r.status === 400 && /renews every 48 hours/.test(r.body.error || ''), r);
      await dbPatch('players/700023005', { holdTaskAt: { '1': Date.now() - 49 * 3600000 } });
      r = await api(idZ, 'holdTask', { tier: 1 });
      check('tier 1 claimable again after 49h (+300)', r.status === 200 && r.body.success === true && r.body.reward === 300, r);
      p = await dbGet('players/700023005');
      check('mined = 600 after the renewal claim', p.mined === 600, p.mined);
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
