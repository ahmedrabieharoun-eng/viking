/* Acceptance tests for the automatic-payout round (owner orders 2026-11-14):
 *
 *   A. Automatic $VIKING jetton payout for withdrawals (server):
 *      withdraw() keeps deducting + creating the 'Pending ⏳' record
 *      exactly as before; when PAYOUT_MNEMONIC is configured,
 *      attemptPayout() pays the NET in the $VIKING jetton under a
 *      payoutState machine on the record (none -> paying -> paid /
 *      failed). The chain layer is stubbed through the
 *      PAYOUT_STUB_MODULE env seam (a file-backed fake client shared
 *      by the spawned child and the in-process instance), and the
 *      tonapi stub serves jetton decimals = 6 (NOT 9) so the base-
 *      unit conversion is proven, not assumed.
 *
 *   B. The payout-success celebration: ONE shared
 *      sendPayoutSuccess() fired exactly once per Paid withdrawal
 *      (payoutNotifiedAt claim) from BOTH the auto path and
 *      adminWd's manual approve. Two FIXED, distinct designs
 *      (owner correction): the user DM uses payout-banner2.webp
 *      (warrior) + «💸 Your Payout is Sent!» + his short wallet; the
 *      channel post uses payout-banner.webp (treasure chest) +
 *      «🏆 New Payout!» + first name, NO wallet. BOTH carry the
 *      «View Transaction» button when a tx link resolves.
 *
 *   P1  auto-pay success: record Paid ✅ / payoutState 'paid',
 *       exactly ONE transfer of net x 10^6 base units (decimals 6),
 *       comment WD-<n>, player balance stays deducted.
 *   P2  insufficient payout-wallet jettons: NO transfer, record
 *       stays 'Pending ⏳' with payoutState 'failed', owner alerted
 *       exactly once, admin reject-refund still works afterwards.
 *   P3  broadcast throws: one attempt, 'failed', owner alerted.
 *   P4  state machine (in-process): three concurrent invocations ->
 *       ONE transfer; re-invoking a 'paid' or 'failed' record sends
 *       nothing; a 'paying' record is hands-off; a missing record
 *       is a quiet no-op.
 *   P5  mnemonic unset (child B): withdraw is byte-for-byte the old
 *       manual flow — no payoutState ever appears.
 *   P6  derivation: payoutEnabled() true with the test mnemonic;
 *       derivePayoutAddress maps it to the known V5 and V4
 *       addresses.
 *   C1  (in P1) exactly one user DM (banner2, personal caption,
 *       both buttons incl. the tonviewer tx link) + exactly one
 *       channel post (banner, public caption, NO wallet, both
 *       buttons).
 *   C2  adminWd approve on the auto-paid record: refused (400),
 *       and NOT one more celebration message.
 *   C3  channel post failing (bot not admin yet): record still
 *       Paid, DM still sent, notified stamp set, failure logged.
 *   C4  the two designs are FIXED: a second payout reuses banner2
 *       for the DM and banner for the channel, same headers.
 *   C5  (in P5, child B) manual approve celebrates identically:
 *       one DM + one channel post, tx button = the stored txLink;
 *       a second approve is refused and sends nothing more.
 *   G1  adminWd on a 'paying' record is refused (no double-pay /
 *       double-credit window).
 *
 * Run:  node test_local8.js    (ports: appA 18210, appB 18211, TG stub 18212, TON stub 18213, emu 9000)
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
const APP_A = 18210, APP_B = 18211, TG_PORT = 18212, TON_PORT = 18213;
const NS = 'demo-viking8-default-rtdb';
const EMU = `127.0.0.1:${EMU_PORT}`;
const JETTON = 'EQC6uN73kvaKh8LrTHQ8TQ5_vgqheI93iny5XUWkpQL9vjxI';
const BANNER_DM = 'https://ahmedrabieharoun-eng.github.io/viking/payout-banner2.webp';
const BANNER_CH = 'https://ahmedrabieharoun-eng.github.io/viking/payout-banner.webp';
const STUB_TX_HASH = 'ab'.repeat(32); // 64 hex chars: resolves to a tonviewer transaction URL

/* Throwaway test mnemonic (no funds, generated for this suite) and
   its known derivations — the same pair the derivation check uses. */
const TEST_MNEMONIC = 'such hip sun bronze slogan human friend swap banana nominee neither address lion spider act refuse source drastic south mail burger speak category major';
const TEST_V5 = 'EQBnzUwQNlRgVTsaKrbfaslhZP0AbED6frRwyFV7Tij1agnk';
const TEST_V4 = 'EQD5tXxGSKStC7e9nGqNY2VwOiuGtuyb_ek7sN7wTdyQYVrN';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viking-test8-'));
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const saPath = path.join(tmp, 'fake-sa.json');
fs.writeFileSync(saPath, JSON.stringify({
  type: 'service_account', project_id: 'demo-viking', private_key_id: 'fake',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  client_email: 'fake@demo-viking.iam.gserviceaccount.com', client_id: '1',
  token_uri: 'https://oauth2.googleapis.com/token'
}));

/* The file-backed payout stub: behaviour is driven by a JSON state
   file (flippable between scenarios), every sendJetton call is
   appended to a JSONL log. Shared verbatim by child A and the
   in-process instance through the PAYOUT_STUB_MODULE env seam. */
const STUB_STATE = path.join(tmp, 'payout-state.json');
const STUB_LOG = path.join(tmp, 'payout-sends.jsonl');
const STUB_MODULE = path.join(tmp, 'payout-stub.js');
fs.writeFileSync(STUB_MODULE, `
const fs = require('fs');
function readState() { try { return JSON.parse(fs.readFileSync(process.env.PAYOUT_STUB_STATE, 'utf8')); } catch (e) { return {}; } }
exports.createPayoutClient = async () => ({
  addressRaw: '0:67cd4c10365460553b1a2ab6df6ac96164fd006c40fa7eb470c8557b4e28f56a',
  addressFriendly: '${TEST_V5}',
  async getTonBalance() { return BigInt(readState().tonBalanceNano || '5000000000'); },
  async getJettonBalance() { return BigInt(readState().jettonBalanceBase || '0'); },
  async sendJetton({ toRaw, amount, comment }) {
    const st = readState();
    if (st.sendDelayMs) await new Promise((r) => setTimeout(r, Number(st.sendDelayMs)));
    fs.appendFileSync(process.env.PAYOUT_STUB_LOG, JSON.stringify({ toRaw, amount: amount.toString(), comment }) + '\\n');
    if (st.sendBehavior === 'throw') throw new Error('stub broadcast boom');
    return { seqno: 7, txHash: '${STUB_TX_HASH}' };
  }
});
`);
const setStub = (o) => fs.writeFileSync(STUB_STATE, JSON.stringify(o));
const RICH = { jettonBalanceBase: '1000000000000', sendBehavior: 'ok' }; // 1e12 base units = 1,000,000 coins at 6 decimals
setStub(RICH);
fs.writeFileSync(STUB_LOG, '');
const sends = () => fs.readFileSync(STUB_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const sendsFor = (comment) => sends().filter((s) => s.comment === comment);

process.env.BOT_TOKEN = BOT_TOKEN;
process.env.OWNER_ID = OWNER_ID;
process.env.ALLOWED_ORIGIN = '*';
process.env.FIREBASE_DATABASE_URL = `http://${EMU}?ns=${NS}`;
process.env.FIREBASE_DATABASE_EMULATOR_HOST = EMU;
process.env.GOOGLE_APPLICATION_CREDENTIALS = saPath;
process.env.TG_API_BASE = `http://127.0.0.1:${TG_PORT}`;
process.env.TON_API_BASE = `http://127.0.0.1:${TON_PORT}/v3`;
process.env.TONAPI_BASE = `http://127.0.0.1:${TON_PORT}/tonapi`;
process.env.VERIFY_WATCH_MS = '0';
process.env.PAYOUT_MNEMONIC = TEST_MNEMONIC;
process.env.PAYOUT_STUB_MODULE = STUB_MODULE;
process.env.PAYOUT_STUB_STATE = STUB_STATE;
process.env.PAYOUT_STUB_LOG = STUB_LOG;

function envFor(extra, remove) {
  const env = { ...process.env };
  for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'NODE_USE_ENV_PROXY']) delete env[k];
  for (const k of remove || []) delete env[k];
  return { ...env, ...extra };
}

/* ---------- signed Telegram initData (same scheme as the other suites) ---------- */
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
const OWNER_INIT = () => makeInitData({ id: Number(OWNER_ID), first_name: 'Owner', username: 'theowner' });
const userInit = (id, firstName, username) => makeInitData({ id: Number(id), first_name: firstName, username });

/* ---------- Telegram stub (getMe + capture; the payouts channel can be made to fail) ---------- */
const sentMessages = [];
const sentPhotos = [];
let failChannel = false;
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
    if (failChannel && String(body.chat_id) === '@VIKING_PAYOUT' && (method === 'sendPhoto' || method === 'sendMessage')) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }));
    }
    if (method === 'sendMessage') sentMessages.push(body);
    if (method === 'sendPhoto') sentPhotos.push(body);
    return res.end(JSON.stringify({ ok: true, result: { message_id: sentMessages.length + sentPhotos.length } }));
  });
});

/* ---------- TON stub (tonapi shapes only; jetton decimals = 6 on purpose) ---------- */
const tonStub = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const u = req.url || '';
  if (/\/tonapi\/accounts\/[^/]+\/jettons\/[^/]+$/.test(u)) {
    // jettonHold's source: balance in base units + ITS jetton.decimals
    return res.end(JSON.stringify({ balance: '10000000000', wallet_address: { address: '0:00' }, jetton: { address: JETTON, decimals: 6, symbol: 'VIKING' } }));
  }
  if (/\/tonapi\/jettons\/[^/]+$/.test(u)) {
    // jettonDecimals' source: tonapi jetton info, metadata.decimals as a string
    return res.end(JSON.stringify({ total_supply: '0', metadata: { name: '$VIKING', symbol: 'VIKING', decimals: '6' } }));
  }
  res.statusCode = 404;
  return res.end(JSON.stringify({ error: 'stub: unknown path ' + u }));
});

/* ---------- tiny assertion kit + http/db helpers ---------- */
let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS', name); }
  else { failed++; console.log('  FAIL', name, extra !== undefined ? '-> ' + JSON.stringify(extra) : ''); }
}
async function apiOn(port, initData, action, body = {}) {
  const r = await fetch(`http://127.0.0.1:${port}/`, {
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
  for (const p of ['players', 'withdrawals', 'settings', 'meta', 'sigs', 'wallets', 'deviceIds', 'devices', 'premiumEmoji', 'verifyClaims']) {
    await fetch(`http://${EMU}/${p}.json?ns=${NS}`, { method: 'DELETE' });
  }
}
function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try { if (await fn()) return resolve(); } catch (e) { /* retry */ }
      if (Date.now() - t0 > timeoutMs) return reject(new Error('timeout waiting for ' + label));
      setTimeout(tick, 300);
    };
    tick();
  });
}
const photosTo = (id) => sentPhotos.filter((m) => String(m.chat_id) === String(id));
const msgsTo = (id) => sentMessages.filter((m) => String(m.chat_id) === String(id));
const allTo = (id) => [...photosTo(id), ...msgsTo(id)];
const kbUrls = (m) => (((m.reply_markup || {}).inline_keyboard || [])).flat().map((b) => b.url || '');
const kbTexts = (m) => (((m.reply_markup || {}).inline_keyboard || [])).flat().map((b) => String(b.text || ''));
const RAW = (ch) => '0:' + ch.repeat(64).slice(0, 64);
async function seedPlayer(id, name, username, mined, walletRaw) {
  const now = Date.now();
  await dbPut('players/' + id, {
    id, name, username, mined, referrals: [], walletAddr: walletRaw,
    banned: false, lastSeen: now, createdAt: now, lastWithdrawTime: 0
  });
}
async function doWithdraw(port, id, name, username) {
  const r = await apiOn(port, userInit(id, name, username), 'withdraw', { amount: 5000 });
  check(`withdraw accepted for ${name}`, r.status === 200 && !!r.body && r.body.success === true, r);
  return r.body.wdNum;
}

(async () => {
  const children = [];
  let outA = '', outB = '';
  try {
    const emuUp = await fetch(`http://${EMU}/.json?ns=${NS}`).then(() => true).catch(() => false);
    if (!emuUp) throw new Error('RTDB emulator is not listening on 127.0.0.1:9000 — start it first');
    await dbWipe();
    await dbPut('settings/global', { channel2: 'https://t.me/VIKING_PAYOUT' }); // config cache in every instance reads this
    await new Promise((r) => tgStub.listen(TG_PORT, '127.0.0.1', r));
    await new Promise((r) => tonStub.listen(TON_PORT, '127.0.0.1', r));

    /* ---------- P6: derivation + enablement (in-process instance) ---------- */
    console.log('\n[P6: payout derivation + payoutEnabled]');
    const srv = require('./index.js');
    check('payoutEnabled() is true with a 24-word mnemonic', srv.payoutEnabled() === true);
    const words = TEST_MNEMONIC.split(/\s+/);
    const a5 = await srv.derivePayoutAddress(words, 'v5');
    const a4 = await srv.derivePayoutAddress(words, 'v4');
    check('test mnemonic derives the known V5R1 address', a5.toString() === TEST_V5, a5.toString());
    check('test mnemonic derives the known V4 address', a4.toString() === TEST_V4, a4.toString());
    check('v5 raw form matches the known raw address', a5.toRawString() === '0:67cd4c10365460553b1a2ab6df6ac96164fd006c40fa7eb470c8557b4e28f56a', a5.toRawString());

    /* ---------- spawn child A (payout enabled via stub) + child B (disabled) ---------- */
    const spawnSvc = (port, extra, remove) => {
      const ch = spawn(path.join(__dirname, 'node_modules', '.bin', 'functions-framework'),
        ['--target=collectMining', '--port=' + port], { cwd: __dirname, env: envFor(extra, remove), stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(ch);
      return ch;
    };
    const childA = spawnSvc(APP_A, {}, []);
    childA.stdout.on('data', (d) => (outA += d));
    childA.stderr.on('data', (d) => (outA += d));
    const childB = spawnSvc(APP_B, {}, ['PAYOUT_MNEMONIC', 'PAYOUT_STUB_MODULE']);
    childB.stdout.on('data', (d) => (outB += d));
    childB.stderr.on('data', (d) => (outB += d));
    await waitFor(async () => (await fetch(`http://127.0.0.1:${APP_A}/`)).status === 405, 30000, 'server A');
    await waitFor(async () => (await fetch(`http://127.0.0.1:${APP_B}/`)).status === 405, 30000, 'server B');
    await waitFor(async () => outA.includes('[payout] wallet ' + TEST_V5), 15000, 'child A payout boot line');
    check('boot line (enabled): [payout] wallet <the derived V5 address> | TON <bal> | VIKING <bal>',
      outA.includes(`[payout] wallet ${TEST_V5} | TON 5.0000 | VIKING 1,000,000`), outA.split('\n').filter((l) => l.includes('[payout]')));
    await waitFor(async () => outB.includes('[payout] disabled (PAYOUT_MNEMONIC not set)'), 15000, 'child B payout boot line');
    check('boot line (disabled): [payout] disabled (PAYOUT_MNEMONIC not set)', outB.includes('[payout] disabled (PAYOUT_MNEMONIC not set)'));

    /* ---------- P1 + C1: auto-pay success + the celebration ---------- */
    console.log('\n[P1+C1: auto-pay success — one transfer, Paid record, one DM + one channel post]');
    const U1 = '700009001', W1 = RAW('1');
    await seedPlayer(U1, 'Zayd Rich', 'zaydrich', 20000, W1);
    const n1 = await doWithdraw(APP_A, U1, 'Zayd', 'zaydrich');
    await waitFor(async () => { const w = await dbGet('withdrawals/wd_' + n1); return w && w.payoutState === 'paid'; }, 20000, 'wd ' + n1 + ' paid');
    const wd1 = await dbGet('withdrawals/wd_' + n1);
    check('record flipped to Paid ✅ with payoutState paid', wd1.status === 'Paid ✅' && wd1.payoutState === 'paid', wd1);
    check('payoutTx is the broadcast hash, payoutAt stamped', wd1.payoutTx === STUB_TX_HASH && typeof wd1.payoutAt === 'number', wd1);
    const s1 = sendsFor('WD-' + n1);
    check('exactly ONE jetton transfer for this withdrawal', s1.length === 1, s1);
    check('transfer amount = net 4750 x 10^6 base units (decimals 6, not 9)', s1.length === 1 && s1[0].amount === '4750000000', s1);
    check('transfer went to the player bound wallet', s1.length === 1 && s1[0].toRaw === W1, s1);
    const p1 = await dbGet('players/' + U1);
    check('player mined stays deducted (20000 - 5000)', p1.mined === 15000, p1.mined);
    await waitFor(async () => photosTo(U1).length === 1 && photosTo('@VIKING_PAYOUT').length === 1, 15000, 'wd ' + n1 + ' celebration messages');
    const wd1b = await dbGet('withdrawals/wd_' + n1);
    check('payoutNotifiedAt claimed (celebration exactly-once stamp)', typeof wd1b.payoutNotifiedAt === 'number', wd1b);
    const dm1 = photosTo(U1);
    check('exactly one user DM, and it is a photo', dm1.length === 1 && msgsTo(U1).length === 0, { photos: dm1.length, msgs: msgsTo(U1).length });
    const cap1 = (dm1[0] && dm1[0].caption) || '';
    check('DM uses the WARRIOR banner (payout-banner2.webp)', dm1.length === 1 && dm1[0].photo === BANNER_DM, dm1[0] && dm1[0].photo);
    check('DM is the personal design: «Your Payout is Sent!» + amount + WD number + his short wallet',
      cap1.includes('Your Payout is Sent!') && cap1.includes('4,750') && cap1.includes('$VIKING') && cap1.includes('Withdrawal #' + n1) && cap1.includes('Wallet:'), cap1);
    check('DM buttons: Open VIKING (/app) + View Transaction (tonviewer hash link)',
      kbUrls(dm1[0] || {}).includes('https://t.me/TestVikingBot/app') && kbUrls(dm1[0] || {}).includes('https://tonviewer.com/transaction/' + STUB_TX_HASH) &&
      kbTexts(dm1[0] || {}).some((t) => t.includes('Open VIKING')) && kbTexts(dm1[0] || {}).some((t) => t.includes('View Transaction')),
      (dm1[0] || {}).reply_markup);
    const ch1 = photosTo('@VIKING_PAYOUT');
    check('exactly one channel post, and it is a photo', ch1.length === 1 && msgsTo('@VIKING_PAYOUT').length === 0, { photos: ch1.length, msgs: msgsTo('@VIKING_PAYOUT').length });
    const ccap1 = (ch1[0] && ch1[0].caption) || '';
    check('channel uses the TREASURE banner (payout-banner.webp)', ch1.length === 1 && ch1[0].photo === BANNER_CH, ch1[0] && ch1[0].photo);
    check('channel is the public design: «New Payout!» + FULL name + amount + WD number',
      ccap1.includes('New Payout!') && ccap1.includes('<b>Zayd Rich</b>') && ccap1.includes('4,750') && ccap1.includes('Withdrawal #' + n1), ccap1);
    check('channel post carries NO wallet', !ccap1.includes('Wallet:') && !ccap1.includes(W1), ccap1);
    check('channel buttons: Start Mining Now (/app) + View Transaction',
      kbUrls(ch1[0] || {}).includes('https://t.me/TestVikingBot/app') && kbUrls(ch1[0] || {}).includes('https://tonviewer.com/transaction/' + STUB_TX_HASH) &&
      kbTexts(ch1[0] || {}).some((t) => t.includes('Start Mining Now')) && kbTexts(ch1[0] || {}).some((t) => t.includes('View Transaction')),
      (ch1[0] || {}).reply_markup);
    check('the two designs are distinct (different image + different header)', dm1[0].photo !== ch1[0].photo && !cap1.includes('New Payout!') && !ccap1.includes('Your Payout is Sent!'));

    /* ---------- C2: admin approve on the auto-paid record ---------- */
    console.log('\n[C2: adminWd approve on the auto-paid record — refused, nothing more sent]');
    {
      const dmBefore = allTo(U1).length, chBefore = allTo('@VIKING_PAYOUT').length;
      const r = await apiOn(APP_A, OWNER_INIT(), 'adminWd', { docId: 'wd_' + n1, decision: 'approve', txHash: '' });
      check('approve on a payoutState=paid record -> 400 Already processed', r.status === 400, r);
      check('no further DM / channel post after the refused approve', allTo(U1).length === dmBefore && allTo('@VIKING_PAYOUT').length === chBefore);
    }

    /* ---------- P2: insufficient jetton balance ---------- */
    console.log('\n[P2: insufficient payout-wallet jettons — no transfer, stays Pending, owner alerted once]');
    const U2 = '700009002', W2 = RAW('2');
    await seedPlayer(U2, 'Mona Poor', 'monapoor', 20000, W2);
    setStub({ jettonBalanceBase: '1000', sendBehavior: 'ok' });
    const alertsBefore = msgsTo(OWNER_ID).filter((m) => String(m.text || '').includes('فشل الدفع التلقائي')).length;
    const n2 = await doWithdraw(APP_A, U2, 'Mona', 'monapoor');
    await waitFor(async () => { const w = await dbGet('withdrawals/wd_' + n2); return w && w.payoutState === 'failed'; }, 20000, 'wd ' + n2 + ' failed');
    const wd2 = await dbGet('withdrawals/wd_' + n2);
    check('record stays Pending ⏳ with payoutState failed + reason', wd2.status === 'Pending ⏳' && wd2.payoutState === 'failed' && String(wd2.payoutError || '').includes('insufficient jetton balance'), wd2);
    check('NO transfer was broadcast', sendsFor('WD-' + n2).length === 0, sendsFor('WD-' + n2));
    const alerts2 = msgsTo(OWNER_ID).filter((m) => String(m.text || '').includes('فشل الدفع التلقائي') && String(m.text || '').includes('#' + n2));
    check('owner alerted exactly once, naming the withdrawal', alerts2.length === 1, alerts2.length);
    const p2 = await dbGet('players/' + U2);
    check('player balance stays deducted (no automatic re-credit)', p2.mined === 15000, p2.mined);
    check('no celebration for a failed payout', allTo(U2).length === 0 && photosTo('@VIKING_PAYOUT').length === 1);
    {
      const r = await apiOn(APP_A, OWNER_INIT(), 'adminWd', { docId: 'wd_' + n2, decision: 'reject' });
      check('manual reject-refund still works on a failed record', r.status === 200, r);
      const p2b = await dbGet('players/' + U2);
      check('reject refunded the full amount', p2b.mined === 20000, p2b.mined);
      void alertsBefore;
    }

    /* ---------- P3: broadcast throws ---------- */
    console.log('\n[P3: broadcast throws — one attempt, failed, owner alerted]');
    const U3 = '700009003', W3 = RAW('3');
    await seedPlayer(U3, 'Omar Unlucky', 'omarunlucky', 20000, W3);
    setStub({ jettonBalanceBase: '1000000000000', sendBehavior: 'throw' });
    const n3 = await doWithdraw(APP_A, U3, 'Omar', 'omarunlucky');
    await waitFor(async () => { const w = await dbGet('withdrawals/wd_' + n3); return w && w.payoutState === 'failed'; }, 20000, 'wd ' + n3 + ' failed');
    const wd3 = await dbGet('withdrawals/wd_' + n3);
    check('record stays Pending ⏳, payoutError carries the broadcast failure', wd3.status === 'Pending ⏳' && String(wd3.payoutError || '').includes('stub broadcast boom'), wd3);
    check('exactly one broadcast attempt was made', sendsFor('WD-' + n3).length === 1, sendsFor('WD-' + n3));
    const alerts3 = msgsTo(OWNER_ID).filter((m) => String(m.text || '').includes('فشل الدفع التلقائي') && String(m.text || '').includes('#' + n3));
    check('owner alerted exactly once for the throw', alerts3.length === 1, alerts3.length);
    setStub(RICH);

    /* ---------- C3: channel post fails (bot not admin yet) ---------- */
    console.log('\n[C3: channel post failing — payout unaffected, DM sent, failure logged]');
    const U4 = '700009004', W4 = RAW('4');
    await seedPlayer(U4, 'Sara Quiet', 'saraquiet', 20000, W4);
    failChannel = true;
    const n4 = await doWithdraw(APP_A, U4, 'Sara', 'saraquiet');
    await waitFor(async () => { const w = await dbGet('withdrawals/wd_' + n4); return w && w.payoutState === 'paid'; }, 20000, 'wd ' + n4 + ' paid');
    const wd4 = await dbGet('withdrawals/wd_' + n4);
    check('record is Paid ✅ despite the channel failure', wd4.status === 'Paid ✅' && typeof wd4.payoutNotifiedAt === 'number', wd4);
    await waitFor(async () => photosTo(U4).length === 1, 15000, 'wd ' + n4 + ' user DM');
    check('the user DM still landed (warrior banner photo)', photosTo(U4).length === 1 && photosTo(U4)[0].photo === BANNER_DM, photosTo(U4));
    check('no channel post was captured while failing', photosTo('@VIKING_PAYOUT').length === 1 && msgsTo('@VIKING_PAYOUT').length === 0);
    await waitFor(async () => outA.includes('payout channel post failed'), 10000, 'channel failure log line');
    check('the failure was logged as «payout channel post failed»', outA.includes('payout channel post failed'));
    failChannel = false;

    /* ---------- C4: the designs are FIXED across payouts ---------- */
    console.log('\n[C4: a second payout reuses the same two fixed designs]');
    const U5 = '700009005', W5 = RAW('5');
    await seedPlayer(U5, 'Karim Fixed', 'karimfixed', 20000, W5);
    const n5 = await doWithdraw(APP_A, U5, 'Karim', 'karimfixed');
    await waitFor(async () => { const w = await dbGet('withdrawals/wd_' + n5); return w && w.payoutState === 'paid'; }, 20000, 'wd ' + n5 + ' paid');
    await waitFor(async () => photosTo(U5).length === 1 && photosTo('@VIKING_PAYOUT').length === 2, 15000, 'wd ' + n5 + ' celebration messages');
    const dm5 = photosTo(U5)[0] || {};
    const ch5 = photosTo('@VIKING_PAYOUT').slice(-1)[0] || {};
    check('second DM: same warrior banner + same personal header', dm5.photo === BANNER_DM && String(dm5.caption || '').includes('Your Payout is Sent!'), dm5);
    check('second channel post: same treasure banner + same public header', ch5.photo === BANNER_CH && String(ch5.caption || '').includes('New Payout!'), ch5);

    /* ---------- P4: the state machine under concurrency / re-invocation (in-process) ---------- */
    console.log('\n[P4: attemptPayout state machine — concurrency, re-invoke, hands-off states]');
    const seedWd = async (num, extra) => dbPut('withdrawals/wd_' + num, {
      wdNum: num, userId: '700009101', userName: 'State Machine', walletAddr: RAW('9'),
      amt: 5000, net: 4750, fee: 250, status: 'Pending ⏳', timestamp: Date.now(), ...extra
    });
    await seedWd(9001, {});
    setStub({ jettonBalanceBase: '1000000000000', sendBehavior: 'ok', sendDelayMs: 700 });
    await Promise.all([srv.attemptPayout(9001), srv.attemptPayout(9001), srv.attemptPayout(9001)]);
    const wd9001 = await dbGet('withdrawals/wd_9001');
    check('three concurrent invocations -> exactly ONE transfer', sendsFor('WD-9001').length === 1, sendsFor('WD-9001'));
    check('the record completed exactly once (Paid / paid / notified)', wd9001.status === 'Paid ✅' && wd9001.payoutState === 'paid' && typeof wd9001.payoutNotifiedAt === 'number', wd9001);
    await srv.attemptPayout(9001);
    check('re-invoking a paid record broadcasts nothing more', sendsFor('WD-9001').length === 1);
    await seedWd(9002, {});
    setStub({ jettonBalanceBase: '1000000000000', sendBehavior: 'throw' });
    await srv.attemptPayout(9002);
    const wd9002a = await dbGet('withdrawals/wd_9002');
    check('a throwing attempt lands in failed', wd9002a.payoutState === 'failed', wd9002a);
    await srv.attemptPayout(9002);
    check('a failed record is never auto-retried (still one attempt)', sendsFor('WD-9002').length === 1 && (await dbGet('withdrawals/wd_9002')).payoutState === 'failed');
    await seedWd(9003, { payoutState: 'paying', payoutAttemptAt: Date.now() });
    setStub(RICH);
    await srv.attemptPayout(9003);
    const wd9003 = await dbGet('withdrawals/wd_9003');
    check('a paying record is hands-off (untouched, no send)', wd9003.payoutState === 'paying' && !wd9003.payoutAt && sendsFor('WD-9003').length === 0, wd9003);
    await srv.attemptPayout(977777);
    check('a missing record is a quiet no-op', sendsFor('WD-977777').length === 0);

    /* ---------- G1: adminWd refuses a 'paying' record ---------- */
    console.log('\n[G1: adminWd on a payoutState=paying record — refused]');
    {
      const r = await apiOn(APP_A, OWNER_INIT(), 'adminWd', { docId: 'wd_9003', decision: 'approve', txHash: '' });
      check('approve on a paying record -> 400 Already processed', r.status === 400, r);
      const after = await dbGet('withdrawals/wd_9003');
      check('the paying record is unchanged by the refused decision', after.payoutState === 'paying' && after.status === 'Pending ⏳', after);
    }

    /* ---------- P5 + C5: payout disabled — manual flow + manual celebration ---------- */
    console.log('\n[P5+C5: mnemonic unset — old manual flow, and admin approve celebrates identically]');
    const U6 = '700009006', W6 = RAW('6');
    await seedPlayer(U6, 'Laila Manual', 'lailamanual', 20000, W6);
    const n6 = await doWithdraw(APP_B, U6, 'Laila', 'lailamanual');
    await new Promise((r) => setTimeout(r, 800)); // give any (non-existent) async payout time to betray itself
    const wd6a = await dbGet('withdrawals/wd_' + n6);
    check('disabled: record is exactly the old shape — Pending, NO payoutState at all',
      wd6a.status === 'Pending ⏳' && !('payoutState' in wd6a) && !('payoutNotifiedAt' in wd6a), wd6a);
    check('disabled: no transfer, no celebration yet', sendsFor('WD-' + n6).length === 0 && allTo(U6).length === 0);
    const chBefore6 = allTo('@VIKING_PAYOUT').length;
    const r6 = await apiOn(APP_B, OWNER_INIT(), 'adminWd', { docId: 'wd_' + n6, decision: 'approve', txHash: '' });
    check('manual approve succeeds', r6.status === 200, r6);
    const wd6 = await dbGet('withdrawals/wd_' + n6);
    check('manual record is Paid ✅ + notified stamp claimed', wd6.status === 'Paid ✅' && typeof wd6.payoutNotifiedAt === 'number', wd6);
    const dm6 = photosTo(U6);
    check('manual approve sends exactly one DM (warrior banner, personal design)',
      dm6.length === 1 && dm6[0].photo === BANNER_DM && String(dm6[0].caption || '').includes('Your Payout is Sent!') && String(dm6[0].caption || '').includes('Withdrawal #' + n6), dm6);
    check('manual DM tx button uses the txLink adminWd stored (wallet link, no hash given)',
      kbUrls(dm6[0] || {}).includes('https://tonviewer.com/' + encodeURIComponent(W6)), (dm6[0] || {}).reply_markup);
    check('manual approve posts exactly one channel proof (treasure banner, public design, tx button too)',
      allTo('@VIKING_PAYOUT').length === chBefore6 + 1 &&
      photosTo('@VIKING_PAYOUT').slice(-1)[0].photo === BANNER_CH &&
      String(photosTo('@VIKING_PAYOUT').slice(-1)[0].caption || '').includes('New Payout!') &&
      kbUrls(photosTo('@VIKING_PAYOUT').slice(-1)[0]).includes('https://tonviewer.com/' + encodeURIComponent(W6)),
      photosTo('@VIKING_PAYOUT').slice(-1)[0]);
    const r6b = await apiOn(APP_B, OWNER_INIT(), 'adminWd', { docId: 'wd_' + n6, decision: 'approve', txHash: '' });
    check('a second approve is refused', r6b.status === 400, r6b);
    check('the refused second approve sent nothing more', allTo(U6).length === 1 && allTo('@VIKING_PAYOUT').length === chBefore6 + 1);
  } finally {
    tgStub.close();
    tonStub.close();
    for (const ch of children) { try { ch.kill('SIGKILL'); } catch (e) { /* already dead */ } }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
