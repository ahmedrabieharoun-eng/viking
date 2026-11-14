/* Local end-to-end tests for the VIKING MINER RTDB server.
 *
 * Exercises the fixed server against the REAL Firebase RTDB emulator and a
 * stub Telegram API (TG_API_BASE). No real accounts, tokens or databases:
 * the bot token is a dummy, the service account is generated on the fly,
 * and the emulator runs a demo-* project.
 *
 * Prerequisites:
 *   - Node >= 18, dependencies installed here (npm install)
 *   - firebase-tools on PATH (or FIREBASE_BIN=/path/to/firebase)
 *   - a Java runtime on PATH (the RTDB emulator is a JVM program)
 *
 * Run:  node test_local.js
 * It spawns (and kills) three children: the RTDB emulator (port 9000), the
 * Telegram stub (in-process, port 18083) and this server via
 * functions-framework (port 18082). If an emulator already answers on
 * 127.0.0.1:9000 it is reused instead of spawning a new one.
 */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

/* Everything this script talks to is on 127.0.0.1. Some sandboxes force
   egress through a proxy via env vars (NODE_USE_ENV_PROXY=1), which can
   stall or misroute even local probes — drop them for this process too. */
for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'NODE_USE_ENV_PROXY']) delete process.env[k];

const BOT_TOKEN = '424242:AAFakeDummyTokenForLocalTestsOnly';
const OWNER_ID = '700000001';
const EMU_PORT = 9000;
const APP_PORT = 18082;
const STUB_PORT = 18083;
const NS = 'demo-viking-default-rtdb';
const EMU = `127.0.0.1:${EMU_PORT}`;

/* This sandbox (and some CI setups) force egress through a proxy via env
   vars; the Admin SDK's RTDB websocket then tries to tunnel and hangs.
   Children get a proxy-free env so they connect to 127.0.0.1 directly. */
function cleanEnv(extra) {
  const env = { ...process.env };
  for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'NODE_USE_ENV_PROXY']) delete env[k];
  return { ...env, ...extra };
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

/* ---------- Telegram stub: scripted getChatMember + sendMessage capture ---------- */
const sentMessages = [];
const MEMBER_MAP = { // user_id -> getChatMember result for the public channels
  700000201: { status: 'member' },
  700000202: { status: 'left' },
  700000203: { status: 'restricted', is_member: true },
  700000204: { status: 'restricted', is_member: false },
  700000205: { status: 'member' }
};
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch (e) { /* ignore */ }
    const m = /\/bot[^/]+\/(\w+)$/.exec(req.url || '');
    const method = m ? m[1] : '';
    res.setHeader('Content-Type', 'application/json');
    if (method === 'getChatMember') {
      if (body.chat_id === '@telegram') { // simulate: the bot is NOT in this channel
        return res.end(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }));
      }
      const r = MEMBER_MAP[Number(body.user_id)] || { status: 'member' };
      return res.end(JSON.stringify({ ok: true, result: { user: { id: Number(body.user_id) }, ...r } }));
    }
    if (method === 'sendMessage') sentMessages.push(body);
    return res.end(JSON.stringify({ ok: true, result: { message_id: sentMessages.length } }));
  });
});

/* ---------- tiny assertion kit ---------- */
let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS', name); }
  else { failed++; console.log('  FAIL', name, extra !== undefined ? '-> ' + JSON.stringify(extra) : ''); }
}

/* ---------- http helpers ---------- */
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
async function dbWipe() {
  for (const p of ['players', 'withdrawals', 'settings', 'meta', 'sigs', 'wallets', 'deviceIds', 'devices']) {
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

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viking-test-'));
  const children = [];
  try {
    /* fake service account (real RSA key, dummy identity — emulator only) */
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const saPath = path.join(tmp, 'fake-sa.json');
    fs.writeFileSync(saPath, JSON.stringify({
      type: 'service_account', project_id: 'demo-viking', private_key_id: 'fake',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      client_email: 'fake@demo-viking.iam.gserviceaccount.com', client_id: '1',
      token_uri: 'https://oauth2.googleapis.com/token'
    }));

    /* RTDB emulator (reuse if one is already listening — ANY HTTP response
       counts, including a 401 from locked rules) */
    const emuUp = await fetch(`http://${EMU}/.json?ns=${NS}`).then(() => true).catch(() => false);
    if (!emuUp) {
      const emuDir = path.join(tmp, 'emu');
      fs.mkdirSync(emuDir);
      /* Test-only rules: the REST assertions in this script read the DB
         directly, which the shipped LOCKED rules (correctly) deny. The
         emulator therefore runs with permissive read/write but the SAME
         .indexOn layout as the shipped database.rules.json, so query/index
         behaviour matches production. The Admin SDK bypasses rules either
         way, and the shipped rules file itself is not modified. */
      fs.writeFileSync(path.join(emuDir, 'database.rules.json'), JSON.stringify({
        rules: {
          '.read': true, '.write': true,
          players: { '.indexOn': ['lastSeen', 'deviceHash'] },
          withdrawals: { '.indexOn': ['userId', 'wdNum'] }
        }
      }));
      fs.writeFileSync(path.join(emuDir, 'firebase.json'), JSON.stringify({
        database: { rules: 'database.rules.json' },
        emulators: { database: { host: '127.0.0.1', port: EMU_PORT }, ui: { enabled: false }, singleProjectMode: true }
      }));
      const emuLog = path.join(tmp, 'emulator.log');
      const logFd = fs.openSync(emuLog, 'a');
      const fb = spawn(process.env.FIREBASE_BIN || 'firebase', ['emulators:start', '--only', 'database', '--project', 'demo-viking'],
        { cwd: emuDir, env: cleanEnv({}), stdio: ['ignore', logFd, logFd] });
      children.push(fb);
      try {
        await waitFor(async () => { await fetch(`http://${EMU}/.json?ns=${NS}`); return true; }, 90000, 'RTDB emulator');
      } catch (e) {
        console.error('--- emulator log tail ---\n' + fs.readFileSync(emuLog, 'utf8').split('\n').slice(-25).join('\n'));
        throw e;
      }
    }
    await dbWipe();

    /* Telegram stub */
    await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));

    /* the server under test */
    const srv = spawn(path.join(__dirname, 'node_modules', '.bin', 'functions-framework'),
      ['--target=collectMining', '--port=' + APP_PORT], {
        cwd: __dirname,
        env: cleanEnv({
          BOT_TOKEN, OWNER_ID, ALLOWED_ORIGIN: '*',
          FIREBASE_DATABASE_URL: `http://${EMU}?ns=${NS}`,
          FIREBASE_DATABASE_EMULATOR_HOST: EMU,
          GOOGLE_APPLICATION_CREDENTIALS: saPath,
          TG_API_BASE: `http://127.0.0.1:${STUB_PORT}`
        }),
        stdio: 'ignore'
      });
    children.push(srv);
    await waitFor(async () => (await fetch(`http://127.0.0.1:${APP_PORT}/`)).status === 405, 30000, 'server');

    console.log('\n[avatar: choice at first registration (owner order 2026-11-14)]');
    // inviter + invitee linked through the real referral path (startapp ref_<uid>)
    const invId = makeInitData(U(700000901, 'Inviter', 'inv_a'));
    let r = await api(invId, 'state');
    check('inviter state ok', r.status === 200, r);
    check('fresh player avatar = 0 (not chosen)', r.body.player.avatar === 0, r.body.player);
    const frId = makeInitData(U(700000902, 'Friend', 'fr_a'), { startParam: 'ref_700000901' });
    r = await api(frId, 'state');
    check('invitee state ok', r.status === 200, r);
    let inv = await dbGet('players/700000901');
    check('referral entry created with avatar 0', Array.isArray(inv.referrals) && inv.referrals.length === 1 && inv.referrals[0].avatar === 0, inv.referrals);

    console.log('\n[avatar: validation]');
    r = await api(frId, 'setAvatar', { n: 0 });
    check('n=0 -> 400', r.status === 400, r);
    r = await api(frId, 'setAvatar', { n: 9 });
    check('n=9 -> 400', r.status === 400, r);
    r = await api(frId, 'setAvatar', { n: 2.5 });
    check('n=2.5 -> 400', r.status === 400, r);
    r = await api(frId, 'setAvatar', { n: 'x' });
    check('n="x" -> 400', r.status === 400, r);

    console.log('\n[avatar: set + persistence + referral sync]');
    r = await api(frId, 'setAvatar', { n: 5 });
    check('setAvatar 5 -> 200 {success, avatar:5}', r.status === 200 && r.body.success === true && r.body.avatar === 5, r);
    let me = await dbGet('players/700000902');
    check('stored on the player record', me.avatar === 5, me.avatar);
    inv = await dbGet('players/700000901');
    check('mirrored onto the inviter referral entry', inv.referrals[0].avatar === 5, inv.referrals);
    r = await api(invId, 'state');
    check('inviter state ships entry avatar 5', r.body.player.referrals[0].avatar === 5, r.body.player.referrals);
    r = await api(frId, 'state');
    check('own state ships avatar 5', r.body.player.avatar === 5, r.body.player);

    console.log('\n[avatar: one-time lock (owner order 2026-11-14), solo player unaffected]');
    r = await api(frId, 'setAvatar', { n: 2 });
    check('re-pick 2 -> 409 (chosen once, forever)', r.status === 409, r);
    me = await dbGet('players/700000902');
    check('stored avatar stays 5 after the rejected re-pick', me.avatar === 5, me.avatar);
    inv = await dbGet('players/700000901');
    check('entry keeps the first pick', inv.referrals[0].avatar === 5, inv.referrals);
    const soloId = makeInitData(U(700000903, 'Solo', 'solo_a'));
    await api(soloId, 'state');
    r = await api(soloId, 'setAvatar', { n: 8 });
    check('player without inviter can pick', r.status === 200 && r.body.avatar === 8, r);
    r = await api(makeInitData(U(700000904, 'Cold', 'cold_a')), 'setAvatar', { n: 1 });
    check('setAvatar before state creates the player (no 404)', r.status === 200 && r.body.avatar === 1, r);

    console.log('\n[owner-only maintenance (owner order 2026-11-14)]');
    const hook = async (update) => {
      const secret = crypto.createHash('sha256').update(BOT_TOKEN).digest('hex').slice(0, 32);
      const rr = await fetch(`http://127.0.0.1:${APP_PORT}/`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
        body: JSON.stringify(update)
      });
      return rr.status;
    };
    let updSeq = 880001;
    const startMsg = (uid, name) => ({ update_id: updSeq++, message: { message_id: updSeq, date: Math.floor(Date.now() / 1000), chat: { id: uid, type: 'private' }, from: { id: uid, first_name: name }, text: '/start' } });

    // flag ON (cfg cache is 20 s — poll until the gate is visible;
    // probe with a FRESH user each tick: the state action is limited
    // to 20/min per user, so re-polling as frId would 429 forever)
    let probeSeq = 0;
    const probe = () => api(makeInitData(U(700001100 + (probeSeq++), 'Probe', 'probe')), 'state');
    await dbPut('settings/global', { ownerOnly: true });
    await waitFor(async () => (await probe()).status === 403, 40000, 'maintenance gate on');
    r = await api(frId, 'state');
    check('non-owner state -> 403 {maintenance:true}', r.status === 403 && r.body.maintenance === true, r);
    r = await api(frId, 'collect');
    check('non-owner collect -> 403 too', r.status === 403 && r.body.maintenance === true, r);
    r = await api(makeInitData(U(700000001, 'Owner', 'owner1')), 'state');
    check('owner state -> 200 while the gate is on', r.status === 200, r.status);

    // bot side: non-owner /start gets ONLY the update notice, no player created
    const before = sentMessages.length;
    let hs = await hook(startMsg(700000950, 'Outsider'));
    check('webhook accepted', hs === 200, hs);
    const notice = sentMessages.slice(before).find((m) => m.chat_id === 700000950);
    check('non-owner /start -> update notice', !!notice && /Update in progress/.test(notice.text || ''), sentMessages.slice(before));
    check('no player created for the gated user', (await dbGet('players/700000950')) === null);
    const beforeO = sentMessages.length;
    hs = await hook(startMsg(700000001, 'Owner'));
    check('owner webhook accepted', hs === 200, hs);
    check('owner gets NO maintenance notice', !sentMessages.slice(beforeO).some((m) => m.chat_id === 700000001 && /Update in progress/.test(m.text || '')));

    // flag OFF again -> everyone back in
    await dbPut('settings/global', { ownerOnly: false });
    await waitFor(async () => (await probe()).status === 200, 40000, 'maintenance gate off');
    r = await api(frId, 'state');
    check('gate off -> non-owner state 200 again', r.status === 200, r.status);
  } finally {
    stub.close();
    for (const ch of children) { try { ch.kill('SIGKILL'); } catch (e) { /* already dead */ } }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
