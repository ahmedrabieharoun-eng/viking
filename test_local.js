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

    console.log('\n[smoke: auth]');
    let r = await api('garbage', 'state');
    check('bad initData -> 401', r.status === 401, r);
    const valid1 = makeInitData(U(700000101, 'Fresh', 'fresh1'));
    const tampered = valid1.slice(0, -1) + (valid1.endsWith('0') ? '1' : '0'); // always differs — a plain replace(/.$/, '0') is a no-op whenever the hash already ends in 0 (~1/16 of runs)
    r = await api(tampered, 'state');
    check('tampered hash -> 401', r.status === 401, r);
    r = await api(makeInitData(U(700000101, 'Fresh', 'fresh1'), { authDate: Math.floor(Date.now() / 1000) - 25 * 3600 }), 'state');
    check('expired auth_date (25h) -> 401 Session expired', r.status === 401 && /Session expired/.test(r.body.error || ''), r);
    r = await api(makeInitData(U(700000101, 'Fresh', 'fresh1')), 'noSuchAction');
    check('unknown action -> 400', r.status === 400, r);

    console.log('\n[task 1: fresh users never see "User not found"]');
    const fresh = makeInitData(U(700000101, 'Fresh', 'fresh1'));
    r = await api(fresh, 'collect');
    check('collect before state -> 400 Wait 10 seconds (not 404)', r.status === 400 && r.body.error === 'Wait 10 seconds', r);
    r = await api(fresh, 'wallet');
    check('wallet before state (TonConnect race) -> 400 Connect a wallet first (not 404)', r.status === 400 && /Connect a wallet first/.test(r.body.error || ''), r);
    r = await api(makeInitData(U(700000102, 'Daily', 'daily1')), 'daily');
    check('daily before state -> 200, day-1 reward 10', r.status === 200 && r.body.reward === 10, r);
    r = await api(makeInitData(U(700000103, 'Ad', 'ad1')), 'ad');
    check('ad action removed (owner order) -> 400 Unknown action', r.status === 400 && r.body.error === 'Unknown action', r);
    r = await api(makeInitData(U(700000104, 'Ref', 'ref1')), 'refCollect');
    check('refCollect before state -> 400 No pending referral profits (not 404)', r.status === 400 && /No pending/.test(r.body.error || ''), r);
    r = await api(makeInitData(U(700000105, 'Wd', 'wd1')), 'withdraw', { amount: 6000 });
    check('withdraw before state -> 400 Connect TON wallet first (not 404)', r.status === 400 && /Connect TON wallet first/.test(r.body.error || ''), r);
    r = await api(makeInitData(U(700000106, 'Un', 'un1')), 'unlink');
    check('unlink before state -> 200', r.status === 200 && r.body.success === true, r);
    r = await api(fresh, 'state');
    check('state creates the player', r.status === 200 && r.body.player && r.body.player.id === '700000101', r);
    check('state response does not leak multiLinks', r.status === 200 && !('multiLinks' in (r.body.player || {})), r.body.player);
    r = await api(fresh, 'collect');
    check('collect right after state -> 400 Wait 10 seconds (stale-view 404 regression)', r.status === 400 && r.body.error === 'Wait 10 seconds', r);

    console.log('\n[task 3: real channel verification via the bot]');
    const taskFlow = async (uid, name, uname, n) => {
      const id = makeInitData(U(uid, name, uname));
      await api(id, 'state');
      return api(id, 'task', { n });
    };
    r = await taskFlow(700000201, 'Member', 'member1', 1);
    check('member -> task 1 granted', r.status === 200 && r.body.success === true && r.body.reward === 50, r);
    let p = await dbGet('players/700000201');
    check('member: task1Done set + 50 credited', p.task1Done === true && p.mined === 50, p);
    r = await taskFlow(700000202, 'Left', 'left1', 1);
    check('left -> 403 Join the channel first', r.status === 403 && r.body.error === 'Join the channel first', r);
    p = await dbGet('players/700000202');
    check('left: no flag, no credit', !p.task1Done && (p.mined || 0) === 0, p);
    r = await taskFlow(700000203, 'RestrIn', 'restrin1', 1);
    check('restricted + is_member=true -> granted', r.status === 200 && r.body.success === true, r);
    r = await taskFlow(700000204, 'RestrOut', 'restrout1', 1);
    check('restricted + is_member=false -> 403', r.status === 403 && r.body.error === 'Join the channel first', r);
    r = await taskFlow(700000205, 'NoBot', 'nobot1', 2);
    check('bot not in channel -> 503 distinct fail-closed error', r.status === 503 && /Channel check unavailable/.test(r.body.error || ''), r);
    p = await dbGet('players/700000205');
    check('bot-missing: task2Done NOT set, no credit', !p.task2Done && (p.mined || 0) === 0, p);

    console.log('\n[task 4: multi-account detection, report-only — AdVOLT port]');
    const idA = makeInitData(U(700000301, 'Multi A', 'multia'));
    const idB = makeInitData(U(700000302, 'Multi B', 'multib'));
    /* VOLT identity (owner redirect): A and B present the SAME persistent
       deviceId — the same physical device — while everything else differs
       (combined fingerprint, all five signals, legacy deviceHash/fp). The
       deviceId registry is the primary layer, so B must link to A. This
       section previously drove the REMOVED loose rule (shared deviceHash +
       legacy cid) and expected symmetric linking; under the VOLT system
       the later account carries the link and the first account (the device
       owner) stays clean — see MULTI_FIX_REPORT.md. */
    const sigA = { canvasHash: 'canvas-a-00000001', webglHash: 'webgl-a-00000001', hardwareHash: 'hardware-a-000001', fontsHash: 'fonts-a-00000001', audioHash: 'audio-a-00000001' };
    const sigB = { canvasHash: 'canvas-b-00000002', webglHash: 'webgl-b-00000002', hardwareHash: 'hardware-b-000002', fontsHash: 'fonts-b-00000002', audioHash: 'audio-b-00000002' };
    const idnA = { _deviceId: 'shared-device-id-0001', _deviceFingerprint: 'combined-fp-a-00000001', _afSignals: sigA };
    const idnB = { _deviceId: 'shared-device-id-0001', _deviceFingerprint: 'combined-fp-b-00000002', _afSignals: sigB };
    await api(idA, 'state', idnA);
    await api(idB, 'state', idnB);
    const pA = await dbGet('players/700000301');
    const pB = await dbGet('players/700000302');
    check('B linked to A (same VOLT deviceId — primary registry)', !!(pB.multiLinks && (pB.multiLinks.ids || []).includes('700000301') && pB.multiLinks.count >= 1), pB.multiLinks);
    check('NO owner alert after B joins (alerts removed by owner order — links are read via /multi)', sentMessages.length === 0, sentMessages.length);
    check('B\'s stored link record is complete (count mirrors ids, v2, fresh updatedAt)',
      !!pB.multiLinks && pB.multiLinks.count === (pB.multiLinks.ids || []).length && pB.multiLinks.v === 2 && Number(pB.multiLinks.updatedAt) > 0, pB.multiLinks);
    await api(idB, 'state', idnB);
    const pB2 = await dbGet('players/700000302');
    check('B state again -> still silent and the stored list is unchanged (dedupe via stored list)',
      sentMessages.length === 0 && JSON.stringify((pB2.multiLinks || {}).ids || []) === JSON.stringify((pB.multiLinks || {}).ids || []), sentMessages.length);
    await api(idA, 'state', idnA);
    const pA2 = await dbGet('players/700000301');
    check('A (first account = device owner) stays clean — VOLT semantics',
      !(pA2.multiLinks && (pA2.multiLinks.ids || []).length), pA2.multiLinks);
    check('no alert fires for the device owner either (fully silent)', sentMessages.length === 0, sentMessages.length);
    check('nobody got banned by detection', pA2.banned !== true && (await dbGet('players/700000302')).banned !== true);
    r = await api(makeInitData(U(Number(OWNER_ID), 'Owner', 'owner')), 'adminState');
    const entryB = (r.body.players || []).find((x) => String(x.id) === '700000302');
    check('adminState: B carries multiLinks with linked user names',
      !!(entryB && entryB.multiLinks && entryB.multiLinks.count >= 1 && (entryB.multiLinks.users || []).some((u) => u.id === '700000301' && u.name === 'Multi A')),
      entryB && entryB.multiLinks);
    r = await api(makeInitData(U(700000201, 'Member', 'member1')), 'adminState');
    check('adminState is owner-gated (non-owner -> 403)', r.status === 403, r);

    console.log('\n[levels: collect pays the REAL per-package rate for the player\'s hold]');
    /* The server mirrors the app's levels table (LEVEL_DEFS in index.js,
       copied from the frontend customLevels; levels 31-100 derive) and
       collect() pays the rate of the highest level whose reqHold the
       player's synced hold meets — not the old flat 250/day. Settings
       are wiped at the top of this suite, so cfg is the DEFAULTS:
       lvl1PerDay 250 -> scale 1, refClaimPercent 5. Each case seeds a
       full player record directly (hold + a lastCollectTime a full day
       back, so the 86400s cap makes the credit exactly one day at the
       level rate, up to float dust) and collects once via the API. */
    const approx = (a, b, tol) => Math.abs((Number(a) || 0) - b) <= tol;
    const seedMiner = async (uid, hold, lastCollectTime, extra = {}) => {
      await dbPut('players/' + uid, {
        id: String(uid), name: 'Miner ' + uid, username: 'miner' + uid, mined: 0, hold,
        banned: false, lastCollectTime, referrals: [], ...extra
      });
      return makeInitData(U(uid, 'Miner', 'miner' + uid));
    };
    const lvlCases = [
      [0, 250], [199, 250],       // level 1 (and just under level 2's req)
      [200, 300], [1249, 300],    // level 2 (and just under package 3's req)
      [1250, 500], [2499, 500],   // package 3 (and just under package 4's req)
      [2500, 750],                // package 4
      [10000, 1500],              // level 7
      [326000, 33600],            // level 30 (last explicit level)
      [400000, 37632]             // level 31 (derived: req round(326000*1.15)=374900, day round(33600*1.12)=37632)
    ];
    for (let i = 0; i < lvlCases.length; i++) {
      const [hold, perDay] = lvlCases[i];
      const uid = 700000401 + i;
      const idn = await seedMiner(uid, hold, Date.now() - 86400000);
      r = await api(idn, 'collect');
      check(`hold ${hold} -> full-day collect credits the level rate ${perDay}`, r.status === 200 && approx(r.body.added, perDay, 0.01), r.body);
      p = await dbGet('players/' + uid);
      check(`hold ${hold} -> mined balance matches the credit`, approx(p.mined, perDay, 0.01), p.mined);
    }
    /* mid-period: one hour at package 4's rate = 750/24 = 31.25 (the
       seed-to-collect delay adds a fraction of a second of accrual,
       well inside the 0.1 tolerance — and far from any other level's
       hourly rate) */
    const midId = await seedMiner(700000420, 2500, Date.now() - 3600000);
    r = await api(midId, 'collect');
    check('hold 2500, 1h elapsed -> credits ~750/24', r.status === 200 && approx(r.body.added, 750 / 24, 0.1), r.body);
    /* the inviter commission percentages off the SAME level-rate
       credit: 5% of a full-day package-4 collect (750) = 37.5 */
    await seedMiner(700000430, 0, Date.now(), {
      name: 'Inviter Lvl', username: 'inviterlvl', pendingRefComm: 0,
      referrals: [{ id: '700000431', name: 'Miner 700000431', status: 'Verified ✅', profit: 0 }]
    });
    const inviteeId = await seedMiner(700000431, 2500, Date.now() - 86400000, { invitedBy: 700000430, refBonusPaid: true });
    r = await api(inviteeId, 'collect');
    check('invitee at package 4 collects the full 750', r.status === 200 && approx(r.body.added, 750, 0.01), r.body);
    p = await dbGet('players/700000430');
    check('inviter pendingRefComm = 5% of the level-4 credit (37.5)', approx(p.pendingRefComm, 37.5, 0.01), p.pendingRefComm);
    check('inviter referral entry profit tracks the same 37.5', approx((p.referrals || [])[0] && p.referrals[0].profit, 37.5, 0.01), p.referrals);
  } finally {
    stub.close();
    for (const ch of children) { try { ch.kill('SIGKILL'); } catch (e) { /* already dead */ } }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
