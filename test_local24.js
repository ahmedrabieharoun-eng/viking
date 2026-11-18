/* Admin PANEL API (owner order 2026-11-17): the key-guarded
 * `panel*` actions behind the web admin panel.
 *
 *   A1  AUTH: an instance WITHOUT ADMIN_PANEL_KEY answers 503
 *       'Panel disabled'; a wrong key and a missing key field both
 *       answer 401; an unknown panel action answers 400. Panel
 *       calls carry NO initData at all — the panel helper never
 *       sends it, so every check below also proves the pre-gate
 *       dispatch works without Telegram auth.
 *   A2  STATS: seeded players/withdrawals/verifyHealth aggregate
 *       exactly (totals, verified, newToday, totalMined, pending/
 *       paid/rejected counts, verify block, payout balances from
 *       the payout stub).
 *   A3  PLAYERS: paging shape, userNo search (short digits),
 *       Telegram-id search (long digits, direct read), name
 *       substring search (case-insensitive).
 *   A4  PLAYER: full record + only his withdrawals (newest first)
 *       + his verify records + risk + inviter; ghost -> 404.
 *   A5  BAN / ADJUST / AVATAR: flips land, bounds enforced, the
 *       adjust read-back is exact, audit entries are written.
 *   A6  VERIFY (panelVerifyPlayer): a wallet-bound unverified
 *       player is completed through completeVerification — claim
 *       doc + wallets doc + success DM exactly once; a second
 *       call answers won:false 'already'; banned -> 403; no
 *       wallet -> 400; ghost -> 404.
 *   A7  VERIFY QUEUE + RESOLVE: a seeded open verifyUnresolved
 *       record is listed with its player summary, resolved through
 *       the same completion path, and closed as resolved-by-panel.
 *   A8  WITHDRAWAL DECISIONS: reject flips Pending -> Rejected
 *       with decidedAt and NO refund; ban also bans; approve on a
 *       processed record -> 400; approve on a Pending record runs
 *       the REAL attemptPayout against the payout stub (Paid,
 *       payoutState 'paid', chain-resolved payoutTx, exactly one
 *       sendJetton of net x 10^decimals).
 *   A9  CONFIG: get shape; set roundtrips through the busted
 *       config cache (visible in panelConfigGet AND a player
 *       state call); holdTaskDefs validated (strictly increasing
 *       holds); unknown keys ignored, never stored; ownerOnly can
 *       be flipped by the panel while the player gate is shut
 *       (the panel bypasses maintenance) and restored.
 *   A10 REQUESTS INBOX: add -> list ('new') -> reply -> list
 *       ('done' + reply); ghost reply -> 404; empty text -> 400.
 *   A11 AUDIT: every consequential panel action left an entry.
 *   A13 PANEL PAGE + LOCKOUT (runs LAST): GET /panel is 401
 *       without/with wrong Basic credentials (WWW-Authenticate
 *       present) and 200 with the panel key as the Basic password,
 *       other GET paths stay 405; repeated wrong panel keys lock
 *       the IP out (429) while the correct key still works (owner
 *       bypass), and the owner receives ONE Arabic security alert
 *       («أمني») on the Telegram stub. After A13 the IP is blocked,
 *       so no later section may rely on wrong-key behaviour.
 *
 * Two instances: A (ADMIN_PANEL_KEY set + payout stub) and B (no
 * key). Same harness family as test_local23 (RTDB emulator +
 * Telegram stub that RECORDS calls + TON stub); the payout client
 * is the file-backed stub pattern from test_local8.
 *
 * Run:  node test_local24.js   (ports: app A 18240, TG stub 18241, app B 18242, TON stub 18243, emu 9000)
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
const PANEL_KEY = 'test-panel-key';
const EMU_PORT = 9000;
const APP_A = 18240;
const TG_PORT = 18241;
const APP_B = 18242;
const TON_PORT = 18243;
const NS = 'demo-viking-default-rtdb';
const EMU = `127.0.0.1:${EMU_PORT}`;
const RAW = (ch) => '0:' + ch.repeat(64);
const HASH1 = 'ab'.repeat(32);
const STUB_TX_HASH = 'cd'.repeat(32);
const BOGUS_LOCAL_HASH = 'ef'.repeat(32);
const TEST_MNEMONIC = 'such hip sun bronze slogan human friend swap banana nominee neither address lion spider act refuse source drastic south mail burger speak category major';

function cleanEnv(extra, remove) {
  const env = { ...process.env };
  for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'NODE_USE_ENV_PROXY']) delete env[k];
  for (const k of remove || []) delete env[k];
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

/* ---------- Telegram stub: records every call ---------- */
const tgCalls = [];
const tgStub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch (e) { /* ignore */ }
    const m = /\/bot[^/]+\/(\w+)$/.exec(req.url || '');
    const method = m ? m[1] : '';
    tgCalls.push({ method, body });
    res.setHeader('Content-Type', 'application/json');
    if (method === 'getMe') return res.end(JSON.stringify({ ok: true, result: { id: 424242, is_bot: true, first_name: 'Test Viking', username: 'TestVikingBot' } }));
    if (method === 'getChatMember') return res.end(JSON.stringify({ ok: true, result: { user: { id: Number(body.user_id) }, status: 'member' } }));
    return res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  });
});
const dmCount = (uid) => tgCalls.filter((x) => (x.method === 'sendPhoto' || x.method === 'sendMessage') && String(x.body.chat_id) === String(uid)).length;

/* ---------- TON stub (same shapes as test_local23; jetton decimals 9) ---------- */
const holdByWallet = {};
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
async function api(port, initData, action, body = {}) {
  const r = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData, action, ...body })
  });
  let j = null;
  try { j = await r.json(); } catch (e) { /* ignore */ }
  return { status: r.status, body: j };
}
/* Panel calls NEVER carry initData — key auth only. key === null omits the field entirely. */
async function panel(port, action, body = {}, key = PANEL_KEY) {
  const payload = { action, ...body };
  if (key !== null) payload.key = key;
  const r = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
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

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viking-test24-'));
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

    /* File-backed payout stub (test_local8's pattern): fixed rich
       balances, every sendJetton appended to a JSONL log,
       findTransferTx returns the chain-resolved hash. */
    const STUB_LOG = path.join(tmp, 'payout-sends.jsonl');
    const STUB_MODULE = path.join(tmp, 'payout-stub.js');
    fs.writeFileSync(STUB_MODULE, `
const fs = require('fs');
exports.createPayoutClient = async () => ({
  addressRaw: '0:67cd4c10365460553b1a2ab6df6ac96164fd006c40fa7eb470c8557b4e28f56a',
  addressFriendly: 'EQBnzUwQNlRgVTsaKrbfaslhZP0AbED6frRwyFV7Tij1agnk',
  async getTonBalance() { return 5000000000n; },
  async getJettonBalance() { return 2000000000000n; },
  async sendJetton({ toRaw, amount, comment }) {
    fs.appendFileSync(process.env.PAYOUT_STUB_LOG, JSON.stringify({ toRaw, amount: amount.toString(), comment }) + '\\n');
    return { seqno: 7, txHash: '${BOGUS_LOCAL_HASH}' };
  },
  async findTransferTx() { return '${STUB_TX_HASH}'; }
});
`);
    fs.writeFileSync(STUB_LOG, '');
    const sends = () => fs.readFileSync(STUB_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

    const emuUp = await fetch(`http://${EMU}/.json?ns=${NS}`).then(() => true).catch(() => false);
    if (!emuUp) throw new Error('RTDB emulator is not listening on 127.0.0.1:9000 — start it first');
    await dbWipe();
    await new Promise((r) => tgStub.listen(TG_PORT, '127.0.0.1', r));
    await new Promise((r) => tonStub.listen(TON_PORT, '127.0.0.1', r));

    const baseEnv = {
      BOT_TOKEN, OWNER_ID, ALLOWED_ORIGIN: '*',
      FIREBASE_DATABASE_URL: `http://${EMU}?ns=${NS}`,
      FIREBASE_DATABASE_EMULATOR_HOST: EMU,
      GOOGLE_APPLICATION_CREDENTIALS: saPath,
      TG_API_BASE: `http://127.0.0.1:${TG_PORT}`,
      TON_API_BASE: `http://127.0.0.1:${TON_PORT}/v3`,
      TONAPI_BASE: `http://127.0.0.1:${TON_PORT}/tonapi`,
      TONAPI_PAGE_GAP_MS: '0',
      VERIFY_WATCH_MS: '0', VERIFY_SWEEP_MS: '0', REF_HOLD_WATCH_MS: '0', REF_REPAIR_MS: '0'
    };
    const spawnSvc = (port, extra, remove) => {
      const ch = spawn(path.join(__dirname, 'node_modules', '.bin', 'functions-framework'),
        ['--target=collectMining', '--port=' + port], { cwd: __dirname, env: cleanEnv({ ...baseEnv, ...extra }, remove), stdio: 'ignore' });
      children.push(ch);
      return ch;
    };
    spawnSvc(APP_A, { ADMIN_PANEL_KEY: PANEL_KEY, PAYOUT_MNEMONIC: TEST_MNEMONIC, PAYOUT_STUB_MODULE: STUB_MODULE, PAYOUT_STUB_LOG: STUB_LOG });
    spawnSvc(APP_B, {}, ['ADMIN_PANEL_KEY', 'PAYOUT_MNEMONIC', 'PAYOUT_STUB_MODULE']);
    await waitFor(async () => (await fetch(`http://127.0.0.1:${APP_A}/`)).status === 405, 30000, 'server A');
    await waitFor(async () => (await fetch(`http://127.0.0.1:${APP_B}/`)).status === 405, 30000, 'server B');

    console.log('\n[A1: panel auth — disabled instance, wrong/missing key, unknown action]');
    {
      let r = await panel(APP_B, 'panelStats');
      check('instance without ADMIN_PANEL_KEY -> 503 Panel disabled', r.status === 503 && /Panel disabled/.test(r.body.error || ''), r);
      r = await panel(APP_A, 'panelStats', {}, 'wrong-key');
      check('wrong key -> 401', r.status === 401 && /Bad key/.test(r.body.error || ''), r);
      r = await panel(APP_A, 'panelStats', {}, null);
      check('missing key field -> 401', r.status === 401, r);
      r = await panel(APP_A, 'panelNope');
      check('unknown panel action -> 400', r.status === 400 && /Unknown action/.test(r.body.error || ''), r);
    }

    /* ---------- seed: 4 players, 5 withdrawals, verifyHealth, 1 open unresolved ---------- */
    const idPete = makeInitData(U(700024001, 'Panel Pete', 'pete1'));
    const idVera = makeInitData(U(700024002, 'Verify Vera', 'vera1'));
    const idQuinn = makeInitData(U(700024003, 'Queue Quinn', 'quinn1'));
    const idWendy = makeInitData(U(700024004, 'Wd Wendy', 'wendy1'));
    await api(APP_A, idPete, 'state');
    await api(APP_A, idVera, 'state');
    await api(APP_A, idQuinn, 'state');
    await api(APP_A, idWendy, 'state');
    const pete = await dbGet('players/700024001');
    const vera = await dbGet('players/700024002');
    const quinn = await dbGet('players/700024003');
    await dbPatch('players/700024001', { mined: 100 });
    await dbPatch('players/700024002', { walletAddr: RAW('a'), mined: 200 });
    await dbPatch('players/700024003', { walletAddr: RAW('b'), mined: 300 });
    await dbPatch('players/700024004', { mined: 5000, walletAddr: RAW('c'), walletVerified: true, verifiedWallet: RAW('c') });
    const nowSec = Math.floor(Date.now() / 1000);
    const wdSeed = (num, userId, userName, amt, net, fee, status, extra = {}) =>
      dbPatch('withdrawals/wd_' + num, { wdNum: num, userId, userName, walletAddr: RAW('c'), amt, net, fee, status, timestamp: Date.now(), ...extra });
    await wdSeed(8801, '700024004', 'Wd Wendy', 1000, 950, 50, 'Pending ⏳');
    await wdSeed(8802, '700024004', 'Wd Wendy', 2000, 1900, 100, 'Pending ⏳');
    await wdSeed(8803, '700024004', 'Wd Wendy', 105, 100, 5, 'Pending ⏳');
    await wdSeed(8804, '700024004', 'Wd Wendy', 500, 475, 25, 'Paid ✅', { payoutState: 'paid', payoutTx: 'aa'.repeat(32) });
    await wdSeed(8805, '700024001', 'Panel Pete', 700, 665, 35, 'Rejected ❌');
    await dbPatch('meta/verifyHealth', { openUnresolved: 1, cursorUtime: nowSec - 120, cursorLt: 12345, processedTotal: 777 });
    await dbPatch('verifyUnresolved/' + HASH1, { userNo: quinn.userNo, uid: '700024003', source: RAW('b'), valueNano: '50000000', utime: nowSec - 60, firstSeenAt: Date.now() - 60000, reason: 'source-mismatch', status: 'open', checks: 2 });

    console.log('\n[A2: panelStats aggregates]');
    {
      const r = await panel(APP_A, 'panelStats');
      check('stats ok', r.status === 200 && r.body.ok === true, r);
      check('players total/verified/banned/newToday', r.body.players.total === 4 && r.body.players.verified === 1 && r.body.players.banned === 0 && r.body.players.newToday === 4, r.body.players);
      check('totalMined = 100+200+300+5000', r.body.players.totalMined === 5600, r.body.players);
      check('withdrawals pending/paid/rejected = 3/1/1', r.body.withdrawals.pending === 3 && r.body.withdrawals.paidCount === 1 && r.body.withdrawals.rejectedCount === 1, r.body.withdrawals);
      check('verify block from meta/verifyHealth', r.body.verify.openUnresolved === 1 && r.body.verify.processedTotal === 777 && r.body.verify.cursorLagSec >= 100 && r.body.verify.cursorLagSec <= 200, r.body.verify);
      check('payout balances from the stub (5 TON / 2000 coins)', r.body.payout && r.body.payout.ton === 5 && r.body.payout.viking === 2000, r.body.payout);
      check('serverTime ~ now, uptimeSec >= 0', Math.abs(r.body.serverTime - Date.now()) < 15000 && r.body.uptimeSec >= 0, r.body);
    }

    console.log('\n[A3: panelPlayers search + paging]');
    {
      let r = await panel(APP_A, 'panelPlayers');
      check('no-q: total 4, page 0 of 1, 4 slim rows', r.body.total === 4 && r.body.page === 0 && r.body.pages === 1 && r.body.rows.length === 4, r.body);
      check('slim row shape', r.body.rows.every((x) => 'userNo' in x && 'refCount' in x && 'walletVerified' in x && 'invitedBy' in x), r.body.rows[0]);
      r = await panel(APP_A, 'panelPlayers', { q: String(vera.userNo) });
      check('short digits -> userNo match (Vera)', r.body.total === 1 && r.body.rows[0].id === '700024002', r.body);
      r = await panel(APP_A, 'panelPlayers', { q: '700024003' });
      check('long digits -> Telegram id direct read (Quinn)', r.body.total === 1 && r.body.rows[0].id === '700024003', r.body);
      r = await panel(APP_A, 'panelPlayers', { q: 'PETE' });
      check('name substring, case-insensitive (Pete)', r.body.total === 1 && r.body.rows[0].id === '700024001', r.body);
      r = await panel(APP_A, 'panelPlayers', { q: 'nomatch' });
      check('no match -> total 0, empty rows', r.body.total === 0 && r.body.rows.length === 0, r.body);
      r = await panel(APP_A, 'panelPlayers', { page: 99 });
      check('page clamps to the last page', r.body.page === 0 && r.body.rows.length === 4, r.body);
    }

    console.log('\n[A4: panelPlayer detail]');
    {
      let r = await panel(APP_A, 'panelPlayer', { id: '700024004' });
      check('full record returned', r.status === 200 && r.body.player.mined === 5000 && r.body.player.walletVerified === true, r.body.player && { mined: r.body.player.mined });
      check('his withdrawals only, newest first', r.body.withdrawals.length === 4 && r.body.withdrawals.map((w) => w.wdNum).join(',') === '8804,8803,8802,8801' && r.body.withdrawals.every((w) => w.docId), r.body.withdrawals.map((w) => w.wdNum));
      check('no verify records for Wendy; risk low; inviter null', r.body.verifyRecords.length === 0 && r.body.risk && r.body.risk.level === 'low' && r.body.inviter === null, { vr: r.body.verifyRecords.length, risk: r.body.risk && r.body.risk.level });
      r = await panel(APP_A, 'panelPlayer', { id: '700024003' });
      check('Quinn verifyRecords holds the open record', r.body.verifyRecords.length === 1 && r.body.verifyRecords[0].hash === HASH1 && r.body.verifyRecords[0].status === 'open', r.body.verifyRecords);
      r = await panel(APP_A, 'panelPlayer', { id: '700024999' });
      check('ghost player -> 404', r.status === 404, r);
      r = await panel(APP_A, 'panelPlayer', { id: 'abc' });
      check('malformed id -> 400', r.status === 400, r);
    }

    console.log('\n[A5: panelBan / panelAdjust / panelSetAvatar]');
    {
      let r = await panel(APP_A, 'panelBan', { id: '700024001', banned: true });
      check('ban ok', r.status === 200 && r.body.banned === true, r);
      let p = await dbGet('players/700024001');
      check('ban landed in the record', p.banned === true, p.banned);
      r = await panel(APP_A, 'panelBan', { id: '700024001', banned: false });
      p = await dbGet('players/700024001');
      check('unban landed', r.body.banned === false && p.banned === false, p.banned);
      r = await panel(APP_A, 'panelBan', { id: '700024999', banned: true });
      check('ban ghost -> 404', r.status === 404, r);
      r = await panel(APP_A, 'panelAdjust', { id: '700024001', amount: 500 });
      check('adjust +500 -> mined read-back 600', r.status === 200 && r.body.mined === 600, r.body);
      r = await panel(APP_A, 'panelAdjust', { id: '700024001', amount: -200 });
      check('adjust -200 -> mined read-back 400', r.status === 200 && r.body.mined === 400, r.body);
      p = await dbGet('players/700024001');
      check('adjust landed in the record', p.mined === 400, p.mined);
      r = await panel(APP_A, 'panelAdjust', { id: '700024001', amount: 1e13 });
      check('adjust beyond the 1e12 bound -> 400', r.status === 400, r);
      r = await panel(APP_A, 'panelSetAvatar', { id: '700024001', avatar: 5 });
      p = await dbGet('players/700024001');
      check('avatar 5 set', r.status === 200 && r.body.avatar === 5 && p.avatar === 5, { r: r.body, p: p.avatar });
      r = await panel(APP_A, 'panelSetAvatar', { id: '700024001', avatar: 0 });
      p = await dbGet('players/700024001');
      check('avatar 0 = reset to unset', r.body.avatar === 0 && p.avatar === 0, p.avatar);
      r = await panel(APP_A, 'panelSetAvatar', { id: '700024001', avatar: 9 });
      check('avatar 9 -> 400', r.status === 400, r);
    }

    console.log('\n[A6: panelVerifyPlayer through completeVerification]');
    {
      let r = await panel(APP_A, 'panelVerifyPlayer', { id: '700024002' });
      check('verify won with a synthetic manual hash', r.status === 200 && r.body.won === true && /^manual-/.test(r.body.tx || ''), r.body);
      const tx = r.body.tx;
      let p = await dbGet('players/700024002');
      check('player flipped verified for the bound wallet', p.walletVerified === true && p.verifiedWallet === RAW('a') && p.verifyTx === tx, { v: p.walletVerified, vw: p.verifiedWallet });
      const wdoc = await dbGet('wallets/' + RAW('a').replace(':', '_'));
      check('wallets doc flagged verified for Vera', wdoc && wdoc.userId === '700024002' && wdoc.verified === true, wdoc);
      const claim = await dbGet('verifyClaims/' + tx);
      check('claim doc exists, owned by Vera, notifiedAt set (DM slot taken)', claim && claim.userId === '700024002' && typeof claim.notifiedAt === 'number', claim);
      check('success DM sent to Vera exactly once', dmCount('700024002') === 1, dmCount('700024002'));
      r = await panel(APP_A, 'panelVerifyPlayer', { id: '700024002' });
      check('second verify -> won:false already, no second DM', r.body.won === false && r.body.reason === 'already' && dmCount('700024002') === 1, r.body);
      r = await panel(APP_A, 'panelVerifyPlayer', { id: '700024999' });
      check('verify ghost -> 404', r.status === 404, r);
      // banned player -> 403; wallet-less player -> 400
      const idBanned = makeInitData(U(700024005, 'Banned Bob', 'bob1'));
      await api(APP_A, idBanned, 'state');
      await dbPatch('players/700024005', { banned: true, walletAddr: RAW('e') });
      r = await panel(APP_A, 'panelVerifyPlayer', { id: '700024005' });
      check('banned player -> 403', r.status === 403, r);
      const idNoWal = makeInitData(U(700024006, 'NoWallet Ned', 'ned1'));
      await api(APP_A, idNoWal, 'state');
      r = await panel(APP_A, 'panelVerifyPlayer', { id: '700024006' });
      check('no wallet bound -> 400 Connect wallet first', r.status === 400 && /Connect wallet first/.test(r.body.error || ''), r);
    }

    console.log('\n[A7: panelVerifyQueue + panelVerifyResolve]');
    {
      let r = await panel(APP_A, 'panelVerifyQueue');
      check('queue lists the open record with its player summary', r.body.rows.length === 1 && r.body.rows[0].hash === HASH1 && r.body.rows[0].userNo === quinn.userNo && r.body.rows[0].player && r.body.rows[0].player.id === '700024003' && r.body.rows[0].player.walletVerified === false, r.body.rows);
      r = await panel(APP_A, 'panelVerifyResolve', { hash: HASH1 });
      check('resolve won', r.status === 200 && r.body.won === true && r.body.tx === HASH1, r.body);
      const p = await dbGet('players/700024003');
      check('Quinn verified by the resolve', p.walletVerified === true && p.verifiedWallet === RAW('b'), { v: p.walletVerified });
      const rec = await dbGet('verifyUnresolved/' + HASH1);
      check('record closed as resolved-by-panel', rec.status === 'resolved' && rec.resolvedBy === 'panel' && typeof rec.resolvedAt === 'number', rec);
      check('success DM sent to Quinn exactly once', dmCount('700024003') === 1, dmCount('700024003'));
      r = await panel(APP_A, 'panelVerifyQueue');
      check('queue empty after the resolve', r.body.rows.length === 0, r.body.rows);
      r = await panel(APP_A, 'panelVerifyResolve', { hash: HASH1 });
      check('resolve a closed record -> 400', r.status === 400, r);
      r = await panel(APP_A, 'panelVerifyResolve', { hash: 'ff'.repeat(32) });
      check('resolve a ghost hash -> 404', r.status === 404, r);
    }

    console.log('\n[A8: panelWithdrawals + decisions (bot money rules, attemptPayout)]');
    {
      let r = await panel(APP_A, 'panelWithdrawals');
      check('default = pending only, newest first', r.body.rows.map((w) => w.wdNum).join(',') === '8803,8802,8801', r.body.rows.map((w) => w.wdNum));
      check('rows enriched with userVerified (Wendy verified)', r.body.rows.every((w) => w.userVerified === true && w.docId), r.body.rows.map((w) => w.userVerified));
      r = await panel(APP_A, 'panelWithdrawals', { status: 'all' });
      check('status all -> 5 rows, wdNum desc', r.body.rows.length === 5 && r.body.rows[0].wdNum === 8805, r.body.rows.map((w) => w.wdNum));
      r = await panel(APP_A, 'panelWithdrawals', { status: 'weird' });
      check('bad status filter -> 400', r.status === 400, r);

      r = await panel(APP_A, 'panelWdReject', { wdNum: 8801 });
      check('reject ok', r.status === 200 && r.body.status === 'Rejected ❌', r.body);
      let w = await dbGet('withdrawals/wd_8801');
      check('record flipped Rejected with decidedAt', w.status === 'Rejected ❌' && typeof w.decidedAt === 'number', w);
      let p = await dbGet('players/700024004');
      check('NO refund: Wendy mined unchanged (5000)', p.mined === 5000, p.mined);
      r = await panel(APP_A, 'panelWdReject', { wdNum: 8801 });
      check('second reject -> 400 Already processed', r.status === 400, r);

      r = await panel(APP_A, 'panelWdBan', { wdNum: 8802 });
      check('wd-ban ok', r.status === 200 && r.body.banned === true, r.body);
      w = await dbGet('withdrawals/wd_8802');
      p = await dbGet('players/700024004');
      check('record rejected AND player banned', w.status === 'Rejected ❌' && p.banned === true, { ws: w.status, pb: p.banned });

      r = await panel(APP_A, 'panelWdApprove', { wdNum: 8804 });
      check('approve an already-paid record -> 400', r.status === 400, r);
      r = await panel(APP_A, 'panelWdApprove', { wdNum: 9999 });
      check('approve a missing record -> 404', r.status === 404, r);
      r = await panel(APP_A, 'panelWdApprove', { wdNum: 8803 });
      check('approve pays through attemptPayout: Paid / paid / chain-resolved tx', r.status === 200 && r.body.status === 'Paid ✅' && r.body.payoutState === 'paid' && r.body.payoutTx === STUB_TX_HASH, r.body);
      const s8803 = sends().filter((s) => s.comment === 'VIKING-8803');
      check('exactly one sendJetton of net 100 x 10^9 base units', s8803.length === 1 && s8803[0].amount === '100000000000', s8803);
      w = await dbGet('withdrawals/wd_8803');
      check('record Paid with payoutTx stored', w.status === 'Paid ✅' && w.payoutState === 'paid' && w.payoutTx === STUB_TX_HASH, { s: w.status, tx: w.payoutTx });
    }

    console.log('\n[A9: panelConfigGet / panelConfigSet]');
    {
      let r = await panel(APP_A, 'panelConfigGet');
      check('config get: effective + stored, taskReward default 50', r.status === 200 && r.body.config.taskReward === 50 && r.body.stored && typeof r.body.stored === 'object', { tr: r.body.config.taskReward });
      r = await panel(APP_A, 'panelConfigSet', { settings: { taskReward: 77 } });
      check('set taskReward -> applied [taskReward]', r.status === 200 && JSON.stringify(r.body.applied) === '["taskReward"]', r.body);
      r = await panel(APP_A, 'panelConfigGet');
      check('roundtrip: effective config now 77 (cache busted)', r.body.config.taskReward === 77, r.body.config.taskReward);
      const st = await api(APP_A, idPete, 'state');
      check('player state sees taskReward 77 too', st.status === 200 && st.body.settings && st.body.settings.taskReward === 77, st.body.settings && st.body.settings.taskReward);
      r = await panel(APP_A, 'panelConfigSet', { settings: { holdTaskDefs: [{ hold: 100, reward: 10 }, { hold: 200, reward: 20 }] } });
      check('valid holdTaskDefs accepted', r.status === 200 && r.body.applied.includes('holdTaskDefs'), r.body);
      r = await panel(APP_A, 'panelConfigGet');
      check('holdTaskDefs roundtrip', JSON.stringify(r.body.config.holdTaskDefs) === '[{"hold":100,"reward":10},{"hold":200,"reward":20}]', r.body.config.holdTaskDefs);
      r = await panel(APP_A, 'panelConfigSet', { settings: { holdTaskDefs: [{ hold: 200, reward: 10 }, { hold: 100, reward: 20 }] } });
      check('non-increasing holds -> 400', r.status === 400, r);
      r = await panel(APP_A, 'panelConfigSet', { settings: { holdTaskDefs: [{ hold: 100, reward: 0 }] } });
      check('zero reward tier -> 400', r.status === 400, r);
      r = await panel(APP_A, 'panelConfigSet', { settings: { evilKey: 123, taskReward: 78 } });
      check('unknown key ignored, known key applied', r.status === 200 && JSON.stringify(r.body.applied) === '["taskReward"]', r.body);
      const stored = await dbGet('settings/global');
      check('evilKey never stored; taskReward 78 stored', stored.evilKey === undefined && stored.taskReward === 78, { e: stored.evilKey, t: stored.taskReward });
      r = await panel(APP_A, 'panelConfigSet', { settings: { adminUsers: ['700024001'] } });
      check('adminUsers set', r.status === 200 && r.body.applied.includes('adminUsers'), r.body);
      await panel(APP_A, 'panelConfigSet', { settings: { adminUsers: [] } });
      r = await panel(APP_A, 'panelConfigSet', { settings: { ownerOnly: true } });
      check('ownerOnly true applied', r.status === 200 && r.body.applied.includes('ownerOnly'), r.body);
      const blocked = await api(APP_A, idPete, 'state');
      check('player gate shut during maintenance (403)', blocked.status === 403, blocked);
      r = await panel(APP_A, 'panelStats');
      check('panel still works during maintenance', r.status === 200 && r.body.ok === true, r.status);
      await panel(APP_A, 'panelConfigSet', { settings: { ownerOnly: false } });
      const open = await api(APP_A, idPete, 'state');
      check('gate reopened after ownerOnly false', open.status === 200, open.status);
      // restore the canonical hold tiers for tidiness
      await panel(APP_A, 'panelConfigSet', { settings: { holdTaskDefs: [{ hold: 1250, reward: 300 }, { hold: 2500, reward: 500 }, { hold: 5000, reward: 1000 }, { hold: 10000, reward: 1500 }, { hold: 20000, reward: 2500 }] } });
    }

    console.log('\n[A10: panel requests inbox]');
    let reqId = '';
    {
      let r = await panel(APP_A, 'panelRequestAdd', { text: 'راجع حساب اللاعب 700024001 من فضلك' });
      check('request added with an id', r.status === 200 && r.body.ok === true && typeof r.body.id === 'string' && r.body.id.length > 3, r.body);
      reqId = r.body.id;
      r = await panel(APP_A, 'panelRequestList');
      const mine = r.body.rows.find((x) => x.id === reqId);
      check('listed as new with null reply', !!mine && mine.status === 'new' && mine.reply === null && mine.text.includes('700024001'), mine);
      r = await panel(APP_A, 'panelRequestReply', { id: reqId, reply: 'تمت المراجعة — الحساب سليم' });
      check('reply ok', r.status === 200 && r.body.ok === true, r.body);
      r = await panel(APP_A, 'panelRequestList');
      const done = r.body.rows.find((x) => x.id === reqId);
      check('listed as done with the reply', !!done && done.status === 'done' && done.reply === 'تمت المراجعة — الحساب سليم' && done.repliedAt > 0, done);
      r = await panel(APP_A, 'panelRequestReply', { id: 'ghost123', reply: 'x' });
      check('reply to a ghost id -> 404', r.status === 404, r);
      r = await panel(APP_A, 'panelRequestAdd', { text: 'سطر أول\nسطر تاني' });
      const mlId = r.body.id;
      r = await panel(APP_A, 'panelRequestReply', { id: mlId, reply: 'نتيجة:\n• أول\n• تاني' });
      check('multi-line reply ok', r.status === 200 && r.body.ok === true, r.body);
      r = await panel(APP_A, 'panelRequestList');
      const ml = r.body.rows.find((x) => x.id === mlId);
      check('newlines preserved in request text and reply', !!ml && ml.text.includes('\n') && typeof ml.reply === 'string' && ml.reply.includes('\n'), ml);
      r = await panel(APP_A, 'panelRequestAdd', { text: '   ' });
      check('blank text -> 400', r.status === 400, r);
      r = await panel(APP_A, 'panelRequestAdd', {});
      check('missing text -> 400', r.status === 400, r);
    }

    console.log('\n[A11: audit log]');
    {
      const r = await panel(APP_A, 'panelAuditList');
      const actions = new Set(r.body.rows.map((e) => e.action));
      const need = ['panelBan', 'panelAdjust', 'panelSetAvatar', 'panelVerifyPlayer', 'panelVerifyResolve', 'panelWdApprove', 'panelWdReject', 'panelWdBan', 'panelConfigSet'];
      check('audit holds every consequential action', need.every((a) => actions.has(a)), [...actions]);
      check('audit rows newest first', r.body.rows.length > 1 && r.body.rows[0].at >= r.body.rows[r.body.rows.length - 1].at, r.body.rows.length);
      const adj = r.body.rows.find((e) => e.action === 'panelAdjust' && /amount 500: mined 100 -> 600/.test(e.detail));
      check('adjust entry carries amount + before/after', !!adj, r.body.rows.filter((e) => e.action === 'panelAdjust').map((e) => e.detail));
    }

    console.log('\n[A12: regression — normal player flow untouched on the keyed instance]');
    {
      const r = await api(APP_A, idPete, 'state');
      check('state still works (200, player payload)', r.status === 200 && r.body.player && r.body.player.id === '700024001', r.status);
    }

    console.log('\n[A13: panel page (Basic Auth) + failed-key lockout]');
    {
      const getRaw = async (path, headers = {}) => {
        const r = await fetch(`http://127.0.0.1:${APP_A}${path}`, { headers });
        return { status: r.status, headers: r.headers, text: await r.text() };
      };
      const basic = (u, p) => 'Basic ' + Buffer.from(u + ':' + p).toString('base64');
      let g = await getRaw('/panel');
      check('GET /panel without auth -> 401 + WWW-Authenticate', g.status === 401 && !!g.headers.get('www-authenticate'), g.status);
      g = await getRaw('/panel', { authorization: basic('owner', 'wrong-pass') });
      check('GET /panel with wrong basic password -> 401', g.status === 401, g.status);
      g = await getRaw('/panel', { authorization: basic('owner', PANEL_KEY) });
      check('GET /panel with correct basic password -> 200 panel HTML', g.status === 200 && g.text.includes('لوحة تحكم'), g.status);
      g = await getRaw('/somewhere-else');
      check('GET /somewhere-else -> 405 (unchanged)', g.status === 405, g.status);
      // Lockout: loop wrong-key panel calls until a 429 appears.
      // Earlier sections made a couple of wrong-key calls from this
      // IP (A1) and the two failed GET /panel attempts above count
      // too, while every correct-key call cleared the list — the
      // loop is robust to any of those counts: 12 tries is far past
      // the 8-failure threshold from any starting point below it.
      let saw429 = false;
      for (let i = 0; i < 12 && !saw429; i++) {
        const r = await panel(APP_A, 'panelStats', {}, 'wrong-key-' + i);
        if (r.status === 429) saw429 = true;
      }
      check('repeated wrong keys trigger the 429 lockout', saw429);
      let r = await panel(APP_A, 'panelStats', {}, 'wrong-key-again');
      check('wrong key while blocked -> still 429', r.status === 429, r.status);
      r = await panel(APP_A, 'panelStats');
      check('correct key during block -> 200 (owner bypass)', r.status === 200 && r.body.ok === true, r.status);
      const alerted = await waitFor(() => tgCalls.some((x) => x.method === 'sendMessage' && String(x.body.chat_id) === OWNER_ID && String(x.body.text || '').includes('أمني')), 10000, 'security alert').then(() => true).catch(() => false);
      check('owner received the Arabic security alert', alerted, tgCalls.filter((x) => x.method === 'sendMessage').length);
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
