'use strict';
/* Acceptance tests for the MANUAL WITHDRAWAL REVIEW round (owner
 * order 2026-11-14 ~07:29): automatic payout-on-request is replaced
 * by the owner's AdVOLT-style review panel in the bot chat.
 *
 *   (i) Earnings counters earnMining / earnDaily / earnTasks /
 *       earnRef increment inside the SAME transactions that credit
 *       mined, by the exact credited amounts (collect 250, daily 10,
 *       channel task 50, bio task 50, refCollect 70, refAch 50).
 *   (a) withdraw() creates a 'Pending ⏳' record, performs NO
 *       transfer, and DMs the owner a review card with the full
 *       picture (amounts + fee + net, FULL friendly wallet,
 *       verification verdict + date, wallet age, balance after the
 *       deduction, join age, inviter, referral totals with the
 *       state() active-referral rule, the LIVE on-chain hold, the
 *       multi-account cluster, earnings sources, previous
 *       withdrawals) and the 4 decision buttons.
 *   (b) /withdrawals from a non-owner does nothing at all; from the
 *       owner it starts a session and presents the FIRST pending
 *       card with position text («— سحب 1 من 1»).
 *   (c) ✅ approve (wdok callback) fires the EXISTING attemptPayout:
 *       exactly one transfer (comment VIKING-<n>, net in base
 *       units), record Paid ✅, owner follow-up with the tonviewer
 *       tx link, celebration DM to the player, session summary.
 *   (d) ❌ reject (wdno) flips the record to 'Rejected ❌' with NO
 *       refund (deducted coins stay deducted — the owner's explicit
 *       order), stamps decidedAt, edits the card and sends the
 *       separate owner confirmation.
 *   (e) 🚫 ban (wdban) additionally sets player.banned = true.
 *   (f) A callback from a non-owner is answered with the owner-only
 *       alert and changes nothing.
 *   (g) Deciding twice: the second approve is a no-op answered
 *       «اتقرر في السحب ده خلاص», still exactly one transfer.
 *   (h)+(j) ⏭ skip leaves the record untouched and advances the
 *       session walk; the end-of-queue summary counts match the
 *       decisions made (متخطى / مرفوض / مدفوع / محظور).
 *   (k) Approve on a server WITHOUT PAYOUT_MNEMONIC answers the
 *       «مش مفعّل» alert and leaves the record Pending.
 *
 * Harness mirrors test_local8.js: two spawned children (functions-
 * framework) sharing one RTDB namespace on the 127.0.0.1:9000
 * emulator; child A is payout-enabled through the file-backed stub
 * module, child B has the mnemonic removed. Telegram is stubbed
 * (sendMessage / sendPhoto / editMessageText /
 * answerCallbackQuery / getMe / getChatMember / getChat) and
 * tonapi serves jetton decimals = 6 with a 10,000-coin hold for
 * every wallet. Webhook updates (messages + callback_query) are
 * driven through the real POST / route with the bot-token secret
 * header, exactly as Telegram delivers them.
 *
 * Run:  node test_local9.js    (ports: appA 18220, appB 18221, TG stub 18222, TON stub 18223, emu 9000)
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
const APP_A = 18220, APP_B = 18221, TG_PORT = 18222, TON_PORT = 18223;
const NS = 'demo-viking9-default-rtdb';
const EMU = `127.0.0.1:${EMU_PORT}`;
const JETTON = 'EQC6uN73kvaKh8LrTHQ8TQ5_vgqheI93iny5XUWkpQL9vjxI';
const STUB_TX_HASH = 'ab'.repeat(32);
const BOGUS_LOCAL_HASH = 'cd'.repeat(32);
const TEST_MNEMONIC = 'such hip sun bronze slogan human friend swap banana nominee neither address lion spider act refuse source drastic south mail burger speak category major';
const TEST_V5 = 'EQBnzUwQNlRgVTsaKrbfaslhZP0AbED6frRwyFV7Tij1agnk';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viking-test9-'));
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const saPath = path.join(tmp, 'fake-sa.json');
fs.writeFileSync(saPath, JSON.stringify({
  type: 'service_account', project_id: 'demo-viking', private_key_id: 'fake',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  client_email: 'fake@demo-viking.iam.gserviceaccount.com', client_id: '1',
  token_uri: 'https://oauth2.googleapis.com/token'
}));

/* File-backed payout stub — the exact seam test_local8 uses. */
const STUB_STATE = path.join(tmp, 'payout-state.json');
const STUB_LOG = path.join(tmp, 'payout-sends.jsonl');
const FIND_LOG = path.join(tmp, 'payout-finds.jsonl');
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
    return { seqno: 7, txHash: '${BOGUS_LOCAL_HASH}' };
  },
  async findTransferTx({ comment, toRaw, amountBase, sinceMs }) {
    const st = readState();
    fs.appendFileSync(process.env.PAYOUT_STUB_FINDLOG, JSON.stringify({ comment, toRaw, amountBase: amountBase.toString(), sinceMs }) + String.fromCharCode(10));
    if (st.findBehavior === 'null') return null;
    return '${STUB_TX_HASH}';
  }
});
`);
const setStub = (o) => fs.writeFileSync(STUB_STATE, JSON.stringify(o));
const RICH = { jettonBalanceBase: '1000000000000', sendBehavior: 'ok' };
setStub(RICH);
fs.writeFileSync(STUB_LOG, '');
fs.writeFileSync(FIND_LOG, '');
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
process.env.PAYOUT_STUB_FINDLOG = FIND_LOG;

function envFor(extra, remove) {
  const env = { ...process.env };
  for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'NODE_USE_ENV_PROXY']) delete env[k];
  for (const k of remove || []) delete env[k];
  return { ...env, ...extra };
}

/* ---------- signed Telegram initData ---------- */
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
const userInit = (id, firstName, username) => makeInitData({ id: Number(id), first_name: firstName, username });

/* ---------- Telegram stub (capture incl. edits + callback answers) ---------- */
const sentMessages = [];
const sentPhotos = [];
const edits = [];
const answers = [];
let midSeq = 5000;
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
    if (method === 'getChatMember') return res.end(JSON.stringify({ ok: true, result: { status: 'member', user: { id: Number(body.user_id) || 1 } } }));
    if (method === 'getChat') return res.end(JSON.stringify({ ok: true, result: { id: Number(body.chat_id) || 1, type: 'private', bio: 'Proud member of @TestVikingBot club' } }));
    if (method === 'sendMessage') { body._mid = ++midSeq; sentMessages.push(body); return res.end(JSON.stringify({ ok: true, result: { message_id: body._mid } })); }
    if (method === 'sendPhoto') { body._mid = ++midSeq; sentPhotos.push(body); return res.end(JSON.stringify({ ok: true, result: { message_id: body._mid } })); }
    if (method === 'editMessageText') { edits.push(body); return res.end(JSON.stringify({ ok: true, result: true })); }
    if (method === 'answerCallbackQuery') { answers.push(body); return res.end(JSON.stringify({ ok: true, result: true })); }
    return res.end(JSON.stringify({ ok: true, result: true }));
  });
});

/* ---------- TON stub (tonapi shapes only; decimals = 6; hold = 10,000 coins) ---------- */
const tonStub = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const u = req.url || '';
  if (/\/tonapi\/accounts\/[^/]+\/jettons\/[^/]+$/.test(u)) {
    return res.end(JSON.stringify({ balance: '10000000000', wallet_address: { address: '0:00' }, jetton: { address: JETTON, decimals: 6, symbol: 'VIKING' } }));
  }
  if (/\/tonapi\/jettons\/[^/]+$/.test(u)) {
    return res.end(JSON.stringify({ total_supply: '0', metadata: { name: '$VIKING', symbol: 'VIKING', decimals: '6' } }));
  }
  res.statusCode = 404;
  return res.end(JSON.stringify({ error: 'stub: unknown path ' + u }));
});

/* ---------- assertion kit + http/db helpers ---------- */
let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS', name); }
  else { failed++; console.log('  FAIL', name, extra !== undefined ? '-> ' + JSON.stringify(extra) : ''); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  for (const p of ['players', 'withdrawals', 'settings', 'meta', 'sigs', 'wallets', 'deviceIds', 'devices', 'premiumEmoji', 'verifyClaims', 'counters']) {
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
const ownerMsgsWith = (s) => msgsTo(OWNER_ID).filter((m) => String(m.text || '').includes(s));
const ownerCardsFor = (n) => msgsTo(OWNER_ID).filter((m) => String(m.text || '').includes('طلب سحب #' + n));
const cardButtons = (card) => (((card.reply_markup || {}).inline_keyboard || [])).flat().map((b) => b.callback_data);
const RAW = (ch) => '0:' + ch.repeat(64).slice(0, 64);
const lastAnswer = () => answers[answers.length - 1] || {};

async function seedPlayer(id, extra) {
  const now = Date.now();
  await dbPut('players/' + id, {
    id, name: 'Player ' + id, username: '', mined: 0, referrals: [], walletAddr: null,
    banned: false, lastSeen: now, createdAt: now, lastWithdrawTime: 0, lastCollectTime: 0,
    lastDailyCheckIn: 0, dailyStreak: 0, tasksClaimed: {}, bioTaskDone: false,
    pendingRefComm: 0, refCommissionEarned: 0, earnMining: 0, earnDaily: 0, earnTasks: 0, earnRef: 0,
    ...(extra || {})
  });
}
async function doWithdraw(port, id, name, username) {
  const r = await apiOn(port, userInit(id, name, username), 'withdraw', { amount: 5000 });
  check(`withdraw accepted for ${name}`, r.status === 200 && !!r.body && r.body.success === true, r);
  return r.body.wdNum;
}

/* ---------- webhook drivers (messages + review-card button taps) ---------- */
const WEBHOOK_SECRET = crypto
  .createHash('sha256')
  .update(BOT_TOKEN)
  .digest('hex')
  .substring(0, 32);
let updSeq = 900000;
async function botPost(port, upd) {
  const r = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
    body: JSON.stringify(upd)
  });
  return r.status;
}
async function botMessage(port, fromId, text) {
  return botPost(port, {
    update_id: ++updSeq,
    message: {
      message_id: ++updSeq, date: Math.floor(Date.now() / 1000),
      from: { id: Number(fromId), first_name: 'Tester' },
      chat: { id: Number(fromId), type: 'private' },
      text,
      entities: text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] : undefined
    }
  });
}
/* A button tap as Telegram delivers it: the callback carries the
   card message (id + the exact text) so the server's card edit
   appends to the real body. */
async function botCallback(port, data, fromId, card) {
  return botPost(port, {
    update_id: ++updSeq,
    callback_query: {
      id: 'cbq' + updSeq,
      from: { id: Number(fromId), first_name: 'Tester' },
      message: {
        message_id: card ? card._mid : 1,
        chat: { id: Number(OWNER_ID), type: 'private' },
        text: card ? String(card.text || '') : 'card'
      },
      data
    }
  });
}

(async () => {
  const children = [];
  let outA = '', outB = '';
  try {
    await new Promise((r) => tgStub.listen(TG_PORT, '127.0.0.1', r));
    await new Promise((r) => tonStub.listen(TON_PORT, '127.0.0.1', r));
    await dbWipe();
    await dbPut('settings/global', { channel2: 'https://t.me/VIKING_PAYOUT' });
    await dbPut('counters/withdrawal', 0);

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
    await waitFor(async () => outA.includes('[payout] wallet ' + TEST_V5), 30000, 'child A payout boot line');
    await waitFor(async () => outB.includes('[payout] disabled (PAYOUT_MNEMONIC not set)'), 30000, 'child B payout boot line');
    const srv = require('./index.js'); // in-process helpers (friendly address rendering)

    const NOW = Date.now();
    const E = '700011001';   // the earner under review
    const INV = '700011000'; // E's inviter
    const MP = '700011099';  // E's multi-account link (same deviceHash)
    await seedPlayer(INV, { name: 'Inviter Ivan', username: 'ivaninv' });
    await seedPlayer(MP, { name: 'Multi Pete', username: 'multipete', deviceHash: 'DEV-E-1', sigs: ['dev:devE00000001'] });
    await seedPlayer(E, {
      name: 'Earner Eve', username: 'earner1', mined: 20000, userNo: 7,
      walletAddr: RAW('a'), lastCollectTime: NOW - 90000000, pendingRefComm: 70,
      invitedBy: Number(INV), walletVerified: true, verifiedAt: Date.UTC(2026, 10, 14, 12),
      walletAgeDays: 400, createdAt: NOW - 40 * 86400000,
      referrals: [{ id: '700011011', name: 'Ref One', status: 'Verified ✅' }, { id: '700011012', name: 'Ref Two', status: 'Pending ⏳' }],
      multiLinks: { ids: [MP], count: 1, at: NOW },
      deviceHash: 'DEV-E-1', sigs: ['dev:devE00000001']
    });
    await seedPlayer('700011011', { name: 'Ref One', invitedBy: Number(E) });
    await seedPlayer('700011012', { name: 'Ref Two', invitedBy: Number(E) });

    /* ---------- (i) counters follow the credits ---------- */
    console.log('\n[(i): earnings counters increment by the exact credited amounts]');
    const initE = () => userInit(E, 'Earner', 'earner1');
    let r = await apiOn(APP_A, initE(), 'collect');
    check('collect credits exactly 250', r.status === 200 && r.body.added === 250, r.body);
    r = await apiOn(APP_A, initE(), 'daily');
    check('daily credits 10', r.status === 200 && r.body.reward === 10, r.body);
    r = await apiOn(APP_A, initE(), 'task', { n: 1 });
    check('channel task credits 50', r.status === 200 && r.body.reward === 50, r.body);
    r = await apiOn(APP_A, initE(), 'bioTask');
    check('bio task credits 50', r.status === 200 && r.body.reward === 50, r.body);
    r = await apiOn(APP_A, initE(), 'refCollect');
    check('refCollect credits the pending 70', r.status === 200 && r.body.amount === 70, r.body);
    r = await apiOn(APP_A, initE(), 'refAch', { n: 1 });
    check('refAch credits 50 (1 verified referral)', r.status === 200 && r.body.reward === 50, r.body);
    const ep = await dbGet('players/' + E);
    check('earnMining = 250', ep.earnMining === 250, ep.earnMining);
    check('earnDaily = 10', ep.earnDaily === 10, ep.earnDaily);
    check('earnTasks = 100 (task + bioTask)', ep.earnTasks === 100, ep.earnTasks);
    check('earnRef = 120 (refCollect 70 + refAch 50)', ep.earnRef === 120, ep.earnRef);
    check('mined = 20,480 after all credits', ep.mined === 20480, ep.mined);
    check('refCommissionEarned still tracked separately = 70', ep.refCommissionEarned === 70, ep.refCommissionEarned);

    /* ---------- (a) withdraw -> instant review card, NO transfer ---------- */
    console.log('\n[(a): withdraw sends the owner a full review card and pays NOTHING yet]');
    const nE = await doWithdraw(APP_A, E, 'Earner', 'earner1');
    const wdE0 = await dbGet('withdrawals/wd_' + nE);
    check('record is Pending with NO payoutState (nothing attempted)', wdE0.status === 'Pending ⏳' && !('payoutState' in wdE0), wdE0);
    check('NO transfer was broadcast', sendsFor('VIKING-' + nE).length === 0, sendsFor('VIKING-' + nE));
    await waitFor(() => ownerCardsFor(nE).length >= 1, 15000, 'owner review card for wd ' + nE);
    const cardE = ownerCardsFor(nE)[0];
    const t = String(cardE.text || '');
    console.log('\n----- SAMPLE REVIEW CARD (as delivered to the owner) -----\n' + t + '\n-----------------------------------------------------------\n');
    check('card: no position suffix on the instant card', !/— سحب \d+ من \d+/.test(t), t.slice(0, 90));
    check('card: identity (name, @username, uid, player number)', t.includes('Earner Eve') && t.includes('earner1') && t.includes(E) && t.includes('رقم اللاعب: 7'), t);
    check('card: amounts 5,000 gross / 250 fee / 4,750 net', t.includes('5,000') && t.includes('250') && t.includes('4,750'), t);
    check('card: FULL friendly wallet address', t.includes(srv.toFriendlyAddress(RAW('a'))), srv.toFriendlyAddress(RAW('a')));
    check('card: verification verdict + date', t.includes('موثّقة') && t.includes('14 Nov 2026'), t);
    check('card: wallet age 400 days', t.includes('400 يوم'), t);
    check('card: balance after deduction 15,480', t.includes('15,480'), t);
    check('card: joined 40 days ago', t.includes('منذ 40 يوم'), t);
    check('card: inviter resolved (name + uid)', t.includes('Inviter Ivan') && t.includes(INV), t);
    check('card: referrals total 2 / active 1 (state() rule)', t.includes('2 · النشطة: 1'), t);
    check('card: live on-chain hold 10,000', t.includes('الهولد على الشبكة الآن') && t.includes('10,000'), t);
    check('card: multi cluster (1 account, Multi Pete, same-device reason)', t.includes('مرتبط بـ 1 حساب') && t.includes('Multi Pete') && t.includes('نفس الجهاز'), t);
    check('card: earnings sources 250 / 10 / 100 / 120 + commissions 70', t.includes('التعدين: 250') && t.includes('الدخول اليومي: 10') && t.includes('المهام: 100') && t.includes('الإحالات: 120') && t.includes('عمولات محصّلة: 70'), t);
    check('card: previous withdrawals 0', t.includes('سحوبات سابقة:</b> 0'), t);
    check('card: exactly the 4 decision callbacks in order', JSON.stringify(cardButtons(cardE)) === JSON.stringify(['wdok:' + nE, 'wdno:' + nE, 'wdban:' + nE, 'wdskip:' + nE]), cardButtons(cardE));
    check('card: fits the Telegram 4096 cap', t.length <= 4096, t.length);

    /* ---------- (b) /withdrawals gating + session start ---------- */
    console.log('\n[(b): /withdrawals — non-owner ignored, owner gets the first pending card with position]');
    const ownerMsgsBefore = msgsTo(OWNER_ID).length;
    await botMessage(APP_A, '700011555', '/withdrawals');
    await sleep(500);
    check('non-owner /withdrawals produces nothing at all', msgsTo(OWNER_ID).length === ownerMsgsBefore && msgsTo('700011555').length === 0, msgsTo('700011555').length);
    await botMessage(APP_A, OWNER_ID, '/withdrawals');
    await waitFor(() => ownerCardsFor(nE).some((c) => String(c.text || '').includes('— سحب 1 من 1')), 15000, 'session card with position 1 of 1');
    const sessionCardE = ownerCardsFor(nE).filter((c) => String(c.text || '').includes('— سحب 1 من 1')).pop();
    check('owner session card carries the position text', !!sessionCardE, ownerCardsFor(nE).length);

    /* ---------- (c) approve pays through the existing machine ---------- */
    console.log('\n[(c): wdok — one transfer, Paid ✅, tx-link follow-up, summary, celebration]');
    await botCallback(APP_A, 'wdok:' + nE, OWNER_ID, sessionCardE);
    await waitFor(async () => { const w = await dbGet('withdrawals/wd_' + nE); return w && w.status === 'Paid ✅'; }, 30000, 'wd ' + nE + ' paid after approve');
    const wdE = await dbGet('withdrawals/wd_' + nE);
    check('record Paid ✅ / payoutState paid', wdE.payoutState === 'paid', wdE);
    check('exactly one transfer, net 4,750 in base units (decimals 6)', sendsFor('VIKING-' + nE).length === 1 && sendsFor('VIKING-' + nE)[0].amount === '4750000000', sendsFor('VIKING-' + nE));
    await waitFor(() => ownerMsgsWith('اتدفع').some((m) => String(m.text).includes('#' + nE)), 15000, 'owner paid follow-up');
    const followUp = ownerMsgsWith('اتدفع').find((m) => String(m.text).includes('#' + nE));
    const txBtn = (((followUp.reply_markup || {}).inline_keyboard || [])).flat().find((b) => b.url);
    check('follow-up carries the tonviewer tx link (chain-resolved hash)', !!txBtn && txBtn.url === 'https://tonviewer.com/transaction/' + STUB_TX_HASH, txBtn);
    await waitFor(() => ownerMsgsWith('انتهت المراجعة').some((m) => String(m.text).includes('مدفوع: 1')), 15000, 'session summary after approve');
    check('session summary printed with مدفوع: 1', true);
    check('celebration DM reached the player', photosTo(E).length === 1, photosTo(E).length);

    /* ---------- (d) reject: NO refund ---------- */
    console.log('\n[(d): wdno — Rejected ❌, coins NOT refunded, confirmation + card edit]');
    const RJ = '700011002';
    await seedPlayer(RJ, { name: 'Reject Rita', username: 'ritarej', mined: 20000, walletAddr: RAW('b'), userNo: 11 });
    const nR = await doWithdraw(APP_A, RJ, 'Reject', 'ritarej');
    await waitFor(() => ownerCardsFor(nR).length >= 1, 15000, 'card for wd ' + nR);
    const cardR = ownerCardsFor(nR)[0];
    await botCallback(APP_A, 'wdno:' + nR, OWNER_ID, cardR);
    await waitFor(async () => { const w = await dbGet('withdrawals/wd_' + nR); return w && w.status === 'Rejected ❌'; }, 15000, 'wd ' + nR + ' rejected');
    const wdR = await dbGet('withdrawals/wd_' + nR);
    check('record Rejected ❌ + decidedAt stamped', !!wdR.decidedAt, wdR);
    const rp = await dbGet('players/' + RJ);
    check('NO refund: mined stays 15,000 after the rejection', rp.mined === 15000, rp.mined);
    check('no transfer for a rejected withdrawal', sendsFor('VIKING-' + nR).length === 0, sendsFor('VIKING-' + nR));
    await waitFor(() => ownerMsgsWith('ولم تُسترد عملاته').some((m) => String(m.text).includes('#' + nR)), 15000, 'reject confirmation');
    check('owner confirmation sent (reject + no-refund wording)', true);
    await waitFor(() => edits.some((e) => e.message_id === cardR._mid && String(e.text || '').includes('تم الرفض')), 15000, 'card edit');
    check('card edited with the rejection line, keyboard removed', edits.some((e) => e.message_id === cardR._mid && e.reply_markup && e.reply_markup.inline_keyboard.length === 0), edits.filter((e) => e.message_id === cardR._mid).length);
    await waitFor(() => ownerMsgsWith('انتهت المراجعة').some((m) => String(m.text).includes('مرفوض: 1')), 15000, 'session summary after reject');
    check('session summary printed with مرفوض: 1', true);

    /* ---------- (e) ban: reject + banned ---------- */
    console.log('\n[(e): wdban — player banned, withdrawal rejected, no refund]');
    const BN = '700011003';
    await seedPlayer(BN, { name: 'Ban Bob', username: 'banbob', mined: 20000, walletAddr: RAW('c'), userNo: 12 });
    const nB = await doWithdraw(APP_A, BN, 'Ban', 'banbob');
    await waitFor(() => ownerCardsFor(nB).length >= 1, 15000, 'card for wd ' + nB);
    await botCallback(APP_A, 'wdban:' + nB, OWNER_ID, ownerCardsFor(nB)[0]);
    await waitFor(async () => { const w = await dbGet('withdrawals/wd_' + nB); return w && w.status === 'Rejected ❌'; }, 15000, 'wd ' + nB + ' rejected');
    const bp = await dbGet('players/' + BN);
    check('player record banned = true', bp.banned === true, bp.banned);
    check('banned player also gets NO refund (mined 15,000)', bp.mined === 15000, bp.mined);
    await waitFor(() => ownerMsgsWith('انتهت المراجعة').some((m) => String(m.text).includes('محظور: 1')), 15000, 'session summary after ban');
    check('session summary counts the ban under محظور', true);

    /* ---------- (f) non-owner callback ---------- */
    console.log('\n[(f): a stranger tapping the buttons gets the alert and changes nothing]');
    const ST = '700011004';
    await seedPlayer(ST, { name: 'Stranger Sam', username: 'samsafe', mined: 20000, walletAddr: RAW('d'), userNo: 13 });
    const nS = await doWithdraw(APP_A, ST, 'Stranger', 'samsafe');
    await waitFor(() => ownerCardsFor(nS).length >= 1, 15000, 'card for wd ' + nS);
    const ansBefore = answers.length;
    await botCallback(APP_A, 'wdok:' + nS, '700011555', ownerCardsFor(nS)[0]);
    await waitFor(() => answers.length > ansBefore, 15000, 'non-owner answer');
    check('answer is the owner-only alert', String(lastAnswer().text || '').includes('للمالك فقط') && lastAnswer().show_alert === true, lastAnswer());
    const wdS0 = await dbGet('withdrawals/wd_' + nS);
    check('record untouched (still Pending, no payoutState)', wdS0.status === 'Pending ⏳' && !('payoutState' in wdS0), wdS0);
    check('no transfer from the stranger tap', sendsFor('VIKING-' + nS).length === 0, sendsFor('VIKING-' + nS));

    /* ---------- (g) double decision is a no-op ---------- */
    console.log('\n[(g): approve once -> paid; approve again -> «اتقرر» no-op]');
    await botCallback(APP_A, 'wdok:' + nS, OWNER_ID, ownerCardsFor(nS)[0]);
    await waitFor(async () => { const w = await dbGet('withdrawals/wd_' + nS); return w && w.status === 'Paid ✅'; }, 30000, 'wd ' + nS + ' paid');
    const ansBefore2 = answers.length;
    await botCallback(APP_A, 'wdok:' + nS, OWNER_ID, ownerCardsFor(nS)[0]);
    await waitFor(() => answers.length > ansBefore2, 15000, 'second-decision answer');
    check('second approve answers «اتقرر في السحب ده خلاص»', String(lastAnswer().text || '').includes('اتقرر في السحب ده خلاص'), lastAnswer());
    check('still exactly one transfer', sendsFor('VIKING-' + nS).length === 1, sendsFor('VIKING-' + nS));

    /* ---------- (h)+(j) skip advances; summary matches decisions ---------- */
    console.log('\n[(h)+(j): /withdrawals walk — skip leaves the record, next card comes, summary counts]');
    const K1 = '700011005', K2 = '700011006';
    await seedPlayer(K1, { name: 'Skip One', username: 'skipone', mined: 20000, walletAddr: RAW('e'), userNo: 14 });
    await seedPlayer(K2, { name: 'Skip Two', username: 'skiptwo', mined: 20000, walletAddr: RAW('f'), userNo: 15 });
    const nK1 = await doWithdraw(APP_A, K1, 'SkipOne', 'skipone');
    const nK2 = await doWithdraw(APP_A, K2, 'SkipTwo', 'skiptwo');
    await botMessage(APP_A, OWNER_ID, '/withdrawals');
    await waitFor(() => ownerCardsFor(nK1).some((c) => String(c.text || '').includes('— سحب 1 من 2')), 15000, 'walk card 1 of 2');
    const walk1 = ownerCardsFor(nK1).filter((c) => String(c.text || '').includes('— سحب 1 من 2')).pop();
    const ansBefore3 = answers.length;
    await botCallback(APP_A, 'wdskip:' + nK1, OWNER_ID, walk1);
    await waitFor(() => answers.length > ansBefore3, 15000, 'skip answer');
    check('skip answered «تم التخطي»', String(lastAnswer().text || '').includes('تم التخطي'), lastAnswer());
    const wdK1 = await dbGet('withdrawals/wd_' + nK1);
    check('skipped record untouched (Pending, no payoutState, no decidedAt)', wdK1.status === 'Pending ⏳' && !('payoutState' in wdK1) && !wdK1.decidedAt, wdK1);
    await waitFor(() => ownerCardsFor(nK2).some((c) => String(c.text || '').includes('— سحب 2 من 2')), 15000, 'walk card 2 of 2');
    const walk2 = ownerCardsFor(nK2).filter((c) => String(c.text || '').includes('— سحب 2 من 2')).pop();
    await botCallback(APP_A, 'wdno:' + nK2, OWNER_ID, walk2);
    await waitFor(() => ownerMsgsWith('انتهت المراجعة').some((m) => { const x = String(m.text); return x.includes('متخطى: 1') && x.includes('مرفوض: 1') && x.includes('مدفوع: 0'); }), 15000, 'final walk summary');
    check('summary counts match the walk (1 skip + 1 reject + 0 paid)', true);

    /* ---------- (k) approve with the payer disabled ---------- */
    console.log('\n[(k): child B — approve without PAYOUT_MNEMONIC alerts and changes nothing]');
    const DS = '700011007';
    await seedPlayer(DS, { name: 'Disabled Dan', username: 'dandan', mined: 20000, walletAddr: RAW('9'), userNo: 16 });
    const nD = await doWithdraw(APP_B, DS, 'Disabled', 'dandan');
    await waitFor(() => ownerCardsFor(nD).length >= 1, 15000, 'card for wd ' + nD);
    const ansBefore4 = answers.length;
    await botCallback(APP_B, 'wdok:' + nD, OWNER_ID, ownerCardsFor(nD)[0]);
    await waitFor(() => answers.length > ansBefore4, 15000, 'disabled approve answer');
    check('answer is the payer-disabled alert', String(lastAnswer().text || '').includes('مش مفعّل') && lastAnswer().show_alert === true, lastAnswer());
    const wdD = await dbGet('withdrawals/wd_' + nD);
    check('record still Pending, no payoutState', wdD.status === 'Pending ⏳' && !('payoutState' in wdD), wdD);
    check('no transfer from the disabled server', sendsFor('VIKING-' + nD).length === 0, sendsFor('VIKING-' + nD));
    await botCallback(APP_B, 'wdno:' + nD, OWNER_ID, ownerCardsFor(nD)[0]); // cleanup: leave nothing pending
    await waitFor(async () => { const w = await dbGet('withdrawals/wd_' + nD); return w && w.status === 'Rejected ❌'; }, 15000, 'cleanup reject on child B');

    /* ---------- (l) cooldown exemption: exempt ids never wait 24 h ---------- */
    console.log('\n[(l): withdraw cooldown — exempt ids withdraw back-to-back, everyone else still 429s]');
    const EX1 = '6970148965'; // the owner — DEFAULTS.withdrawCooldownExempt
    await seedPlayer(EX1, { name: 'Exempt Owner', username: 'exemptowner', mined: 20000, walletAddr: RAW('e'), userNo: 21 });
    const nE1 = await doWithdraw(APP_A, EX1, 'ExemptOwner', 'exemptowner');
    const nE2 = await doWithdraw(APP_A, EX1, 'ExemptOwner', 'exemptowner');
    check('exempt account withdrew twice back-to-back', nE2 === nE1 + 1, { nE1, nE2 });
    const pE = await dbGet('players/' + EX1);
    check('exempt lastWithdrawTime stays 0 (the app countdown never locks)', pE.lastWithdrawTime === 0, pE.lastWithdrawTime);
    check('both exempt withdrawals deducted (mined 20000 -> 10000)', pE.mined === 10000, pE.mined);
    const EX2 = '1111087186'; // Elshenawy — second id on the DEFAULTS list
    await seedPlayer(EX2, { name: 'Exempt Shenawy', username: 'exemptshenawy', mined: 20000, walletAddr: RAW('f'), userNo: 22 });
    const nS1 = await doWithdraw(APP_A, EX2, 'ExemptShenawy', 'exemptshenawy');
    const nS2 = await doWithdraw(APP_A, EX2, 'ExemptShenawy', 'exemptshenawy');
    check('second exempt id also withdrew back-to-back', nS2 === nS1 + 1, { nS1, nS2 });
    const NE = '700011008';
    await seedPlayer(NE, { name: 'Normal Ned', username: 'normalned', mined: 20000, walletAddr: RAW('d'), userNo: 23 });
    await doWithdraw(APP_A, NE, 'NormalNed', 'normalned');
    const rSecond = await apiOn(APP_A, userInit(NE, 'NormalNed', 'normalned'), 'withdraw', { amount: 5000 });
    check('non-exempt second withdraw inside 24 h -> 429 once-every-24-hours', rSecond.status === 429 && /once every 24 hours/.test((rSecond.body && rSecond.body.error) || ''), rSecond);
  } catch (e) {
    failed++;
    console.log('  ERROR', e && e.stack || e);
    console.log('\n----- child A logs (tail) -----\n' + outA.slice(-3000));
    console.log('\n----- child B logs (tail) -----\n' + outB.slice(-1500));
  } finally {
    for (const ch of children) { try { ch.kill('SIGKILL'); } catch (e) { /* ignore */ } }
    tgStub.close(); tonStub.close();
  }
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
})();
