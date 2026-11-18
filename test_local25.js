/* Exploit fix (owner order 2026-11-18): closing the bind-any-address
 * hole behind the Lyass_21 / Adam hold-task thefts.
 *
 *   X1  THE EXPLOIT ITSELF: a player binds a RICH wallet he does not
 *       control through the real `wallet` action (the chain read
 *       happily reports 25,000) — every hold-task tier now refuses
 *       with 403 'Verify your wallet first' and credits nothing,
 *       because the bound wallet is not his VERIFIED wallet.
 *   X2  Once the same wallet is his verified wallet, the tiers pay
 *       normally (no regression for honest holders).
 *   X3  Binding a DIFFERENT wallet voids the verification (existing
 *       rule) — hold tasks refuse again until the new wallet is
 *       verified.
 *   X4  REGISTRY SQUATTING: an unverified claim blocks nobody — a
 *       second account binding the same address takes the claim over.
 *       When the first account then actually verifies (panel manual
 *       verify -> completeVerification), the registry node is stamped
 *       {userId: verifier, verified: true} atomically — the squatter
 *       does NOT inherit the verified flag, and his next bind of the
 *       address is refused 400.
 *   X5  A verified claim survives unlink and stays locked to its
 *       owner (permanence where it belongs).
 *
 * Same harness as test_local23.js (real RTDB emulator + Telegram stub
 * + TON stub with per-wallet balances in `holdByWallet`), plus the
 * admin panel enabled (ADMIN_PANEL_KEY) for the X4 manual verify.
 *
 * Run:  node test_local25.js   (ports: app 18250, TG stub 18251, TON stub 18253, emu 9000)
 */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'NODE_USE_ENV_PROXY']) delete process.env[k];

const BOT_TOKEN = '<redacted_bot_token_1>';
const OWNER_ID = '700000001';
const PANEL_KEY = 'test-panel-key-25';
const EMU_PORT = 9000;
const APP_PORT = 18250;
const TG_PORT = 18251;
const TON_PORT = 18253;
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
async function panel(action, body = {}) {
  const r = await fetch(`http://127.0.0.1:${APP_PORT}/`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, key: PANEL_KEY, ...body })
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
const wdocOf = (raw) => dbGet('wallets/' + raw.replace(':', '_'));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viking-test25-'));
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
          BOT_TOKEN, OWNER_ID, ALLOWED_ORIGIN: '*', ADMIN_PANEL_KEY: PANEL_KEY,
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

    const W_RICH = RAW('a');  // 25,000 on-chain — the wallet the exploiter does NOT own
    const W_OTHER = RAW('b'); // another rich wallet for the void test
    const W_SQUAT = RAW('c'); // the squatted address for X4/X5
    holdByWallet[W_RICH] = 25000;
    holdByWallet[W_OTHER] = 25000;

    console.log('\n[X1: the exploit — bind a rich foreign wallet, claim hold tasks]');
    const idE = makeInitData(U(700025001, 'Exploit Ed', 'exploited'));
    {
      await api(idE, 'state');
      let r = await api(idE, 'wallet', { address: W_RICH });
      check('bind succeeds and the chain read reports 25,000', r.status === 200 && r.body.success === true && r.body.hold === 25000, r);
      const wdoc = await wdocOf(W_RICH);
      check('registry claim is provisional (his id, NOT verified)', !!wdoc && String(wdoc.userId) === '700025001' && wdoc.verified !== true, wdoc);
      r = await api(idE, 'holdTask', { tier: 1 });
      check('tier 1 -> 403 Verify your wallet first', r.status === 403 && /Verify your wallet first/.test(r.body.error || ''), r);
      r = await api(idE, 'holdTask', { tier: 5 });
      check('tier 5 -> 403 Verify your wallet first', r.status === 403 && /Verify your wallet first/.test(r.body.error || ''), r);
      const p = await dbGet('players/700025001');
      check('nothing credited, no tier stamped', (p.mined || 0) === 0 && !(p.holdTaskAt && Object.keys(p.holdTaskAt).length), p);
    }

    console.log('\n[X2: the same wallet, once VERIFIED to him, pays normally]');
    {
      await dbPatch('players/700025001', { walletVerified: true, verifiedWallet: W_RICH });
      let r = await api(idE, 'holdTask', { tier: 5 });
      check('tier 5 pays +2500', r.status === 200 && r.body.success === true && r.body.reward === 2500, r);
      r = await api(idE, 'holdTask', { tier: 1 });
      check('tier 1 pays +300', r.status === 200 && r.body.success === true && r.body.reward === 300, r);
      const p = await dbGet('players/700025001');
      check('mined = 2800, earnTasks = 2800', p.mined === 2800 && p.earnTasks === 2800, p);
    }

    console.log('\n[X3: binding a different wallet voids verification — claims refuse again]');
    {
      await dbPatch('players/700025001', { lastSyncAt: 0 }); // wallet() sync cooldown
      let r = await api(idE, 'wallet', { address: W_OTHER });
      check('bind of the other rich wallet succeeds', r.status === 200 && r.body.success === true, r);
      const p = await dbGet('players/700025001');
      check('verification voided by the switch', p.walletVerified === false && (p.verifiedWallet || '') === '', p);
      r = await api(idE, 'holdTask', { tier: 2 });
      check('tier 2 -> 403 Verify your wallet first', r.status === 403 && /Verify your wallet first/.test(r.body.error || ''), r);
      const p2 = await dbGet('players/700025001');
      check('balance untouched by the refused claim', p2.mined === 2800, p2.mined);
    }

    console.log('\n[X4: registry squatting — provisional takeover, then verification stamps the true owner]');
    const idF = makeInitData(U(700025002, 'Squat Fay', 'squatfay'));
    const idG = makeInitData(U(700025003, 'Squat Gus', 'squatgus'));
    {
      await api(idF, 'state');
      let r = await api(idF, 'wallet', { address: W_SQUAT });
      check('F binds the squat wallet', r.status === 200 && r.body.success === true, r);
      await api(idG, 'state');
      r = await api(idG, 'wallet', { address: W_SQUAT });
      check('G binds the SAME address — provisional takeover succeeds', r.status === 200 && r.body.success === true, r);
      let wdoc = await wdocOf(W_SQUAT);
      check('node flipped to G, still unverified', !!wdoc && String(wdoc.userId) === '700025003' && wdoc.verified !== true, wdoc);
      r = await panel('panelVerifyPlayer', { id: '700025002' });
      check('panel manual verify of F succeeds', r.status === 200, r);
      const p = await dbGet('players/700025002');
      check('F is verified for the squat wallet', p.walletVerified === true && p.verifiedWallet === W_SQUAT, p);
      wdoc = await wdocOf(W_SQUAT);
      check('node stamped {userId: F, verified: true} — the squatter did NOT inherit it', !!wdoc && String(wdoc.userId) === '700025002' && wdoc.verified === true, wdoc);
      r = await api(idG, 'wallet', { address: W_SQUAT });
      check('G binding it now -> 400 linked to another account', r.status === 400 && /linked to another account/.test(r.body.error || ''), r);
    }

    console.log('\n[X5: a verified claim survives unlink and stays locked]');
    {
      let r = await api(idF, 'unlink');
      check('F unlinks', r.status === 200 && r.body.success === true, r);
      const wdoc = await wdocOf(W_SQUAT);
      check('verified node survives the unlink, still F\'s', !!wdoc && String(wdoc.userId) === '700025002' && wdoc.verified === true, wdoc);
      await dbPatch('players/700025003', { lastSyncAt: 0 });
      r = await api(idG, 'wallet', { address: W_SQUAT });
      check('G still cannot take it -> 400', r.status === 400 && /linked to another account/.test(r.body.error || ''), r);
      await dbPatch('players/700025002', { lastSyncAt: 0 });
      r = await api(idF, 'wallet', { address: W_SQUAT });
      check('F re-links his verified wallet freely', r.status === 200 && r.body.success === true, r);
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
