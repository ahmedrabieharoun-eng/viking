const functions = require('@google-cloud/functions-framework');
const admin = require('firebase-admin');
const crypto = require('crypto');

/* RTDB port of the Firestore original — same API, same logic, only the
   persistence layer changed (see PORT_NOTES.md for the mapping + caveats).
   The database is initialised lazily on first use so the module still boots
   (and answers auth errors) when the DB env is not configured yet. */
let _rtdb = null;
function initRtdb() {
  if (_rtdb) return _rtdb;
  const url = process.env.FIREBASE_DATABASE_URL || '';
  if (!url) throw new Fail(500, 'Server not configured');
  try {
    if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: url });
    _rtdb = admin.database();
  } catch (e) {
    console.error('db init', e.message);
    throw new Fail(500, 'Server not configured');
  }
  return _rtdb;
}

/* Database backend (Supabase migration, owner order 2026-11-16):
   DB_BACKEND=rtdb (default) uses Firebase RTDB exactly as before;
   'dual' keeps RTDB primary and mirrors every committed write to
   Supabase; 'supabase' serves everything from Supabase through the
   RTDB-compatible adapter in sb_adapter.js. */
let _backend = null;
function rtdb() {
  if (_backend) return _backend;
  const mode = String(process.env.DB_BACKEND || 'rtdb').toLowerCase();
  if (mode === 'supabase' || mode === 'dual') {
    const { createSbDb, DualDb } = require('./sb_adapter');
    const sb = createSbDb(process.env.SUPABASE_REST_URL || '', process.env.SUPABASE_SERVICE_KEY || '');
    _backend = mode === 'supabase' ? sb : new DualDb(initRtdb(), sb);
    return _backend;
  }
  _backend = initRtdb();
  return _backend;
}

// Hosting env (Render > Environment / secret files):
//   BOT_TOKEN, OWNER_ID, ALLOWED_ORIGIN, TONAPI_KEY, SIG_SECRET (optional),
//   FIREBASE_DATABASE_URL, GOOGLE_APPLICATION_CREDENTIALS (service-account file)
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const OWNER_ID = String(process.env.OWNER_ID || '');          // your Telegram numeric ID
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const TONAPI_KEY = process.env.TONAPI_KEY || '';               // optional
// Wallet verification (owner order 2026-11-14): payments are confirmed
// on-chain through the TON Center v3 API. The key comes ONLY from the
// TON_API_KEY env var (the owner sets the same key as AdVOLT on Render);
// it is never stored in settings, never sent in any response, and the
// feature works without it (public rate limits only). TON_API_BASE is
// an env override for local testing, mirroring TG_API_BASE below.
const TON_API_KEY = process.env.TON_API_KEY || '';
const TON_API_BASE = (process.env.TON_API_BASE || 'https://toncenter.com/api/v3').replace(/\/+$/, '');
/* Toncenter key pool (owner order 2026-11-15): the owner supplied
   several toncenter API keys so chain reads stop depending on one
   key's rate limit — with thousands of players, a single throttled
   key was slowing wallet binds, hold syncs and verification checks.
   TONCENTER_KEYS env = comma-separated list; the legacy TON_API_KEY
   joins the pool too. tonc() walks the pool round-robin, and a 429
   from one key moves straight to the next: one throttled key must
   never fail a read while other keys are fresh. Keys live ONLY in
   the server env — never in code, never in any response. */
const TONCENTER_KEYS = (() => {
  const list = String(process.env.TONCENTER_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (TON_API_KEY && !list.includes(TON_API_KEY)) list.push(TON_API_KEY);
  return list;
})();
let toncKeyIdx = 0;
function nextToncKey() {
  if (!TONCENTER_KEYS.length) return '';
  const k = TONCENTER_KEYS[toncKeyIdx % TONCENTER_KEYS.length];
  toncKeyIdx = (toncKeyIdx + 1) % TONCENTER_KEYS.length;
  return k;
}

const JETTON = 'EQC6uN73kvaKh8LrTHQ8TQ5_vgqheI93iny5XUWkpQL9vjxI';
/* Automatic $VIKING payouts (owner order 2026-11-14): when the
   PAYOUT_MNEMONIC env var holds the payout wallet's 24 words, an
   owner-approved withdrawal is paid the net amount in the $VIKING
   jetton by attemptPayout (manual review first — owner order
   2026-11-14 ~07:29). The mnemonic lives ONLY in this env var — it
   is never stored in settings, never logged, never sent anywhere.
   PAYOUT_WALLET_VERSION selects the wallet contract the words open:
   'v5' (WalletContractV5R1, the default) or 'v4'. Unset/invalid
   mnemonic = the feature is off and withdrawals stay fully manual,
   byte-for-byte the old behaviour. */
const PAYOUT_MNEMONIC = String(process.env.PAYOUT_MNEMONIC || '').trim();
const PAYOUT_WALLET_VERSION = String(process.env.PAYOUT_WALLET_VERSION || 'v5').trim().toLowerCase();
const MAX_AUTH_AGE_SEC = 24 * 60 * 60;
const MIN_COLLECT_SEC = 10;
const DAILY = [10, 20, 30, 50, 70, 100, 200];
const DEFAULTS = {
  brandTitle: '$VIKING MINER', coinSym: '$VIKING', taskReward: 50,
  bioReward: 50, refAchReward1: 125, refAchReward10: 250, refAchReward25: 625, refAchReward50: 1250, refAchReward100: 2500,
  refClaimPercent: 5, refMinHold: 200, minWithdraw: 5000, holdPercentReq: 25, withdrawFeePercent: 5,
  lvl1PerDay: 250, payoutWallet: '', payoutChannel: '@YGRAM1', adminChatId: '',
  // Withdrawal-cooldown exemption (owner order 2026-11-14): these
  // Telegram ids never wait the 24 h between withdrawals (the owner
  // + Elshenawy, his tester). settings/global can override the list.
  withdrawCooldownExempt: [6970148965, 1111087186],
  // Owner-only maintenance (owner order 2026-11-14): while
  // settings/global.ownerOnly is true, the API answers 403
  // {maintenance:true} and the bot answers an update notice to
  // everyone except OWNER_ID; the app shows «update in progress».
  // (403, not 503: the app treats 503 as a sleeping-server wake-up
  // and would sit retrying behind the loader instead of showing it.)
  ownerOnly: false,
  // Tester opening (owner order 2026-11-15): while ownerOnly is on,
  // these Telegram ids may ALSO use the app and the bot — the owner
  // is resetting these accounts to zero and re-testing as brand-new
  // users while everyone else keeps seeing «update in progress».
  // settings/global can override the list. Admin tools (/withdrawals,
  // /multi, …) stay strictly OWNER_ID — testers are players.
  testUsers: [],
  // Full admins (owner order 2026-11-15): these Telegram ids are
  // admins alongside the owner — bot admin tools (/withdrawals,
  // /multi, /emojihunt), the withdrawal decision buttons, the in-app
  // admin actions, and every admin notification (verification
  // deposits, payout failures). settings/global can override the list.
  adminUsers: [],
  buySwapUrl: 'https://app.ston.fi/swap?chartVisible=false&tt=EQC6uN73kvaKh8LrTHQ8TQ5_vgqheI93iny5XUWkpQL9vjxI&ft=GRAM',
  channel1: 'https://t.me/YGRAM1', channel2: 'https://t.me/telegram', channel3: 'https://t.me/VikingMiner_Community', botUsername: 'VIKING_MINER_BOT',
  // Wallet verification (owner order 2026-11-14): the fee is paid to
  // verifyDepositWallet with the comment VIKING-<userNo>; a wallet must
  // be at least verifyMinAgeDays old to be verified.
  verifyDepositWallet: 'UQBCoy7KjhL9VnKA_YOp4_hxmYKAQ8P8mIfx5FdIdSA6qvxE', verifyFeeTon: 0.05, verifyMinAgeDays: 7
};
const NUM_KEYS = ['lvl1PerDay', 'taskReward', 'bioReward', 'refAchReward1', 'refAchReward10', 'refAchReward25', 'refAchReward50', 'refAchReward100', 'refClaimPercent', 'refMinHold', 'minWithdraw', 'holdPercentReq', 'withdrawFeePercent', 'verifyFeeTon', 'verifyMinAgeDays'];
const STR_KEYS = ['brandTitle', 'coinSym', 'payoutWallet', 'payoutChannel', 'adminChatId', 'channel1', 'channel2', 'channel3', 'botUsername', 'buySwapUrl', 'verifyDepositWallet'];

/* ---------- helpers ---------- */
class Fail extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new Fail(status, msg); };
const dayOf = (ts) => Math.floor(ts / 86400000);
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').slice(0, n);
const P = (id) => rtdb().ref('players/' + String(id));
const isId = (v) => /^\d{5,15}$/.test(String(v));
const walletDoc = (raw) => rtdb().ref('wallets/' + String(raw).replace(':', '_'));
const sigDoc = (k) => rtdb().ref('sigs/' + String(k).replace(/\//g, '_'));
const getVal = async (ref) => (await ref.once('value')).val();

/* Indexed candidate reads for the background watchers (owner
   load-reduction order 2026-11-15): the verify watcher used to
   download the ENTIRE players node every 10 s and the hold watcher
   on every sweep, just to find a handful of candidates. With
   .indexOn on verifyPendingAt / walletVerified in the RTDB rules,
   these queries are answered server-side and return only the
   candidate records. If a query ever fails (e.g. the index is
   removed from the rules), this returns null and the caller falls
   back to the full read — the watchers keep working either way,
   just heavier. */
async function queryPlayersByChild(child, mode, value) {
  try {
    let q = rtdb().ref('players').orderByChild(child);
    q = mode === 'startAt' ? q.startAt(value) : q.equalTo(value);
    const v = (await q.once('value')).val();
    return v || {};
  } catch (e) { console.error('queryPlayersByChild', child, e.message); return null; }
}

/* RTDB transaction helper replacing db.runTransaction for a single node.
   fn(cur) returns one of:
     { value, out }  -> commit `value` as the node's new content; txUpdate returns `out`
     { skip, out }   -> abort without error (a no-op the caller treats as done); returns `out`
     { error }       -> abort and throw that Fail (same status/message as the Firestore code)
   fn may run several times under contention; only the last run's result counts.

   ROOT-CAUSE FIX (the live "User not found" bug): the JS RTDB client first
   runs the update function against this process's LOCAL view of the node,
   which is null for any node the process has not synced yet — including a
   player that exists on the server (even one created seconds earlier by
   this same process; reproduced against the RTDB emulator). Returning
   undefined on that first pass aborts the transaction locally, BEFORE the
   SDK ever asks the server for the real value, so every "abort" decision
   (the actions' 404 'User not found', adminWd's 404, the banned/skip
   guards) could fire spuriously for a real record. On an abort decision we
   therefore return `cur` itself (identity) instead of undefined: that
   forces the server round-trip — if the view was stale, fn re-runs with
   the real value and decides again; if the value really is what fn saw,
   the commit is a harmless no-op and the recorded decision is applied
   below (throw err / return skip-out), so observable behaviour is
   unchanged while the stale-view false decisions disappear. Value
   decisions were never affected: they always round-tripped and re-ran.

   SECOND HALF of the same bug (intermittent 'User not found' AND
   'Server error' in the wild, typically right after a process
   (re)start): the first local pass can hand fn `undefined` — not null
   — for a node this process has never synced. Every callback is
   written against null, so on undefined it either mis-decided (the
   create-if-absent guards read `cur !== null` as "exists, skip", so
   ensurePlayer created nothing) or crashed dereferencing it
   (`d.banned` on undefined -> a bare 500), and the identity return
   above handed `undefined` back to the SDK, which aborts the
   transaction locally without ever asking the server. txUpdate
   therefore NEVER lets fn see undefined: an undefined pass decides
   nothing and returns null (never undefined) as a probe — the
   compare-and-swap hash check guarantees the probe cannot overwrite
   a real server value; if the server holds one, fn re-runs against
   it inside the same transaction. If fn never ran against a
   server-confirmed value at all (the node was truly empty and the
   probe committed), the decision is taken afterwards on a direct
   read, and a value decision is committed by one recursive pass —
   the read has synced the node, so fn runs against the real value
   there. Net effect: 'record missing' is only ever decided on a
   value the server confirmed, so a legitimate ensured player can
   no longer surface a spurious 404/500 from a stale local view.

   THIRD hardening (live incident 2026-11-14, player 1915163030):
   the compat SDK's own transaction loop gives up under contention
   and throws `Error: maxretry` (stack: repoRerunTransactionQueue).
   Whole-player-record transactions starve whenever the same record
   absorbs frequent small writes (state's lastSeen refresh, hold
   syncs, multiLinks), so a verifyCheck claim/flip could lose the
   race repeatedly and surface as a bare 500 'Server error' — the
   player's real, correctly-commented payment sat unclaimed while
   every retry from the app hit the same wall. txUpdate (below) now
   retries the WHOLE attempt when — and only when — the failure is
   a maxretry abort: up to 5 attempts total with growing delays.
   A maxretry abort means the transaction never committed, so
   re-running fn from scratch is exactly as safe as the SDK's own
   internal re-runs; every other error keeps the behaviour it has
   always had (thrown on first sight). */
async function txUpdateOnce(ref, fn, _depth = 0) {
  let out, err = null, skip = false, decided = false;
  const res = await ref.transaction((cur) => {
    if (cur === undefined) return null; // unseen locally != missing: probe, decide nothing (see above)
    decided = true;
    const r = fn(cur) || {};
    if (r.error || r.skip) { err = r.error || null; skip = !!r.skip; out = r.out; return cur; }
    skip = false; err = null; out = r.out;
    return r.value;
  });
  if (!decided) {
    if (_depth >= 1) throw new Fail(500, 'Server error'); // still undecided after a confirmed read: a genuine fault, not a stale view
    const cur = await getVal(ref);
    const r = fn(cur) || {};
    if (r.error) throw r.error;
    if (r.skip) return r.out;
    return txUpdateOnce(ref, fn, _depth + 1);
  }
  if (err) throw err;
  if (skip) return out;
  if (!res.committed) throw new Fail(500, 'Server error');
  return out;
}

const TX_MAXRETRY_DELAYS = [150, 350, 700, 1200]; // ms before retries 1..4 (±25% jitter) — 5 attempts total
const isMaxRetryError = (e) => /maxretry/i.test(String((e && (e.message || e.code)) || ''));
const txSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function txUpdate(ref, fn) {
  for (let attempt = 0; ; attempt++) {
    try { return await txUpdateOnce(ref, fn, 0); }
    catch (e) {
      if (!isMaxRetryError(e) || attempt >= TX_MAXRETRY_DELAYS.length) throw e;
      const delay = Math.round(TX_MAXRETRY_DELAYS[attempt] * (0.75 + Math.random() * 0.5));
      const tail = ((ref.parent && ref.parent.key) ? ref.parent.key + '/' : '') + (ref.key || '');
      console.error('txUpdate maxretry on ' + tail + ' — retry ' + (attempt + 1) + '/' + TX_MAXRETRY_DELAYS.length + ' in ' + delay + 'ms');
      await txSleep(delay);
    }
  }
}

/* Increment one key of meta/counters atomically and return its new
   value. Routed through txUpdate so the counters inherit the
   unseen-node hardening above — the raw ref.transaction calls this
   replaces computed from the (possibly unseen) local view and never
   checked that the result had actually committed. */
async function bumpCounter(key) {
  return txUpdate(rtdb().ref('meta/counters'), (cur) => {
    const base = (cur && typeof cur === 'object') ? cur : {};
    const v = { ...base, [key]: (Number(base[key]) || 0) + 1 };
    return { value: v, out: v[key] };
  });
}

/* ---------- multi-account signals: for owner review only, nothing is blocked ---------- */
function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return String(xf.length ? xf[xf.length - 1] : req.ip || '').replace(/[^0-9a-fA-F:.]/g, '').slice(0, 45);
}
function clientKeys(fp) {
  if (!fp || typeof fp !== 'object') return [];
  const keys = [];
  const cid = String(fp.cid || '').replace(/[^\w-]/g, '').slice(0, 64);
  if (cid.length >= 8) keys.push('cid:' + cid);
  if (typeof fp.dev === 'string' && fp.dev) keys.push('dev:' + crypto.createHash('sha256').update(fp.dev.slice(0, 400)).digest('hex').slice(0, 16));
  const m = /(Telegram[\w-]*)\/([\d.]+)/i.exec(String(fp.ua || ''));
  keys.push('cl:' + clean(fp.tgp, 20) + '/' + clean(fp.tgv, 10) + (m ? '+' + m[1].slice(0, 24) + '/' + m[2].slice(0, 12) : ''));
  return keys;
}
const hashIp = (ip) => crypto.createHmac('sha256', process.env.SIG_SECRET || BOT_TOKEN || 'x').update(String(ip)).digest('hex').slice(0, 16);
const seenSig = new Map();
async function noteSignals(uid, keys) {
  const seen = seenSig.get(uid) || new Set();
  seenSig.set(uid, seen);
  const fresh = keys.filter((k) => k && !seen.has(k));
  if (!fresh.length || seen.size >= 60) return;
  fresh.forEach((k) => seen.add(k));
  if (seenSig.size > 50000) seenSig.clear();
  try {
    // Firestore original: one write batch (player sigs arrayUnion + one sigs
    // doc arrayUnion per non-cl key). RTDB has no arrayUnion, so: read the
    // current arrays, merge in code, write everything in ONE atomic
    // multi-path update (see PORT_NOTES.md for the race caveat).
    const db = rtdb();
    const docKeys = fresh.filter((k) => !k.startsWith('cl:')).map((k) => k.replace(/\//g, '_'));
    const [mySigs, ...sigUsers] = await Promise.all([
      getVal(db.ref('players/' + uid + '/sigs')),
      ...docKeys.map((dk) => getVal(db.ref('sigs/' + dk + '/users')))
    ]);
    const updates = {};
    updates['players/' + uid + '/sigs'] = [...new Set([...(mySigs || []), ...fresh])];
    docKeys.forEach((dk, i) => {
      const users = sigUsers[i] || [];
      if (!users.includes(String(uid))) updates['sigs/' + dk + '/users'] = [...users, String(uid)];
    });
    await db.ref().update(updates);
  } catch (e) { console.error('signals', e.message); }
}
/* A referral counts as ACTIVE only while BOTH activation conditions
   hold (owner orders 2026-11-14 + 2026-11-15): the invitee's wallet is
   VERIFIED (the 0.05 TON verification) AND his synced hold meets
   refMinHold (200 $VIKING = Level 2). The state is LIVE, not a latch:
   syncReferralActive() re-evaluates it after every wallet sync,
   verification completion and unlink — buying + verifying flips the
   inviter's entry to 'Verified ✅' and starts the 5% commission, and
   selling below the minimum (or losing verification) flips it back to
   'Pending ⏳' and pauses the commission. '⚠️ Duplicate' entries never
   flip either way and never count. */
const ACTIVE_REF_STATUS = 'Verified ✅';
const countActiveRefs = (refs) => Object.values(refs || {}).filter((r) => r && String(r.status || '').trim() === ACTIVE_REF_STATUS).length;
const publicPlayer = (d) => {
  const o = { ...(d || {}) };
  delete o.sigs;
  delete o.multiLinks; // owner-only detection data (adminState + /multi) — never shown to the player
  // ads were removed from the app (owner order): the stored counters stay in
  // the DB as inert data but are no longer exposed to the client
  delete o.adsWatched;
  delete o.lastAdUtcDay;
  delete o.lastAdAt;
  o.referrals = (o.referrals || []).map((r) => { const x = { ...r }; delete x.deviceHash; x.verified = x.verified === true; x.avatar = (Number(x.avatar) >= 1 && Number(x.avatar) <= 8) ? Number(x.avatar) : 0; return x; });
  o.avatar = (Number(o.avatar) >= 1 && Number(o.avatar) <= 8) ? Number(o.avatar) : 0; // chosen painted avatar (owner order 2026-11-14); 0 = not chosen yet
  // additive fields for the bio task + referral achievements (tasks tab)
  o.bioTaskDone = o.bioTaskDone === true;
  o.refAchClaimed = (o.refAchClaimed && typeof o.refAchClaimed === 'object') ? o.refAchClaimed : {};
  o.activeRefs = countActiveRefs(o.referrals);
  // wallet verification (owner order 2026-11-14): userNo is the player's
  // permanent sequential number (0 until assigned — see assignUserNo);
  // referrals entries above carry the invitee's `verified` flag, kept in
  // sync by syncRefVerifiedFlag at verify/void time.
  o.userNo = Number(o.userNo) || 0;
  o.walletVerified = o.walletVerified === true;
  o.verifiedWallet = o.verifiedWallet || '';
  o.verifiedAt = Number(o.verifiedAt) || 0;
  return o;
};
const WHY = { cid: 'نفس نسخة التطبيق', dev: 'نفس الجهاز' }; // no 'ip' label: a shared IP never explains a link (owner order 2026-11-14, round 2)
const LIMIT = { cid: 50, dev: 6, ip: 5 }; // signals shared by more accounts than this are treated as common (CGNAT, same phone model)
async function riskOf(uid) {
  const me = (await getVal(P(uid))) || {};
  const mine = me.sigs || [];
  const keys = mine.filter((k) => !k.startsWith('cl:')).slice(0, 40);
  const docs = await Promise.all(keys.map((k) => getVal(sigDoc(k))));
  const linked = {}, any = {};
  docs.forEach((data, i) => {
    if (!data) return;
    const kind = keys[i].split(':')[0];
    const users = (data.users || []).filter((x) => x !== String(uid));
    users.forEach((u) => { (any[u] = any[u] || new Set()).add(kind); }); // also counts common signals, used only for referral relations
    // A shared IP is NEVER a link (owner order 2026-11-14, round 2):
    // carrier NAT / shared Wi-Fi put strangers behind one address.
    // ip: keys are still recorded and still feed the player's OWN
    // «used N different IPs» reason further down — they just never
    // put another account into `linked`, at any level (and so never
    // into strong/rank/level, which all derive from `linked`).
    if (kind === 'ip') return;
    if (!users.length || users.length > (LIMIT[kind] || 0)) return;
    users.forEach((u) => { (linked[u] = linked[u] || new Set()).add(kind); });
  });
  const ids = Object.keys(linked);
  const rank = (u) => (linked[u].has('cid') ? 3 : linked[u].has('dev') ? 2 : 1);
  const strong = ids.filter((u) => linked[u].has('cid') || linked[u].size >= 2).length;
  const devLinks = ids.filter((u) => linked[u].has('dev')).length;
  const inviterLink = me.invitedBy && linked[String(me.invitedBy)];
  const invLinks = (me.referrals || []).filter((r) => linked[String(r.id)]).length;
  const times = (me.referrals || []).map((r) => r.at).filter(Boolean).sort((a, b) => a - b);
  let burst = 0;
  for (let i = 0, j = 0; i < times.length; i++) { while (times[i] - times[j] > 600000) j++; burst = Math.max(burst, i - j + 1); }
  const clients = mine.filter((k) => k.startsWith('cl:')).length;
  const ips = mine.filter((k) => k.startsWith('ip:')).length;
  const reasons = [];
  if (ids.length) reasons.push('مرتبط بـ ' + ids.length + ' حساب تاني');
  if (inviterLink) reasons.push('مرتبط بالحساب اللي دعاه (' + [...inviterLink].map((k) => WHY[k]).join('، ') + ')');
  if (invLinks) reasons.push(invLinks + ' من اللي دعاهم مرتبطين بيه');
  if (burst >= 4) reasons.push(burst + ' إحالات دخلت خلال 10 دقايق');
  if (clients >= 3) reasons.push('دخل من ' + clients + ' نسخ/أنظمة تيلجرام مختلفة');
  if (ips >= 5) reasons.push('استخدم ' + ips + ' عناوين IP مختلفة (احتمال VPN)');
  const hasDev = (u) => !!(linked[String(u)] && linked[String(u)].has('dev'));
  const hasDevAny = (u) => !!(any[String(u)] && any[String(u)].has('dev'));
  const relDev = hasDev(me.invitedBy) || (me.referrals || []).some((r) => hasDev(r.id));
  const relCommon = hasDevAny(me.invitedBy) || (me.referrals || []).some((r) => hasDevAny(r.id));
  if (relDev) reasons.push('نفس الجهاز مع حساب مرتبط بيه بالإحالة (دعاه أو دعاه هو)');
  else if (relCommon) reasons.push('نفس نوع الجهاز مع حساب مرتبط بيه بالإحالة (ممكن يكون صدفة لو الجهاز منتشر)');
  const level = strong > 0 || devLinks >= 3 || relDev ? 'high' : devLinks > 0 || relCommon || ids.length >= 3 || inviterLink || invLinks || burst >= 4 ? 'medium' : 'low';
  const top = ids.sort((a, b) => rank(b) - rank(a)).slice(0, 8);
  const rows = await Promise.all(top.map(async (id) => {
    const d = (await getVal(P(id))) || {};
    return { id, name: d.name || '', mined: d.mined || 0, banned: d.banned === true, verified: d.walletVerified === true, via: [...linked[id]].map((k) => WHY[k]) };
  }));
  return { level, reasons, linked: rows };
}

/* ---------- multi-account links: REPORT-ONLY (owner order) ----------
   Detection and storage ONLY — NO notifications: the proactive
   new-link alert DMs were removed entirely by owner order 2026-11-14;
   the links accumulate silently in player.multiLinks and the owner
   inspects them on demand with the /multi bot command (see multiTree
   below). Nothing here bans, blocks or delays any action: state()
   calls updateMultiLinks() inside a try/catch after its main work,
   and the stored `banned` flag is never touched by this code.

   The detection itself is a faithful port of the AdVOLT anti-fraud
   system (lux_v5/send_worker_v802.js, checkAntiFraud + helpers) — the
   owner ordered THE SAME system here, with exactly one difference:
   where VOLT blocks the later account (blockNow), Viking RECORDS a
   link to the device owner in player.multiLinks.

   How it works (identical to VOLT):
   - The client sends a persistent random deviceId (stored on the device
     itself: localStorage + cookie + IndexedDB), a combined device
     fingerprint, and five individually hashed hardware signals
     (canvas/webgl/hardware/fonts/audio) — see AntiFraud in the frontend.
   - Layer 1 (primary): the deviceId registry deviceIds/{deviceId}. The
     first account to present a deviceId owns its record (with its
     signals stored); a DIFFERENT account presenting the same deviceId
     is linked to that owner.
   - Layer 2: the fingerprint registry devices/{fp}. A different account
     with the same combined fingerprint links ONLY if it is a legacy
     client with no deviceId (VOLT's original strict rule), or — the
     v800 rule — ALL FIVE of its signal hashes exactly match the signals
     stored under the fingerprint owner's deviceId record (same hardware
     behind a regenerated deviceId). A fingerprint match without the
     full signal match is noted as sharedSeen on the record, nothing
     more: identical phone models share fingerprints innocently.
   - IP addresses, the legacy sigs keys (cid:/dev:/ip:) and deviceHash
     play NO role in linking (VOLT never uses IPs for the decision; the
     old loose Viking rule that linked on any shared sig key produced a
     live false positive between two strangers sharing carrier-NAT IPs
     and was removed entirely — see MULTI_FIX_REPORT.md).
   - Registry read failures fail OPEN (no link), exactly like VOLT: a
     database hiccup must never flag an innocent account. */
const AF_SIGNAL_KEYS = ['canvasHash', 'webglHash', 'hardwareHash', 'fontsHash', 'audioHash'];
function afSanitiseKey(str, maxLen = 64) {
  if (typeof str !== 'string') return null;
  const clean = str.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, maxLen);
  return clean.length >= 8 ? clean : null;
}
function afSanitiseSignals(sig) {
  if (!sig || typeof sig !== 'object') return null;
  const out = {};
  for (const k of AF_SIGNAL_KEYS) out[k] = afSanitiseKey(sig[k], 80);
  return out;
}
function afSanitiseFlags(f) {
  if (!f || typeof f !== 'object') return null;
  return { headless: !!f.headless, emulator: !!f.emulator, devtools: !!f.devtools };
}
function afSignalsFullMatch(a, b) {
  if (!a || !b) return false;
  for (const k of AF_SIGNAL_KEYS) {
    if (!a[k] || !b[k] || a[k] !== b[k]) return false;
  }
  return true;
}
function afOwnerOf(record) {
  if (!record) return null;
  const o = record.owner ?? record.firstTelegramId;
  return o ? String(o) : null;
}
const MULTI_IDS_CAP = 50;
/* Returns the device-owner account ids this account is linked to under
   the VOLT rules above (usually 0 or 1). Registration side effects are
   VOLT's: first presenter of a deviceId / fingerprint writes its record. */
async function detectDeviceLinks(uid, body) {
  const tid = String(uid);
  const fp = afSanitiseKey(body && body._deviceFingerprint, 64);
  const did = afSanitiseKey(body && body._deviceId, 64);
  const linked = new Set();
  if (!fp && !did) return [];
  const db = rtdb();

  // Layer 1 — deviceId registry (primary identity, as in VOLT)
  if (did) {
    let didRecord = null, readOk = true;
    try { didRecord = await getVal(db.ref('deviceIds/' + did)); } catch (e) { readOk = false; }
    if (readOk) {
      const didOwner = afOwnerOf(didRecord);
      if (!didOwner) {
        try {
          await db.ref('deviceIds/' + did).set({
            owner: tid, ts: Date.now(), fingerprint: fp || null,
            signals: afSanitiseSignals(body && body._afSignals),
            flags: afSanitiseFlags(body && body._afFlags),
          });
        } catch (e) { /* registration is best-effort, as in VOLT */ }
      } else if (didOwner !== tid) {
        linked.add(didOwner); // VOLT: blockNow(didOwner, 'deviceId') → Viking: record the link
      }
    }
  }

  // Layer 2 — combined fingerprint registry (VOLT's original system + v800 rule)
  if (fp) {
    let record = null, readOk = true;
    const fpRef = db.ref('devices/' + fp);
    try { record = await getVal(fpRef); } catch (e) { readOk = false; }
    if (readOk) {
      const owner = afOwnerOf(record);
      if (!owner) {
        try { await fpRef.set({ owner: tid, ts: Date.now(), deviceId: did || null }); } catch (e) { /* best-effort */ }
      } else if (owner !== tid) {
        if (!did) {
          linked.add(owner); // legacy client, no deviceId: VOLT blocks via 'fingerprint' → record the link
        } else {
          const mySignals = afSanitiseSignals(body && body._afSignals);
          const ownerDid = afSanitiseKey(record.deviceId, 64);
          let matched = false;
          if (mySignals && ownerDid) {
            try {
              const ownerDidRec = await getVal(db.ref('deviceIds/' + ownerDid));
              if (ownerDidRec && afSignalsFullMatch(mySignals, ownerDidRec.signals)) matched = true;
            } catch (e) { /* a failed read never flags anyone (VOLT) */ }
          }
          if (matched) {
            linked.add(owner); // VOLT v800: blockNow(owner, 'fingerprint_signals') → record the link
          } else if (record.sharedSeen !== tid) {
            // Fingerprint collision without a full signal match: VOLT only
            // notes it on the record for review — no block, no link.
            try { await fpRef.update({ sharedSeen: tid, sharedSeenAt: Date.now() }); } catch (e) { /* best-effort */ }
          }
        }
      }
    }
  }
  return [...linked];
}
async function updateMultiLinks(uid, body) {
  const ref = P(uid);
  const me = await getVal(ref);
  if (!me) return;
  const ids = (await detectDeviceLinks(uid, body)).sort().slice(0, MULTI_IDS_CAP);
  /* Contention diet (round 3, incident 2026-11-14): when the stored
     v2 set already equals the merged set (same ids, same count),
     skip the write ENTIRELY — do not even start the transaction.
     The in-transaction skip further down still ran ref.transaction
     on the whole player node, and under a burst of small writes to
     that record the compat SDK aborted it with 'maxretry' (16 log
     lines in the incident window) over a write that would have
     changed nothing. This pre-check uses the record read above and
     mirrors the union rule exactly; the in-transaction check stays
     as the race-safe authority whenever this read was stale in a
     way that matters (anything not already in the stored set still
     goes through the transaction). */
  const storedML = (me.multiLinks && Array.isArray(me.multiLinks.ids)) ? [...new Set(me.multiLinks.ids.map(String))].sort() : null;
  if (storedML && me.multiLinks.v === 2) {
    const mergedPre = [...new Set([...storedML, ...ids])].sort();
    if (mergedPre.length === storedML.length && mergedPre.every((x, i) => x === storedML[i])) return; // unchanged: no write at all
  }
  /* Persist + decide what is "fresh" INSIDE one transaction on the player
     node, against the freshest stored list:
     - concurrent state calls for the same user merge against the
       committed list, so no detected link is ever lost to a race — the
       loser's transaction re-runs against the winner's stored list;
     - a pair can only ever re-enter as "fresh" after it fully cleared
       from the stored list in between (a genuine unlink under this
       system, e.g. the device record changed hands) — never from a
       toggling computation.
     (The pre-port rule flapped exactly here: its link set was computed
     from the read-merge-write sigs arrays, and a concurrently dropped
     array entry toggled the set at 03:08 and 03:11 after the first
     sightings at 03:05/03:06. The registry records used now are
     single-owner writes that are never merged, so the computed set is
     stable as well.) */
  await txUpdate(ref, (cur) => {
    if (cur === null) return { skip: true, out: { fresh: [] } };
    const stored = (cur.multiLinks && Array.isArray(cur.multiLinks.ids)) ? cur.multiLinks.ids.map(String) : null;
    const storedV2 = !!(cur.multiLinks && cur.multiLinks.v === 2);
    /* Accumulate, never oscillate. Records written by THIS system carry
       v:2 and only ever GROW (union of stored + freshly detected): the
       detection answers "which device owners has this account ever been
       seen sharing a device with", and the answer for a given call
       depends on which deviceId the user happened to present THIS time
       — a user alternating between two shared devices would otherwise
       toggle the stored set on every call and re-alert on every toggle
       (the same flap shape as the old rule, different mechanism). VOLT
       has no such flap because its registries and block records are
       append-only; the stored list here is append-only too.
       Records WITHOUT v:2 were written by the removed loose rule and are
       REPLACED by the fresh computation exactly once — that is the heal
       that wipes the old false links (e.g. the two live accounts flagged
       over shared carrier IPs) on their first state call under this
       system; from then on their records are v:2 like everyone else's. */
    const merged = (storedV2 && stored) ? [...new Set([...stored, ...ids])].sort() : ids;
    const changed = stored === null || stored.length !== merged.length || stored.some((x, i) => x !== merged[i]);
    if (!changed && storedV2) return { skip: true, out: { fresh: [] } }; // nothing new: no write churn
    const fresh = merged.filter((id) => !(stored || []).includes(id));
    return { value: { ...cur, multiLinks: { count: merged.length, ids: merged, updatedAt: Date.now(), v: 2 } }, out: { fresh } };
  });
  /* Owner order 2026-11-14: NO message is sent when new links form.
     The proactive «تعدد حسابات — روابط جديدة» DM that used to be
     dispatched here is removed entirely — the stored links above are
     the whole feature now, and the owner reads them on demand with
     the /multi command (see multiTree). */
}

/* ---------- owner-only /multi <telegramId>: the link tree, on demand ----
   (Owner order 2026-11-14; replaces the proactive new-link alerts.)
   Dispatched from handleOwnerTools under the same admin gate
   (isAdminUid: owner + settings/global.adminUsers) as /emojihunt; anyone else's /multi falls through untouched
   and is silently ignored by the normal message handling.

   The stored multiLinks lists are ASYMMETRIC: a later account lists
   the device owner it linked to, while that owner's own list can be
   empty (live example: Matteo and Crystal Support each list
   Elshenawy, whose own list is empty). A player's links are therefore
   its multiLinks.ids PLUS every player whose ids contain it, and the
   tree is the whole connected cluster collected by BFS over both
   directions. Each non-queried account is shown with the reason for
   its link to the account it was reached through (the queried
   account for direct links), read off the two stored records:
   same deviceHash > shared dev: signal > shared cid: signal >
   a recorded link the stored signals no longer explain. A shared
   ip: signal NEVER explains a link (owner order 2026-11-14,
   round 2) — it falls through to «رابط مسجل» like any other
   unexplained stored link. Nothing here writes anything — it is
   a pure read. */
const MULTI_LIST_CAP = 40;
const sigSetOf = (p, prefix) => new Set((Array.isArray(p && p.sigs) ? p.sigs : []).filter((s) => typeof s === 'string' && s.startsWith(prefix)));
function linkReason(a, b) {
  const dhA = String((a && a.deviceHash) || ''), dhB = String((b && b.deviceHash) || '');
  if (dhA && dhB && dhA === dhB) return 'نفس الجهاز';
  for (const [prefix, label] of [['dev:', 'نفس بصمة الجهاز'], ['cid:', 'نفس تثبيت تيليجرام']]) {
    const mine = sigSetOf(a, prefix);
    if (!mine.size) continue;
    for (const s of sigSetOf(b, prefix)) if (mine.has(s)) return label;
  }
  return 'رابط مسجل';
}
async function multiTree(chatId, arg) {
  try {
    if (!/^\d+$/.test(String(arg || ''))) {
      await tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: 'ℹ️ الاستخدام: /multi <رقم حساب التيليجرام> — مثال: <code>/multi 1915163030</code>' });
      return;
    }
    const target = String(arg);
    const players = (await getVal(rtdb().ref('players'))) || {};
    if (!players[target]) {
      await tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `ℹ️ الحساب <code>${esc(target)}</code> مش موجود في اللعبة.` });
      return;
    }
    const idsOf = (p) => (p && p.multiLinks && Array.isArray(p.multiLinks.ids)) ? p.multiLinks.ids.map(String) : [];
    const listedBy = new Map(); // id -> uids whose stored list contains that id
    for (const [uid, p] of Object.entries(players)) {
      for (const id of idsOf(p)) {
        if (!listedBy.has(id)) listedBy.set(id, []);
        listedBy.get(id).push(uid);
      }
    }
    const neighborsOf = (uid) => [...new Set([...idsOf(players[uid]), ...(listedBy.get(uid) || [])])]
      .filter((id) => id !== uid && players[id]).sort();
    // BFS: the queried account first, then its direct links, then the
    // rest of the cluster. parent = the account each node was first
    // reached through.
    const parent = new Map([[target, null]]);
    const order = [target];
    for (let i = 0; i < order.length; i++) {
      for (const nb of neighborsOf(order[i])) {
        if (!parent.has(nb)) { parent.set(nb, order[i]); order.push(nb); }
      }
    }
    const fmtPlayer = (uid) => {
      const p = players[uid] || {};
      return `<b>${esc(p.name || '—')}</b>${p.username ? ' (@' + esc(p.username) + ')' : ''} — <code>${esc(uid)}</code>`;
    };
    const verOf = (p) => (p && p.walletVerified === true) ? 'موثّق ✅' : 'غير موثّق';
    const shown = order.slice(0, MULTI_LIST_CAP);
    const lines = shown.map((uid) => {
      if (uid === target) return `• ${fmtPlayer(uid)} ⬅️ <b>الحساب المطلوب</b> — ${verOf(players[uid])}`;
      const par = parent.get(uid);
      const via = par && par !== target ? ` (عن طريق <code>${esc(par)}</code>)` : '';
      return `• ${fmtPlayer(uid)} — ${verOf(players[uid])} — الربط: ${linkReason(players[uid], players[par])}${via}`;
    });
    let text = order.length > 1
      ? `⚠️ <b>الحساب ده عامل تعدد — مرتبط بـ ${order.length - 1} حساب</b>\n\n🌳 <b>شجرة الحسابات المرتبطة:</b>\n${lines.join('\n')}`
      : `✅ <b>الحساب ده مش مرتبط بأي حساب تاني</b>\n\n${lines.join('\n')}`;
    if (order.length > shown.length) text += `\n… ولسه فيه ${order.length - shown.length} حساب تاني في الشجرة`;
    await tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text });
  } catch (e) {
    // The command must never throw the webhook: log + a short reply.
    console.error('multi', e.message);
    try { await tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: '❌ حصلت مشكلة وأنا بجيب شجرة الحسابات، جرّب تاني.' }); } catch (e2) { /* a failed error reply must not throw either */ }
  }
}

let cfgCache = null;
// Who may pass the ownerOnly maintenance gate: the owner, plus any
// Telegram id on the settings/global.testUsers list.
function isTesterUid(uid, cfg) {
  if (OWNER_ID && String(uid) === OWNER_ID) return true;
  const list = (cfg && Array.isArray(cfg.testUsers)) ? cfg.testUsers : [];
  if (list.map(String).includes(String(uid))) return true;
  return isAdminUid(uid); // admins always pass the maintenance gate too
}

// Full admins (owner order 2026-11-15): the owner plus any Telegram id
// on settings/global.adminUsers. Reads the cached config — async
// callers refresh it first via getConfig().
function isAdminUid(uid) {
  if (OWNER_ID && String(uid) === OWNER_ID) return true;
  const list = (cfgCache && cfgCache.v && Array.isArray(cfgCache.v.adminUsers)) ? cfgCache.v.adminUsers : [];
  return list.map(String).includes(String(uid));
}

// Everyone who receives admin notifications, owner first, deduped.
function adminChatIds() {
  const ids = [];
  if (OWNER_ID) ids.push(String(OWNER_ID));
  const list = (cfgCache && cfgCache.v && Array.isArray(cfgCache.v.adminUsers)) ? cfgCache.v.adminUsers : [];
  for (const x of list) { const s = String(x); if (!ids.includes(s)) ids.push(s); }
  return ids;
}

const CONFIG_CACHE_MS = (() => { const v = Number(process.env.CONFIG_CACHE_MS); return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 60000; })(); // config cache TTL (owner load-reduction order 2026-11-15): settings change rarely; a Firebase-side edit applies within this window. Money values are NEVER cached — this covers config only.
async function getConfig() {
  if (cfgCache && Date.now() - cfgCache.t < CONFIG_CACHE_MS) return cfgCache.v;
  const s = await getVal(rtdb().ref('settings/global'));
  const v = { ...DEFAULTS, ...(s || {}) };
  delete v.botToken;
  cfgCache = { t: Date.now(), v };
  await loadHarvestedEmoji(); // the harvested premium-emoji map rides the same refresh cycle
  return v;
}
const PUBLIC_KEYS = ['brandTitle', 'coinSym', 'taskReward', 'bioReward', 'refAchReward1', 'refAchReward10', 'refAchReward25', 'refAchReward50', 'refAchReward100', 'refClaimPercent', 'refMinHold', 'minWithdraw', 'holdPercentReq', 'withdrawFeePercent', 'lvl1PerDay', 'buySwapUrl', 'channel1', 'channel2', 'channel3', 'botUsername'];
const publicConfig = (c) => Object.fromEntries(PUBLIC_KEYS.map((k) => [k, c[k]]));

// simple in-memory rate limiter (per server instance)
const hits = new Map();
function hit(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return false; }
  arr.push(now);
  hits.set(key, arr);
  if (hits.size > 20000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 120000) hits.delete(k);
  return true;
}
// verifyInfo/verifyCheck get 20/min (not the usual single digits): both
// are read-only or claim-guarded, and the Profile card BY DESIGN polls
// verifyCheck 6x at 5s intervals after a TonConnect payment — one poll
// burst plus a manual re-check must fit with room to spare, or the user
// hits this limiter for doing exactly what the UI told them to do. The
// global per-user (90/min) and per-IP caps still bound abuse.
const ACTION_LIMIT = { state: 20, collect: 6, daily: 6, task: 8, bioTask: 8, refAch: 8, wallet: 8, unlink: 6, refCollect: 6, withdraw: 4, verifyInfo: 20, verifyCheck: 20, setAvatar: 8 }; // per user per minute

function verifyInitData(initData) {
  if (!BOT_TOKEN) return { error: 'config' };
  if (typeof initData !== 'string' || initData.length === 0 || initData.length > 4096) return { error: 'invalid' };
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return { error: 'invalid' };
  params.delete('hash');
  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const expected = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest();
  if (!crypto.timingSafeEqual(Buffer.from(hash, 'hex'), expected)) return { error: 'invalid' };
  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > MAX_AUTH_AGE_SEC) return { error: 'expired' };
  try {
    const user = JSON.parse(params.get('user'));
    if (!user || !user.id) return { error: 'invalid' };
    return { user, startParam: params.get('start_param') || '', authDate };
  } catch (e) { return { error: 'invalid' }; }
}

/* ---------- Telegram Premium (custom) emoji — ported from the AdVOLT
   messages bot (volt_messages_bot.js): the owner's own icon packs
   (TONEmoji + NewsEmoji) and substitution table, copied verbatim.
   Applied centrally in tg() for sendMessage text and sendPhoto
   captions below; on a Telegram emoji/icon rejection the send
   retries once fully stripped. */
// ─── Telegram Premium (custom) emoji ─────────────────────────────
// Owner-chosen packs: TONEmoji + NewsEmoji (t.me/addemoji/TONEmoji,
// t.me/addemoji/NewsEmoji). pz() wraps every matched emoji char in a
// <tg-emoji> tag inside HTML messages; if Telegram rejects a send
// (e.g. the bot owner's account has no Premium), callers fall back to
// the plain text via pzStrip() — no message is ever lost.
const PREMIUM_EMOJI = {
  '❌': '5210952531676504517',
  '⚠': '5447644880824181073',
  '⚠️': '5447644880824181073',
  '💰': '5417924076503062111',
  '💎': '5462902520215002477',
  '📊': '5203993413346680064',
  '🔄': '5375338737028841420',
  '⚡': '5456140674028019486',
  '⚡️': '5456140674028019486',
  '🔍': '5231012545799666522',
  '🚫': '5240241223632954241',
  '⛔': '5260293700088511294',
  '⛔️': '5260293700088511294',
  '💸': '5233326571099534068',
  '🔗': '5440410042773824003',
  '🏆': '5188344996356448758',
  '🔴': '5411225014148014586',
  '🔓': '5429405838345265327',
  '🚀': '5188481279963715781',
  '🎉': '5461151367559141950',
  '💡': '5422439311196834318',
  '🏷': '5298877105000439431',
  '🏷️': '5298877105000439431',
  '📩': '5472239203590888751',
  '📌': '5397782960512444700',
  '⚙': '5341715473882955310',
  '⚙️': '5341715473882955310',
  '🟢': '5416081784641168838',
  '➕': '5397916757333654639',
  '🚨': '5395695537687123235',
  '🪙': '5382164415019768638',
  '🔑': '5307843983102204243',
  '💳': '5472250091332993630',
  '🧾': '5204242830687494041',
  '👛': '5215420556089776398',
  '🏦': '5238132025323444613',
  '🎮': '5361741454685256344',
  '🔒': '5296369303661067030',
  '📈': '5298614648138919107',
  '💱': '5377336227533969892',
  '🔖': '5222444124698853913',
  'ℹ': '5334544901428229844',
  'ℹ️': '5334544901428229844',
};
const PREMIUM_KEYS = Object.keys(PREMIUM_EMOJI).sort((a, b) => b.length - a.length);
// Near-match substitutions (owner order 2026-11-11): bot emojis with no exact sticker in the
// NewsEmoji/TONEmoji packs are rendered with the closest-looking pack sticker instead.
// orig char -> [display char, custom_emoji_id]
const PREMIUM_SUBS = {
  '✅': ['✔️', '5206607081334906820'],
  '🔹': ['💎', '5462902520215002477'],
  '👤': ['🗣️', '5460795800101594035'],
  '📭': ['✉️', '5253742260054409879'],
  '📋': ['🧾', '5204242830687494041'],
  '🆔': ['🔑', '5307843983102204243'],
  '📬': ['📩', '5472239203590888751'],
  '📤': ['🛫', '5463424023734014980'],
  '🕐': ['⌛', '5386367538735104399'],
  '📡': ['🌐', '5447410659077661506'],
  '👥': ['🙂', '5461117441612462242'],
  '📦': ['🛍', '5229064374403998351'],
  '📢': ['📣', '5424818078833715060'],
  '📥': ['📩', '5472239203590888751'],
  '📝': ['✏️', '5395444784611480792'],
  '🎁': ['🎉', '5461151367559141950'],
  '📨': ['📩', '5472239203590888751'],
  '📅': ['🗓', '5413879192267805083'],
  '🟣': ['🔴', '5411225014148014586'],
  '🔁': ['🔄', '5375338737028841420'],
  '👋': ['🫴', '5440457429147997980'],
  '🎨': ['✨', '5325547803936572038'],
  '🖼': ['🖥', '5282843764451195532'],
  '♻': ['🔄', '5375338737028841420'],
  '♻️': ['🔄', '5375338737028841420'],
  '💓': ['🔋', '5307905813451397794'],
  '🪪': ['💳', '5472250091332993630'],
  '🕒': ['⌛', '5386367538735104399'],
  '🤝': ['👍', '5337080053119336309'],
  '📰': ['📣', '5424818078833715060'],
  '🕵': ['🔍', '5231012545799666522'],
  '🎛': ['⚙️', '5341715473882955310'],
  '🔢': ['⌨️', '5298975240708187753'],
  '📺': ['🖥', '5282843764451195532'],
  '🎬': ['▶️', '5264919878082509254'],
  '📁': ['🧾', '5204242830687494041'],
  // Zero-loss substitutions (owner order 2026-11-14): the display char IS
  // the wanted glyph itself — 🎯 borrows the target sticker 🔘 maps to,
  // and 🌩️ renders with the premium ⚡ sticker. NOTE: '🎯' must stay
  // BEFORE '🔘' in this literal — PREMIUM_SUB_KEYS is a stable
  // length-sort and 🔘's display char is 🎯 itself, so processing 🎯
  // first keeps the 🔘 replacement from being re-wrapped by the 🎯 pass.
  '🎯': ['🎯', '5461009483314517035'],
  '🔘': ['🎯', '5461009483314517035'],
  '🌩️': ['⚡', '5456140674028019486'],
};
const PREMIUM_SUB_KEYS = Object.keys(PREMIUM_SUBS).sort((a, b) => b.length - a.length);
function pz(text) {
  if (!text || typeof text !== 'string' || text.indexOf('tg-emoji') !== -1) return text;
  let out = text;
  for (const ch of PREMIUM_KEYS) {
    if (out.indexOf(ch) === -1) continue;
    out = out.split(ch).join('<tg-emoji emoji-id="' + PREMIUM_EMOJI[ch] + '">' + ch + '</tg-emoji>');
  }
  for (const orig of PREMIUM_SUB_KEYS) {
    if (out.indexOf(orig) === -1) continue;
    const sub = PREMIUM_SUBS[orig];
    out = out.split(orig).join('<tg-emoji emoji-id="' + sub[1] + '">' + sub[0] + '</tg-emoji>');
  }
  return pzHarvested(out);
}
function pzStrip(text) {
  return String(text || '').replace(/<tg-emoji emoji-id="[^"]+">/g, '').replace(/<\/tg-emoji>/g, '');
}

// ─── Harvested premium emoji (RTDB node `premiumEmoji`) ─────────────
// Real per-glyph IDs harvested by the owner's bot tools (/emojihunt,
// /emojipack, the entity extractor — see handleOwnerTools below) and
// persisted at the TOP-LEVEL RTDB node `premiumEmoji` (deliberately NOT
// inside settings/global). pz() consults this map LAST — after
// PREMIUM_EMOJI and PREMIUM_SUBS — and so does premiumIconFor(). The
// map rides the config cache's refresh cycle (getConfig reloads it on
// every cache miss) and is updated in-process the moment a tool saves,
// so a fresh harvest takes effect without a restart. A missing node is
// simply an empty map, never an error.
let harvestedEmoji = {};
let harvestedKeys = [];
function refreshHarvestedKeys() {
  harvestedKeys = Object.keys(harvestedEmoji).sort((a, b) => b.length - a.length);
}
async function loadHarvestedEmoji() {
  try {
    const v = await getVal(rtdb().ref('premiumEmoji'));
    harvestedEmoji = (v && typeof v === 'object') ? v : {};
  } catch (e) { /* keep whatever is cached — harvesting is best-effort */ }
  refreshHarvestedKeys();
}
// found: { bareChar -> custom_emoji_id }. Each char is stored under BOTH
// its bare form and its U+FE0F form (same id); ref.update() merges into
// the node, so entries already stored are never deleted.
async function saveHarvestedEmoji(found) {
  const updates = {};
  for (const [ch, id] of Object.entries(found || {})) {
    if (!ch || !id) continue;
    updates[ch] = String(id);
    updates[ch + '\uFE0F'] = String(id); // second key form: char + U+FE0F
  }
  if (!Object.keys(updates).length) return;
  Object.assign(harvestedEmoji, updates);
  refreshHarvestedKeys();
  try { await rtdb().ref('premiumEmoji').update(updates); }
  catch (e) { console.error('premiumEmoji save', e.message); }
}
function pzHarvested(text) {
  if (!harvestedKeys.length || typeof text !== 'string') return text;
  // Only the segments OUTSIDE existing <tg-emoji> tags are processed, so
  // a harvested char that already appears as a wrapped display char
  // (e.g. 🎯 inside the 🔘 substitution tag) is never re-wrapped. The
  // single regex pass (keys are length-sorted, longest first) also stops
  // a shorter key from matching inside a tag this pass just inserted
  // (e.g. bare ⚔ inside a freshly wrapped ⚔️).
  const re = new RegExp(harvestedKeys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  const parts = text.split(/(<tg-emoji[^>]*>[\s\S]*?<\/tg-emoji>)/g);
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i].replace(re, (ch) => '<tg-emoji emoji-id="' + harvestedEmoji[ch] + '">' + ch + '</tg-emoji>');
  }
  return parts.join('');
}

// ─── Premium button icons ─────────────────────────────────────────────
// Button TEXT always renders as plain text in Telegram, but an inline
// button may carry a custom-emoji icon via icon_custom_emoji_id (verified
// accepted for this bot, 2026-11-11). premiumizeKeyboard() adds the icon
// matching the first mapped emoji in each button label. The Viking server
// applies it centrally in tg() to every sendMessage and sendPhoto, so all
// keyboards are covered at once;
// if Telegram ever rejects an icon, the send retries once with the icons
// stripped — a message can never be lost over a button icon.
function premiumIconFor(text) {
  if (!text || typeof text !== 'string') return null;
  for (const ch of PREMIUM_KEYS) if (text.indexOf(ch) !== -1) return { icon: PREMIUM_EMOJI[ch], ch };
  for (const orig of PREMIUM_SUB_KEYS) if (text.indexOf(orig) !== -1) return { icon: PREMIUM_SUBS[orig][1], ch: orig };
  for (const ch of harvestedKeys) if (text.indexOf(ch) !== -1) return { icon: harvestedEmoji[ch], ch };
  return null;
}
function premiumizeKeyboard(rm) {
  if (!rm || !Array.isArray(rm.inline_keyboard)) return rm;
  for (const row of rm.inline_keyboard) {
    if (!Array.isArray(row)) continue;
    for (const b of row) {
      if (!b || typeof b.text !== 'string' || b.icon_custom_emoji_id) continue;
      const hit = premiumIconFor(b.text);
      if (!hit) continue;
      // Owner order 2026-11-11: once the premium icon is set, the plain emoji
      // must come OUT of the label — one icon per button, not two.
      const stripped = b.text.replace(hit.ch, '').replace(/\s+/g, ' ').trim();
      if (!stripped) continue; // emoji-only label: leave the button untouched
      b.icon_custom_emoji_id = hit.icon;
      b.text = stripped;
    }
  }
  return rm;
}
function stripPremiumIcons(rm) {
  if (!rm || !Array.isArray(rm.inline_keyboard)) return rm;
  for (const row of rm.inline_keyboard) {
    if (!Array.isArray(row)) continue;
    for (const b of row) if (b) delete b.icon_custom_emoji_id;
  }
  return rm;
}

const TG_API_BASE = (process.env.TG_API_BASE || 'https://api.telegram.org').replace(/\/+$/, ''); // env override exists for local testing (stub Telegram API)

/* Outbound send pacing (owner load-reduction order 2026-11-15):
   sendMessage / sendPhoto are funnelled through one paced chain —
   never two sends in flight, at least TG_SEND_GAP_MS between them —
   so a burst (a hundred referral DMs inside a minute) can no longer
   trip Telegram's own rate limits and silently drop messages. The
   call still resolves with the send's real result; only its timing
   is smoothed. Reads (getChatMember, getMe) and interactive answers
   are NOT paced — they must stay instant. Payouts never pass through
   here at all: they are chain operations, not messages. */
const TG_SEND_GAP_MS = 50;
let tgSendChain = Promise.resolve();
let tgLastSendAt = 0;
function tgPaced(fn) {
  const run = async () => {
    const wait = TG_SEND_GAP_MS - (Date.now() - tgLastSendAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try { return await fn(); } finally { tgLastSendAt = Date.now(); }
  };
  const p = tgSendChain.then(run, run);
  tgSendChain = p.then(() => {}, () => {});
  return p;
}
async function tg(method, body) {
  if (method === 'sendMessage' || method === 'sendPhoto') return tgPaced(() => tgSend(method, body));
  return tgSend(method, body);
}
async function tgSend(method, body) {
  if (!BOT_TOKEN) return null;
  let payload = body;
  if ((method === 'sendMessage' || method === 'sendPhoto') && body && typeof body === 'object') {
    // Premium custom-emoji treatment, applied centrally like the VOLT bot:
    // HTML parse mode when the caller didn't pick one, the message text
    // (sendMessage) or the photo caption (sendPhoto) wrapped via pz(),
    // button icons via premiumizeKeyboard(). Work on copies so a
    // caller-owned keyboard object is never mutated.
    payload = { ...body };
    const field = method === 'sendMessage' ? 'text' : 'caption';
    if (typeof payload[field] === 'string') {
      if (!payload.parse_mode) payload.parse_mode = 'HTML';
      payload[field] = pz(payload[field]);
    }
    if (payload.reply_markup) {
      payload.reply_markup = premiumizeKeyboard(JSON.parse(JSON.stringify(payload.reply_markup)));
    }
  }
  const send = async (p) => {
    try {
      const r = await fetch(`${TG_API_BASE}/bot${BOT_TOKEN}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p),
        signal: AbortSignal.timeout(10000) // never let a hung Telegram call wedge a request
      });
      return await r.json();
    } catch (e) { console.error('telegram', method, e.message); return null; }
  };
  let res = await send(payload);
  // Telegram rejected a custom emoji / button icon (e.g. EMOJI_ID_INVALID):
  // retry exactly once with the plain, stripped variant — a message is
  // never lost over an icon.
  if ((method === 'sendMessage' || method === 'sendPhoto') && res && !res.ok && /emoji/i.test(String(res.description || ''))) {
    const stripped = { ...payload };
    if (typeof stripped.text === 'string') stripped.text = pzStrip(stripped.text);
    if (typeof stripped.caption === 'string') stripped.caption = pzStrip(stripped.caption);
    if (stripped.reply_markup) stripped.reply_markup = stripPremiumIcons(stripped.reply_markup);
    const retry = await send(stripped);
    if (retry) res = retry;
  }
  return res;
}
/* Resolve a configured channel value to a getChatMember chat_id: a numeric
   id stored by the admin, an @handle, a public t.me/<name> (or t.me/s/<name>)
   link, or a private t.me/c/<id> link (-> -100<id>). Anything else (e.g. a
   t.me/+invite link) cannot be queried and returns null. */
function chatIdOf(url) {
  const s = String(url || '').trim();
  if (!s) return null;
  if (/^-?\d{5,}$/.test(s)) return Number(s);
  const priv = /(?:t\.me|telegram\.me)\/c\/(\d+)/.exec(s);
  if (priv) return Number('-100' + priv[1]);
  const m = /^@([A-Za-z][A-Za-z0-9_]{3,})$/.exec(s) || /(?:t\.me|telegram\.me)\/(?:s\/)?([A-Za-z][A-Za-z0-9_]{3,})/.exec(s);
  if (m) return '@' + m[1];
  return null;
}
/* REAL server-side membership check via the bot (getChatMember).
   Returns 'member' | 'not-member' | 'unknown'. 'unknown' means the check
   itself could not be performed (unparseable channel config, Telegram
   error — typically because the bot is not a member/admin of the channel,
   or no bot token) and callers must fail CLOSED, never grant. */
async function memberStatus(url, userId) {
  const chatId = chatIdOf(url);
  if (chatId === null) return 'unknown';
  const j = await tg('getChatMember', { chat_id: chatId, user_id: Number(userId) });
  if (!j || !j.ok || !j.result) return 'unknown'; // bot cannot check this channel
  const s = j.result.status;
  if (s === 'creator' || s === 'administrator' || s === 'member') return 'member';
  if (s === 'restricted') return j.result.is_member === true ? 'member' : 'not-member';
  return 'not-member'; // left / kicked
}
async function isMember(url, userId) {
  const m = await memberStatus(url, userId);
  return m === 'member' ? true : m === 'not-member' ? false : null;
}

/* The bot's own username, resolved from the Bot API (getMe) and cached in
   process. The bio task verifies against the REAL username of the deployed
   bot; if getMe is unreachable we fall back to the admin-set
   settings.botUsername. A failed lookup is negatively cached for 60 s so
   state() (a hot path) never hammers Telegram. */
let botMeCache = { username: '', t: 0 };
async function resolveBotUsername(cfg) {
  if (botMeCache.username) return botMeCache.username;
  if (!botMeCache.t || Date.now() - botMeCache.t >= 60000) {
    botMeCache.t = Date.now();
    const j = await tg('getMe');
    if (j && j.ok && j.result && j.result.username) {
      botMeCache.username = String(j.result.username).replace(/^@/, '').trim();
      return botMeCache.username;
    }
  }
  return String((cfg && cfg.botUsername) || '').replace(/^@/, '').trim() || null;
}

const TONAPI_BASE = (process.env.TONAPI_BASE || 'https://tonapi.io/v2').replace(/\/+$/, ''); // env override exists for local testing, like TG_API_BASE
async function ton(path) {
  const r = await fetch(TONAPI_BASE + path, { headers: TONAPI_KEY ? { Authorization: 'Bearer ' + TONAPI_KEY } : {}, signal: AbortSignal.timeout(10000) });
  if (r.status === 404 || r.status === 400) return null;
  if (!r.ok) fail(502, 'TON network is busy, try again');
  return r.json();
}
async function rawAddress(addr) {
  // Already-raw addresses normalise locally — the same result the
  // tonapi parse returns for this shape. TonConnect always reports
  // the raw form, so binds stop spending a network call on parsing
  // (and stop failing when tonapi rate-limits). Only user-friendly
  // forms still go to the parse endpoint.
  const mRaw = /^(-?\d+):([0-9a-fA-F]{64})$/.exec(String(addr || '').trim());
  if (mRaw) return mRaw[1] + ':' + mRaw[2].toLowerCase();
  const j = await ton('/address/' + encodeURIComponent(addr) + '/parse');
  if (!j || !j.raw_form) fail(400, 'Invalid wallet address');
  return j.raw_form;
}
/* Hold reads (permanent fix, owner order 2026-11-15): every hold in
   the system funnels through here, so the resilience lives here —
   (a) concurrent reads of the same wallet coalesce into one call
   (the boot / double-tap bursts), and (b) when tonapi fails — its
   rate limit is per-IP and this server speaks with one voice — the
   SAME balance is read from toncenter v3, a different provider with
   its own limits. Only when BOTH providers fail does the read throw,
   and every caller already treats a throw as "no fresh data", never
   as a state change. Deliberately NO result cache: a sync must
   reflect the chain NOW (buy coins -> sync -> activation flips on
   that very read); a cached value broke exactly that loop in
   testing (t11 R6 / t12) and is not worth the saved calls. */
const holdInflight = new Map();
async function jettonHoldViaToncenter(raw) {
  const j = await tonc('/jetton/wallets?owner_address=' + encodeURIComponent(raw) + '&jetton_address=' + encodeURIComponent(JETTON) + '&limit=1');
  // Only a well-formed answer counts as a read: a genuine "no jetton
  // wallet" is 200 + an empty list. A null (404/400) or malformed
  // body is a FAILED read and must throw — never a fake zero that
  // could deactivate a referral or misreport a balance.
  if (!j || !Array.isArray(j.jetton_wallets)) fail(502, 'TON network is busy, try again');
  const w = j.jetton_wallets[0];
  if (!w) return 0;
  return parseFloat(w.balance || '0') / Math.pow(10, await jettonDecimals());
}
async function jettonHold(raw) {
  const flying = holdInflight.get(raw);
  if (flying) return flying;
  const run = (async () => {
    try {
      const j = await ton('/accounts/' + encodeURIComponent(raw) + '/jettons/' + JETTON);
      return !j ? 0 : parseFloat(j.balance || '0') / Math.pow(10, (j.jetton && j.jetton.decimals) || 9);
    } catch (e) {
      return jettonHoldViaToncenter(raw); // fallback provider; its own throw propagates
    }
  })();
  holdInflight.set(raw, run);
  run.then(() => holdInflight.delete(raw), () => holdInflight.delete(raw));
  return run;
}
/* The jetton's decimals, resolved once from tonapi jetton info and
   cached for the process — the same source and `decimals || 9`
   semantics jettonHold uses (metadata.decimals arrives as a string).
   A failed lookup is NOT cached: the caller gets the 9 fallback for
   this call and the next call retries the resolution. */
let _jettonDecimals = null;
async function jettonDecimals() {
  if (_jettonDecimals !== null) return _jettonDecimals;
  try {
    const j = await ton('/jettons/' + JETTON);
    const n = Number(j && j.metadata ? j.metadata.decimals : undefined) || 9;
    if (Number.isFinite(n) && n > 0 && n <= 18) { _jettonDecimals = n; return n; }
  } catch (e) { /* fall through to the uncached fallback */ }
  return 9;
}

/* ---------- wallet verification: TON Center v3 reads (owner order 2026-11-14) ---------- */
/* Normalise any TON address (raw "0:ab..", bounceable/non-bounceable
   user-friendly base64) to lowercase raw form, locally — no API call.
   User-friendly form is 36 bytes: flags(1) workchain(1, signed)
   hash(32) crc16(2). Unknown shapes pass through lowercased so a
   comparison simply fails instead of throwing. */
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
/* Inverse of toRawAddress for DISPLAY in bot messages (mirrors the
   frontend friendlyAddr helper byte for byte): raw "wc:hex64" -> the
   non-bounceable user-friendly form (0x51 tag) Tonkeeper shows.
   Anything not in raw form passes through unchanged. */
function toFriendlyAddress(addr) {
  const s = String(addr || '').trim();
  const m = /^(-?\d+):([0-9a-fA-F]{64})$/.exec(s);
  if (!m) return s;
  const payload = [0x51, parseInt(m[1], 10) & 0xff];
  for (let i = 0; i < 64; i += 2) payload.push(parseInt(m[2].substr(i, 2), 16));
  let crc = 0; // CRC16-XModem over the 34 payload bytes
  for (const b of payload) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
    crc &= 0xffff;
  }
  const bytes = Buffer.from([...payload, (crc >> 8) & 0xff, crc & 0xff]);
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const shortFriendlyAddress = (addr) => { const f = toFriendlyAddress(addr); return f ? f.slice(0, 6) + '...' + f.slice(-6) : ''; };
/* "14 Nov 2026" — the one date shape bot messages use (no slashes, so
   nothing can be bidi-shuffled in mixed-direction chats). */
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDayMonYear(ts) {
  const d = new Date(Number(ts) || Date.now());
  return d.getDate() + ' ' + MONTHS_EN[d.getMonth()] + ' ' + d.getFullYear();
}
async function tonc(path) {
  // Key pool: start at the round-robin key; a 429 (that key's own
  // rate limit) retries with the NEXT key, up to one full pass over
  // the pool. 404/400 keep their "no data" meaning on any key; any
  // other failure still fails the read, exactly as before — a pool
  // must never turn a failed read into a fake answer.
  const attempts = Math.max(1, TONCENTER_KEYS.length);
  for (let i = 0; i < attempts; i++) {
    const key = nextToncKey();
    const r = await fetch(TON_API_BASE + path, { headers: key ? { 'X-API-Key': key } : {}, signal: AbortSignal.timeout(10000) });
    if (r.status === 404 || r.status === 400) return null;
    if (r.status === 429 && i < attempts - 1) continue;
    if (!r.ok) fail(502, 'TON network is busy, try again');
    return r.json();
  }
  fail(502, 'TON network is busy, try again');
}
/* Transactions of one account, newest (desc) or oldest (asc) first.
   TON_API_BASE is toncenter v3, whose ordering parameter is
   `sort=asc|desc`. (The tonapi.io name `sort_order` is silently
   IGNORED by toncenter — every query then falls back to newest-first,
   which once made the age lookup read the newest transaction instead
   of the oldest. Regression-covered in test_local5 V14.) */
async function toncTransactions(rawAddr, limit, order) {
  const j = await tonc('/transactions?account=' + encodeURIComponent(rawAddr) + '&limit=' + limit + '&sort=' + order);
  return (j && Array.isArray(j.transactions)) ? j.transactions : [];
}
/* Wallet age in whole days = time since the wallet's FIRST transaction
   (the ascending query). A wallet with no transactions at all is 0. */
async function fetchWalletAgeDays(raw) {
  const txs = await toncTransactions(raw, 1, 'asc');
  if (!txs.length) return 0;
  const first = Number(txs[0].now) || 0; // toncenter v3: unix seconds
  if (!first) return 0;
  return Math.max(0, Math.floor((Date.now() / 1000 - first) / 86400));
}
/* The age is cached on the player (walletAgeDays/walletAgeAt/
   walletAgeFor) for at most WALLET_AGE_CACHE_MS and only ever for the
   wallet it was computed for — a different wallet always recomputes.
   The cache also carries a version stamp (walletAgeV): caches written
   before the ascending-query fix (which, via the sort_order bug,
   stored the age of the NEWEST transaction) carry no stamp and are
   recomputed once, then stamped and behave as before. */
const WALLET_AGE_CACHE_MS = 3 * 60 * 60 * 1000;
const WALLET_AGE_CACHE_V = 2;
async function walletAgeDays(ref, p, wallet) {
  if (p.walletAgeV === WALLET_AGE_CACHE_V && p.walletAgeFor === wallet && p.walletAgeAt && (Date.now() - p.walletAgeAt) < WALLET_AGE_CACHE_MS && Number(p.walletAgeDays) >= 0) {
    return Number(p.walletAgeDays);
  }
  const days = await fetchWalletAgeDays(wallet);
  try { await ref.update({ walletAgeDays: days, walletAgeAt: Date.now(), walletAgeFor: wallet, walletAgeV: WALLET_AGE_CACHE_V }); } catch (e) { /* the cache is advisory */ }
  return days;
}
/* Decode the text comment of an incoming message, robustly:
   1. the API's own decoded body (message_content.decoded, type
      'text_comment') when present;
   2. otherwise the raw body hex: a text comment's body is the 4-byte
      opcode 0x00000000 followed by the UTF-8 text;
   3. a plain `comment` field, if an API variant provides one. */
function decodeTextComment(inMsg) {
  const mc = (inMsg && inMsg.message_content) || null;
  if (mc) {
    const dec = mc.decoded;
    if (dec && typeof dec.comment === 'string' && dec.comment) return dec.comment;
    const bodyHex = typeof mc.body === 'string' ? mc.body : (typeof mc.body_hex === 'string' ? mc.body_hex : '');
    if (/^(?:[0-9a-fA-F]{2})+$/.test(bodyHex)) {
      const buf = Buffer.from(bodyHex, 'hex');
      if (buf.length > 4 && buf.readUInt32BE(0) === 0) {
        const txt = buf.subarray(4).toString('utf8');
        if (txt) return txt;
      }
    }
  }
  if (inMsg && typeof inMsg.comment === 'string' && inMsg.comment) return inMsg.comment;
  return null;
}
const inMsgSourceRaw = (inMsg) => toRawAddress((inMsg && typeof inMsg.source === 'object' && inMsg.source) ? (inMsg.source.address || '') : ((inMsg && inMsg.source) || ''));
/* toncenter v3 returns tx.hash in BASE64 (44 chars, may contain '+',
   '/' and a trailing '='), NOT hex. Canonicalise to lowercase hex
   before ANY use: the hex form is the verifyClaims RTDB key (a base64
   '/' would be an illegal, path-splitting RTDB key) and the stored
   verifyTx (hex is what tonviewer links expect). A 64-char hex string
   passes through lowercased; a base64 string (standard or URL-safe
   alphabet) is used only if it decodes to exactly 32 bytes; anything
   else yields '' and the transaction is skipped as malformed. */
function txHashHex(h) {
  const s = String(h || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) {
    try {
      const buf = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      if (buf.length === 32) return buf.toString('hex');
    } catch (e) { /* fall through */ }
  }
  return '';
}
/* Keep the inviter's referral entry for this player in sync with the
   player's verified state (the Friends list renders the entry's flag —
   storing it on the entry keeps state() free of per-referral lookups).
   Best-effort by design: it must never fail a verify/void operation. */
async function syncRefVerifiedFlag(uid, verified) {
  try {
    const me = await getVal(P(uid));
    const inv = me && me.invitedBy;
    if (!inv) return;
    await txUpdate(P(inv).child('referrals'), (cur) => {
      const refs = asRefArray(cur);
      if (!refs.some((r) => String(r.id) === String(uid))) return { skip: true };
      return { value: refs.map((r) => (String(r.id) === String(uid) ? { ...r, verified: !!verified } : r)) };
    });
  } catch (e) { console.error('refVerifiedFlag', e.message); }
}

/* Same keep-in-sync pattern for the player's chosen avatar: the
   inviter's Friends list renders the entry's avatar image, so the
   choice is mirrored onto the referral entry when it is set.
   Best-effort by design: it must never fail the setAvatar action. */
async function syncRefAvatar(uid, n) {
  try {
    const me = await getVal(P(uid));
    const inv = me && me.invitedBy;
    if (!inv) return;
    await txUpdate(P(inv).child('referrals'), (cur) => {
      const refs = asRefArray(cur);
      if (!refs.some((r) => String(r.id) === String(uid))) return { skip: true };
      return { value: refs.map((r) => (String(r.id) === String(uid) ? { ...r, avatar: n } : r)) };
    });
  } catch (e) { console.error('refAvatar', e.message); }
}

/* ---------- referral DMs to the inviter (owner order 2026-11-15) ----------
   Two messages, in the same simple style as the payout DM — tg()
   applies pz() premium-emoji wrapping and premium button icons
   centrally. Best-effort by design: a failed DM never fails the
   action that triggered it. */
async function sendRefJoinDM(inviterId, user) {
  try {
    const cfg = await getConfig();
    const botUname = await resolveBotUsername(cfg);
    const kb = botUname ? { inline_keyboard: [[{ text: '⚔️ Open VIKING', url: `https://t.me/${botUname}/app` }]] } : undefined;
    const name = esc(String((user && user.first_name) || 'Warrior').trim() || 'Warrior');
    await tg('sendMessage', { chat_id: String(inviterId), text: `🎉 <b>New Referral!</b>\n👤 <b>${name}</b> joined VIKING with your link.\n💡 When they verify their wallet and hold 200+ ${esc(cfg.coinSym)}, they turn <b>Active ✅</b> — and you earn <b>5%</b> of their mining.`, reply_markup: kb });
  } catch (e) { console.error('ref join dm', e.message); }
}
async function sendRefActiveDM(inviterId, inviteeName, cfg) {
  try {
    const botUname = await resolveBotUsername(cfg);
    const kb = botUname ? { inline_keyboard: [[{ text: '⚔️ Open VIKING', url: `https://t.me/${botUname}/app` }]] } : undefined;
    const name = esc(String(inviteeName || 'Warrior').trim() || 'Warrior');
    await tg('sendMessage', { chat_id: String(inviterId), text: `✅ <b>Referral Active!</b>\n👤 <b>${name}</b> is now <b>Active ✅</b>\n💰 You earn <b>5%</b> of everything they mine — it lands in your pending referral profits.`, reply_markup: kb });
  } catch (e) { console.error('ref active dm', e.message); }
}

/* Append this player to the inviter's referral list (exactly once)
   and send the inviter the new-referral DM. Used by state() at
   signup, by state()'s late-attribution path and by the bot /start
   ref_ param. Returns true when the entry was actually appended. */
/* Referral-list writes transact on the referrals CHILD, never on
   the whole inviter record (owner order 2026-11-15: a referral must
   be recorded immediately, not in a later repair cycle). A
   whole-record transaction aborts whenever ANY field of the hot
   inviter record changes mid-flight — his own activity, commission
   accruals, other joins — and under a signup burst that contention
   is exactly what silently ate appends (Hisham: 25 of 26). On the
   child path only actual referral-list writes contend with each
   other. RTDB arrays can read back as objects when sparse, so
   normalize defensively. */
const asRefArray = (v) => (Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.values(v) : []));
async function appendRefEntry(inviterId, entry) {
  return txUpdate(P(inviterId).child('referrals'), (cur) => {
    const refs = asRefArray(cur);
    if (refs.length >= 3000) return { skip: true, out: false }; // cap re-checked on the freshest value
    if (refs.some((r) => String(r.id) === String(entry.id))) return { skip: true, out: 'exists' };
    return { value: [...refs, entry], out: true };
  });
}
/* Last-resort in-process ladder for an append that still lost its
   contention war twice in a row: retry over the next ~15 s in the
   background (the caller's action is already complete), and let
   the 10-minute repair sweep be the final net after that. */
function retryRefAppendLater(inviterId, entry, user, silent) {
  // Record the handoff in the repair queue FIRST (owner load order
  // 2026-11-15): if this process dies before the ladder finishes,
  // the repair tick picks the entry up from the queue instead of the
  // loss waiting for the daily full reconciliation. The queue entry
  // is removed the moment the append lands, by whichever path lands it.
  rtdb().ref('refRepairQueue/' + entry.id).set({ inv: String(inviterId), at: Date.now() }).catch(() => {});
  (async () => {
    for (const wait of [1500, 4000, 10000]) {
      await new Promise((r) => setTimeout(r, wait));
      const ok = await appendRefEntry(inviterId, entry).catch(() => false);
      if (ok) {
        rtdb().ref('refRepairQueue/' + entry.id).remove().catch(() => {});
        if (!silent) sendRefJoinDM(inviterId, user).catch(() => {});
        return;
      }
    }
    console.error('refAppend deferred to repair sweep', inviterId, entry.id);
  })().catch(() => {});
}
async function attributeReferral(user, inviterId, deviceHash, opts) {
  const silent = !!(opts && opts.silent); // repair-sweep appends: no join DM (it is not a live join)
  const atTs = (opts && Number(opts.at)) || Date.now(); // the sweep backfills the real join time
  try {
    const inv = await getVal(P(inviterId));
    if (!inv) return false;
    const dup = !!(inv.deviceHash && deviceHash && inv.deviceHash === deviceHash);
    const entry = { id: String(user.id), name: clean(user.first_name || 'Warrior', 64), deviceHash: deviceHash || '', status: dup ? '⚠️ Duplicate' : 'Pending ⏳', profit: 0, at: atTs, avatar: 0 };
    let appended = await appendRefEntry(inviterId, entry).catch(() => false);
    if (!appended) { // the burst outlasted the tx retries: one quick inline retry before handing off
      await new Promise((r) => setTimeout(r, 400));
      appended = await appendRefEntry(inviterId, entry).catch(() => false);
    }
    if (!appended) { retryRefAppendLater(inviterId, entry, user, silent); return false; }
    if (!silent) sendRefJoinDM(inviterId, user).catch(() => {});
    return true;
  } catch (e) { console.error('attributeReferral', e.message); return false; }
}

/* Referral activation is a LIVE state (see the ACTIVE_REF_STATUS
   note): ACTIVE while the invitee is wallet-verified AND holds at
   least refMinHold. This re-evaluates it after every event that can
   change either input (wallet sync, verification completion,
   unlink): the invitee's commission gate (refBonusPaid) and the
   inviter's entry status follow the state in both directions —
   selling below the minimum deactivates again. The became-active DM
   fires only on the FIRST upward flip (entry.activeDmAt latch).
   '⚠️ Duplicate' entries never flip. Best-effort: never fails the
   caller's action. */
async function syncReferralActive(uid, cfg) {
  try {
    uid = String(uid);
    const me = await getVal(P(uid));
    if (!me || !me.invitedBy) return;
    const need = Number(cfg && cfg.refMinHold) || 200;
    const active = me.walletVerified === true && (Number(me.hold) || 0) >= need;
    if ((me.refBonusPaid === true) !== active) {
      await txUpdate(P(uid), (d) => {
        if (d === null) return { skip: true };
        const a = d.walletVerified === true && (Number(d.hold) || 0) >= need;
        if ((d.refBonusPaid === true) === a) return { skip: true };
        return { value: { ...d, refBonusPaid: a } };
      });
    }
    const invId = String(me.invitedBy);
    const res = await txUpdate(P(invId).child('referrals'), (cur) => {
      let changed = false, dm = false;
      const refs = asRefArray(cur).map((r) => {
        if (String(r.id) !== uid) return r;
        if (r.status === '⚠️ Duplicate') return r;
        const want = active ? 'Verified ✅' : 'Pending ⏳';
        if (r.status === want) return r;
        changed = true;
        const nr = { ...r, status: want };
        if (active && !nr.activeDmAt) { nr.activeDmAt = Date.now(); dm = true; }
        return nr;
      });
      if (!changed) return { skip: true, out: null };
      return { value: refs, out: { dm } };
    });
    if (res && res.dm) await sendRefActiveDM(invId, me.name, cfg || await getConfig());
  } catch (e) { console.error('refActiveSync', e.message); }
}

const newPlayer = (user, extra) => ({
  id: String(user.id), name: clean(user.first_name || 'Warrior', 64), username: clean(user.username || 'user', 64),
  deviceHash: '', mined: 0, hold: 0, lastCollectTime: Date.now(), walletAddr: '', banned: false, invitedBy: null,
  refBonusPaid: false, refCommissionEarned: 0, pendingRefComm: 0, lastWithdrawTime: 0, adsWatched: 0,
  earnMining: 0, earnDaily: 0, earnTasks: 0, earnRef: 0, // lifetime earnings by source (owner review card, 2026-11-14); pre-existing players read as 0 until they earn again
  lastAdUtcDay: dayOf(Date.now()), task1Done: false, task2Done: false, task3Done: false, bioTaskDone: false, dailyStreak: 0, lastDailyCheckIn: 0,
  lastSeen: Date.now(), referrals: [], createdAt: Date.now(), avatar: 0, ...extra
});

/* Create the caller's player record if it does not exist yet (same
   newPlayer defaults as state, but with NO referral side-effects —
   referral attribution happens only in state). Every player action calls
   this first, so a legitimate first-run call can no longer hit the
   'User not found' 404: the frontend fires `state` and TonConnect's
   `wallet` independently at cold start (and taps can land before state),
   and each action used to assume the record was already there. */
async function ensurePlayer(c) {
  const ref = P(c.user.id);
  const dev = clean(c.body.deviceHash, 64);
  const created = await txUpdate(ref, (cur) => {
    if (cur !== null) return { skip: true, out: false };
    return { value: newPlayer(c.user, { deviceHash: dev, invitedBy: null }), out: true };
  });
  if (created) await assignUserNo(c.user.id);
  return ref;
}

/* ---------- permanent sequential user numbers (wallet verification) ----------
   Every player owns a permanent sequential userNo (1, 2, 3, ...),
   assigned at creation from the meta/counters `users` counter — the
   same transaction pattern withdraw() uses for withdrawal numbers.
   Players created before this feature get their number lazily, the
   first time a verify action needs it (ensureUserNo). A number, once
   assigned, never changes; a concurrently assigned duplicate number is
   simply skipped (a gap), never reused. Best-effort: a numbering
   failure must never break the action that triggered it. */
async function assignUserNo(uid) {
  // One full retry before giving up: the counter and the player write
  // are both txUpdate-hardened now, so a failure here is transient
  // (contention / a just-restarted process), and verifyInfo's
  // last-resort 500 must stay reserved for genuinely impossible
  // states — never for a real player on a cold process.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ref = P(uid);
      const cur = await getVal(ref);
      if (!cur) return 0; // no record to number — callers ensure it first; nothing to retry
      if (Number(cur.userNo) > 0) return Number(cur.userNo);
      const n = await bumpCounter('users');
      if (!n) continue;
      const out = await txUpdate(ref, (d) => {
        if (d === null) return { skip: true, out: 0 };
        if (Number(d.userNo) > 0) return { skip: true, out: Number(d.userNo) }; // a racer assigned first; n stays a gap
        return { value: { ...d, userNo: n }, out: n };
      });
      if (out) return out;
      const again = await getVal(ref); // out 0 with no error: re-read — a racer's number may have landed
      if (again && Number(again.userNo) > 0) return Number(again.userNo);
    } catch (e) { console.error('assignUserNo', e.message); }
  }
  return 0;
}
async function ensureUserNo(uid) {
  const p = await getVal(P(uid));
  if (p && Number(p.userNo) > 0) return Number(p.userNo);
  return assignUserNo(uid);
}

async function withdrawalsOfUser(uid) {
  const v = await getVal(rtdb().ref('withdrawals').orderByChild('userId').equalTo(String(uid)).limitToFirst(50));
  return Object.values(v || {});
}

/* ---------- player actions ---------- */
async function state(c) {
  const ref = P(c.user.id);
  const dev = clean(c.body.deviceHash, 64);
  const existing = await getVal(ref);
  if (existing) {
    // Contention diet (round 3, incident 2026-11-14): lastSeen (with
    // the name/username refresh riding along) is written ONLY when
    // the stored value is older than 60 s — state is the app's
    // heartbeat, and an unthrottled write here kept the whole player
    // record hot enough to starve whole-record transactions into
    // 'maxretry' aborts. Regression-covered in test_local6 (W4).
    if (Date.now() - (existing.lastSeen || 0) > 60000) await ref.update({ name: clean(c.user.first_name || 'Warrior', 64), username: clean(c.user.username || 'user', 64), lastSeen: Date.now(), ...(dev ? { deviceHash: dev } : {}) });
    // Late attribution (owner order 2026-11-15): a record created by a
    // bot first contact (/start or the write-access welcome — both
    // ensurePlayer with no referral data) or by an action that raced
    // ahead of the first state used to lose its inviter forever,
    // because attribution only ran at record creation. A still-fresh
    // account (created < 24 h ago, nothing earned yet) arriving WITH
    // a referral param is attributed now instead.
    if (!existing.invitedBy) {
      const spL = String(c.startParam || '').replace(/^ref_/, '').trim();
      const fresh = Date.now() - (Number(existing.createdAt) || 0) < 86400000;
      const earned = (Number(existing.mined) || 0) > 0 || (Number(existing.earnDaily) || 0) > 0 || (Number(existing.earnTasks) || 0) > 0 || (Number(existing.earnRef) || 0) > 0;
      if (fresh && !earned && isId(spL) && spL !== String(c.user.id)) {
        const invL = await getVal(P(spL));
        if (invL && (invL.referrals || []).length < 3000) {
          const set = await txUpdate(ref, (cur) => {
            if (cur === null || cur.invitedBy) return { skip: true, out: false };
            return { value: { ...cur, invitedBy: spL }, out: true };
          });
          if (set) await attributeReferral(c.user, spL, dev);
        }
      }
    }
  } else {
    const sp = String(c.startParam || '').replace(/^ref_/, '').trim();
    let inv = null, invRef = null;
    if (isId(sp) && sp !== String(c.user.id)) { invRef = P(sp); inv = await getVal(invRef); }
    const ok = !!(inv && (inv.referrals || []).length < 3000);
    // create-if-absent, atomically on the player node (was one Firestore tx
    // together with the inviter's referral append — see PORT_NOTES.md)
    const created = await txUpdate(ref, (cur) => {
      if (cur !== null) return { skip: true, out: false };
      return { value: newPlayer(c.user, { deviceHash: dev, invitedBy: ok ? sp : null }), out: true };
    });
    if (created) await assignUserNo(c.user.id); // permanent sequential userNo from meta/counters (see assignUserNo)
    if (created && ok) await attributeReferral(c.user, sp, dev);
  }
  await noteSignals(String(c.user.id), clientKeys(c.body.fp));
  // Multi-account detection (report-only): refresh this player's linked
  // accounts. The links accumulate silently — no alert is sent (owner
  // order 2026-11-14; the owner reads them via /multi). Strictly
  // best-effort — wrapped so it can never fail, block or delay state.
  // Load diet (owner order 2026-11-15): the recompute reads the whole
  // device/fingerprint registries, so it runs at most once per
  // MULTI_CHECK_MS per player — or immediately when the presented
  // device changed — instead of on every single state call. The
  // stored links a /multi report or a withdrawal card reads can
  // therefore lag a few minutes behind a brand-new link.
  const devKey = clean(c.body._deviceId, 128) || dev; // the device identity the link detection actually keys on (the AntiFraud deviceId, legacy deviceHash as fallback)
  const multiDue = !existing || !!(devKey && devKey !== (existing.multiDeviceKey || '')) || Date.now() - (Number(existing.multiCheckedAt) || 0) > MULTI_CHECK_MS;
  if (multiDue) {
    try { await updateMultiLinks(String(c.user.id), c.body); } catch (e) { console.error('multiLinks', e.message); }
    ref.update({ multiCheckedAt: Date.now(), ...(devKey ? { multiDeviceKey: devKey } : {}) }).catch(() => {});
  }
  const [player, wds] = await Promise.all([getVal(ref), withdrawalsOfUser(c.user.id)]);
  // Lazy userNo heal for pre-feature (legacy) records: assignUserNo
  // only runs at record creation and ensureUserNo only inside the
  // verify flow, so a player created before userNo existed kept
  // userNo 0 forever — and every userNo-gated surface in the app
  // (avatar picker, Mine verification state, the VIKING-<userNo>
  // verify comment) silently skipped him (live case 2026-11-15:
  // RaseenRacing_Support + ABO MALAZ browsed unverified with a gold
  // COLLECT button). state() is the one action every session calls,
  // so the record heals here on its next open and THIS response
  // already carries the number. No-op for everyone else.
  if (player && !(Number(player.userNo) > 0)) {
    const healedNo = await ensureUserNo(c.user.id);
    if (healedNo) player.userNo = healedNo;
  }
  // Expose the bot's REAL username (getMe, cached) so the bio task shows and
  // verifies the right handle; falls back to the settings value inside
  // resolveBotUsername, and publicConfig's copy is kept when both are empty.
  const botUsername = await resolveBotUsername(c.cfg);
  return { player: publicPlayer(player), settings: { ...publicConfig(c.cfg), ...(botUsername ? { botUsername } : {}) }, withdrawals: wds, now: Date.now() };
}

/* Avatar choice (owner order 2026-11-14): at first registration the
   player picks one of the 8 painted avatars; the choice is stored on
   the player record and mirrored onto the inviter's referral entry
   (syncRefAvatar) — it replaces the Telegram photo everywhere the app
   shows the player (profile card, Friends lists). Re-picking is
   allowed (harmless, idempotent) but the app only offers it once. */
async function setAvatar(c) {
  const n = Number(c.body.n);
  if (!Number.isInteger(n) || n < 1 || n > 8) fail(400, 'Bad avatar');
  const ref = await ensurePlayer(c);
  const out = await txUpdate(ref, (d) => {
    if (d === null) return { error: new Fail(404, 'User not found') };
    if (d.banned === true) return { error: new Fail(403, 'Account banned') };
    // Owner order 2026-11-14: the warrior is chosen ONCE, forever.
    if (Number.isInteger(d.avatar) && d.avatar >= 1 && d.avatar <= 8) return { error: new Fail(409, 'Avatar already chosen') };
    return { value: { ...d, avatar: n }, out: { success: true, avatar: n } };
  });
  await syncRefAvatar(c.user.id, n);
  return out;
}

/* ---------- mining levels («packages»): server mirror of the app table ----------
   The levels live in the frontend (customLevels in viking_frontend/
   index.html) — LEVEL_DEFS below is a value-for-value copy of that
   array and the two MUST stay in sync: collect() pays the player's
   REAL level rate from this table (owner order 2026-11-14 — profit
   follows the package your hold puts you in, not a flat rate).
   buildLevelsTable() replicates the frontend's rebuildLevelsTable()
   operation for operation: levels 1-30 take LEVEL_DEFS scaled by
   cfg.lvl1PerDay (scale = lvl1PerDay/250, perDay kept to 2dp);
   levels 31-100 derive recursively from level 30 (reqHold ×1.15,
   perDay ×1.12, both Math.round). levelPerDay() replicates
   getCurrentLevelObj: the highest level whose reqHold <= hold,
   iterating ascending and stopping at the first level that fails.
   The hold is the player's synced on-chain hold (player.hold — the
   same value state() ships and the app itself tiers on). */
const LEVEL_DEFS = [
  { req: 0, day: 250 }, { req: 200, day: 300 }, { req: 1250, day: 500 }, { req: 2500, day: 750 },
  { req: 5000, day: 1000 }, { req: 7000, day: 1200 }, { req: 10000, day: 1500 }, { req: 12000, day: 1800 },
  { req: 15000, day: 2500 }, { req: 18000, day: 2800 }, { req: 22000, day: 3200 }, { req: 26000, day: 3600 },
  { req: 31000, day: 4100 }, { req: 37000, day: 4700 }, { req: 44000, day: 5400 }, { req: 52000, day: 6200 },
  { req: 61000, day: 7100 }, { req: 71000, day: 8100 }, { req: 82000, day: 9200 }, { req: 95000, day: 10500 },
  { req: 110000, day: 12000 }, { req: 126000, day: 13600 }, { req: 144000, day: 15400 }, { req: 164000, day: 17400 },
  { req: 186000, day: 19600 }, { req: 210000, day: 22000 }, { req: 236000, day: 24600 }, { req: 264000, day: 27400 },
  { req: 294000, day: 30400 }, { req: 326000, day: 33600 }
];
function buildLevelsTable(cfg) {
  const scale = (Number(cfg && cfg.lvl1PerDay) || 250) / 250;
  const table = [];
  for (let i = 1; i <= 100; i++) {
    let reqHold, perDay;
    if (i <= 30) {
      reqHold = LEVEL_DEFS[i - 1].req;
      perDay = +(LEVEL_DEFS[i - 1].day * scale).toFixed(2);
    } else {
      const prevLvl = table[i - 2];
      reqHold = Math.round(prevLvl.reqHold * 1.15);
      perDay = Math.round(prevLvl.perDay * 1.12);
    }
    table.push({ level: i, reqHold, perDay });
  }
  return table;
}
function levelPerDay(table, hold) {
  let cur = table[0];
  for (const l of table) { if (hold >= l.reqHold) cur = l; else break; }
  return cur.perDay;
}

async function collect(c) {
  const ref = await ensurePlayer(c);
  // The table is built ONCE per call, outside the transaction: the
  // txUpdate callback may re-run under contention, so inside it the
  // rate is a pure function of this table + the fresh record's hold.
  const levels = buildLevelsTable(c.cfg);
  const out = await txUpdate(ref, (d) => {
    if (d === null) return { error: new Fail(404, 'User not found') };
    if (d.banned === true) return { error: new Fail(403, 'Account banned') };
    // Mining requires a VERIFIED wallet (owner order 2026-11-15): the
    // app gates the whole UI behind the wallet-verification page, and
    // the server enforces the same rule for the mining action itself.
    if (d.walletVerified !== true) return { error: new Fail(403, 'Verify your wallet first') };
    const now = Date.now();
    const elapsed = Math.max(0, (now - (Number(d.lastCollectTime) || now)) / 1000);
    if (elapsed < MIN_COLLECT_SEC) return { error: new Fail(400, 'Wait 10 seconds') };
    const added = Math.min(86400, elapsed) * (levelPerDay(levels, Number(d.hold) || 0) / 86400);
    return {
      value: { ...d, mined: (Number(d.mined) || 0) + added, earnMining: (Number(d.earnMining) || 0) + added, lastCollectTime: now },
      out: { added, inviterId: d.invitedBy && d.refBonusPaid ? String(d.invitedBy) : null }
    };
  });
  if (out.inviterId) {
    // the inviter's commission was written in the same Firestore transaction;
    // here it is a second transaction right after (see PORT_NOTES.md)
    await txUpdate(P(out.inviterId), (inv) => {
      if (inv === null || inv.banned === true) return { skip: true };
      const cut = out.added * (Number(c.cfg.refClaimPercent) || 0) / 100;
      const refs = (inv.referrals || []).map((r) => (String(r.id) === String(c.user.id) ? { ...r, profit: (Number(r.profit) || 0) + cut } : r));
      return { value: { ...inv, pendingRefComm: (Number(inv.pendingRefComm) || 0) + cut, referrals: refs } };
    });
  }
  return { success: true, added: out.added };
}

async function daily(c) {
  const ref = await ensurePlayer(c);
  return txUpdate(ref, (d) => {
    if (d === null) return { error: new Fail(404, 'User not found') };
    if (d.banned === true) return { error: new Fail(403, 'Account banned') };
    const now = Date.now(), today = dayOf(now), last = dayOf(d.lastDailyCheckIn || 0);
    if (today === last) return { error: new Fail(400, 'Already claimed today') };
    const streak = last === today - 1 ? ((d.dailyStreak || 0) % 7) + 1 : 1;
    const reward = DAILY[streak - 1];
    return {
      value: { ...d, dailyStreak: streak, lastDailyCheckIn: now, mined: (Number(d.mined) || 0) + reward, earnDaily: (Number(d.earnDaily) || 0) + reward },
      out: { success: true, reward, streak }
    };
  });
}

async function task(c) {
  const n = Number(c.body.n);
  if (n !== 1 && n !== 2 && n !== 3) fail(400, 'Bad task');
  const ref = await ensurePlayer(c);
  // REAL membership verification through the bot (getChatMember) before any
  // reward: not a member -> 403; the check itself unavailable (bot not in
  // the channel / bad channel config) -> 503, fail CLOSED with a distinct
  // error so the owner can tell the two apart. (Previously an unverifiable
  // channel silently PASSED the check and the reward was granted on the
  // client's say-so.)
  const m = await memberStatus(c.cfg['channel' + n], c.user.id);
  if (m === 'not-member') fail(403, 'Join the channel first');
  if (m === 'unknown') fail(503, 'Channel check unavailable — bot must be an admin in the channel');
  const key = 'task' + n + 'Done';
  return txUpdate(ref, (d) => {
    if (d === null) return { error: new Fail(404, 'User not found') };
    if (d.banned === true) return { error: new Fail(403, 'Account banned') };
    if (d[key]) return { error: new Fail(400, 'Already claimed') };
    const reward = Number(c.cfg.taskReward) || 50;
    return {
      value: { ...d, [key]: true, mined: (Number(d.mined) || 0) + reward, earnTasks: (Number(d.earnTasks) || 0) + reward },
      out: { success: true, reward }
    };
  });
}

/* Bio task: the player adds the bot's username to their Telegram bio.
   Verified server-side with getChat (the Bot API returns the other party's
   bio for a private chat) against the bot's REAL username (getMe). Like the
   channel tasks this fails CLOSED, with three distinct answers so the
   player always knows the next step:
   - getChat itself fails (Telegram error) → 503, nothing granted.
   - getChat works but the bio is EMPTY/missing → 403 'Bio not visible
     yet': Telegram only exposes a user's bio to a bot the user has
     actually started/messaged, so a Mini-App-only user reads as bio-less
     even if they set one — the fix is to open the bot chat and press
     Start, NOT to edit the bio again.
   - bio present but the username is not in it → 403 'Add the bot
     username to your bio first'.
   Granted once, flag bioTaskDone. The check and the credit are shared
   (checkBio / creditBioReward) with the in-bot /start flow below. */
/* Shared bio check for BOTH verification paths (the API bioTask action
   and the bot's /start flow below): resolves the bot's REAL username and
   reads the user's bio via getChat. Never throws; returns a status:
   'unavailable' (no username resolvable / getChat failed — fail closed),
   'empty' (bio missing or blank), 'mismatch' (bio present without the
   username), 'match'. */
async function checkBio(userId, cfg) {
  const uname = await resolveBotUsername(cfg);
  if (!uname) return { status: 'unavailable', uname: null };
  const j = await tg('getChat', { chat_id: Number(userId) });
  if (!j || !j.ok || !j.result) return { status: 'unavailable', uname };
  const bio = String(j.result.bio || '');
  if (!bio.trim()) return { status: 'empty', uname };
  if (!bio.toLowerCase().includes(uname.toLowerCase())) return { status: 'mismatch', uname };
  return { status: 'match', uname };
}
/* The one and only bio-reward credit path — used by the API action and
   by the bot flow, so both credit identically (cfg.bioReward added to
   mined, bioTaskDone flag) and the transaction guard keeps it
   once-only per player. */
function creditBioReward(userId, cfg) {
  return txUpdate(P(userId), (d) => {
    if (d === null) return { error: new Fail(404, 'User not found') };
    if (d.banned === true) return { error: new Fail(403, 'Account banned') };
    if (d.bioTaskDone) return { error: new Fail(400, 'Already claimed') };
    const reward = Number(cfg.bioReward) || 50;
    return {
      value: { ...d, bioTaskDone: true, mined: (Number(d.mined) || 0) + reward, earnTasks: (Number(d.earnTasks) || 0) + reward },
      out: { success: true, reward }
    };
  });
}

/* Legacy API path (already-open Mini Apps): same shared check + credit,
   with the original Fail answers preserved verbatim. New clients use
   the in-bot flow below — the card no longer calls this action — but
   cached clients still can, and it stays fully functional. */
async function bioTask(c) {
  await ensurePlayer(c);
  const chk = await checkBio(c.user.id, c.cfg);
  if (chk.status === 'unavailable') fail(503, 'Bio check unavailable — open the bot chat and press Start, then retry');
  if (chk.status === 'empty') fail(403, 'Bio not visible yet — open the bot chat, press Start, then claim again');
  if (chk.status === 'mismatch') fail(403, 'Add the bot username to your bio first');
  return creditBioReward(c.user.id, c.cfg);
}

/* ---------- bot updates: in-bot bio verification (webhook) ----------
   The bot used to be send-only; it now ALSO receives Telegram updates
   through a webhook on this same endpoint, for one job: the in-bot bio
   verification flow (owner decision 2026-11-14 ~03:21). Telegram only
   shows a user's bio to a bot at/after the user's latest interaction
   with the bot, so the in-app Claim often read a stale/empty bio; when
   the user instead opens the bot via the app's deep link and presses
   Start, THAT interaction refreshes the bio and the bot verifies it on
   the spot, granting through the very same creditBioReward() the API
   bioTask action uses.

   Security: setWebhook is self-registered (once per process, by
   ensureWebhook below) with secret_token = first 32 hex chars of
   sha256(BOT_TOKEN); Telegram echoes it in the
   x-telegram-bot-api-secret-token header of every update post and the
   handler answers 401 to anything else. Delivery dedupe: an
   in-process FIFO set of processed update_ids (cap 500) plus the
   bioTaskDone transaction guard make crediting idempotent even if
   Telegram retries a delivery or the set was trimmed. */
const APP_URL = 'https://ahmedrabieharoun-eng.github.io/viking/';
const WELCOME_IMAGE_URL = 'https://ahmedrabieharoun-eng.github.io/viking/welcome-banner.webp?v=2'; // ?v=2: the titled banner replaced v1 at the same path; Telegram caches photo-by-URL
const webhookSecret = () => crypto.createHash('sha256').update(BOT_TOKEN || '').digest('hex').slice(0, 32);
let webhookRegistered = false;
function ensureWebhook() {
  if (webhookRegistered || !BOT_TOKEN) return;
  webhookRegistered = true;
  // Fire-and-forget: a failed registration (Telegram down, local stub)
  // must never crash or delay boot; the next process start retries.
  Promise.resolve(tg('setWebhook', {
    url: process.env.PUBLIC_URL || 'https://viking-miner-server.onrender.com/',
    secret_token: webhookSecret(),
    allowed_updates: ['message', 'callback_query']
  })).catch(() => {});
}
const seenUpdateIds = new Set();
function markUpdateSeen(updateId) {
  if (seenUpdateIds.has(updateId)) return false;
  seenUpdateIds.add(updateId);
  while (seenUpdateIds.size > 500) seenUpdateIds.delete(seenUpdateIds.values().next().value); // FIFO trim
  return true;
}

const BIO_TEXTS = {
  en: {
    // AdVOLT-mirrored copy (owner order 2026-11-14): NO name line —
    // header / intro / 3 bullets / closing, one sentence per line.
    // (The name argument is kept for signature parity with ar/ru.)
    welcome: (name) => `⚔️ Welcome to VIKING MINER! ⚔️\n\nJump in and start your Viking saga:\n⛏ Mine VIKING daily and climb from level 1 to 100.\n🪙 Crush tasks & seize loot to fill your vaults.\n😀 Invite friends, earn 5% of their mining!\n\nTap the button below and start mining now! 🚀`,
    warrior: 'Warrior',
    openApp: '⚔️ Open VIKING',
    payoutsChannel: '💸 Payouts',
    newsChannel: '📰 News',
    granted: (reward, sym) => `✅ Bio verified! +${reward} ${sym} was added to your balance.`,
    already: '✅ Your bio is already verified — the reward was already added.',
    instruct: (uname) => `📝 To verify your bio:\n1. Add @${uname} to your Telegram bio.\n2. Then open this link again and press Start: https://t.me/${uname}?start=bio`,
    retry: '⚠️ Could not check your bio right now — please try again in a minute.',
    // Wallet-verification success DM (owner order 2026-11-14): sent
    // once, by whichever path completes the verification (the in-app
    // Check button or the background deposit watcher) — the verified
    // badge announcement with the wallet facts.
    verifiedMsg: (o) => `🛡️✅ <b>WALLET VERIFIED!</b> ✅🛡️\n\n🎉 Congratulations, <b>${o.name}</b> — your wallet is now <b>VERIFIED</b> and the blue badge shines next to your name everywhere in VIKING MINER! 💎\n\n👛 <b>Wallet:</b> <code>${o.walletShort}</code>\n🗓️ <b>Wallet age:</b> ${o.ageDays} days\n🔢 <b>Your mark:</b> VIKING-${o.userNo}\n📅 <b>Verified on:</b> ${o.date}\n\n⛏️ SKÅL, verified warrior! ⚔️`
  },
  ar: {
    welcome: (name) => `⚔️🔥 قف أيها المحارب! 🔥⚔️\n\nأهلًا بك يا ${name} في VIKING MINER — لا مكان للضعفاء هنا؛ الكنز لا ينتظر إلا من يجرؤ! 🛡️\n\n⛏ في أراضي الشمال المتجمدة تبدأ ملحمتك: عدّن VIKING كل ٢٤ ساعة، اشحذ فأسك، واصعد من محارب مبتدئ (المستوى 1) إلى أسطورة تُغنّى في فالهالا (المستوى 100)! 🏆 كل مستوى يضاعف قوة تعدينك — وخزائنك تفيض بالذهب 💰\n\nطريقك إلى المجد:\n• ⚔️ عدّن كل يوم واخطف حصتك قبل غيرك\n• 🪙 اسحق المهام واجمع غنائمها\n• 😀 ادعُ إخوتك في السلاح: عملات فورية + ٥٪ من تعدينهم، للأبد!\n\n💎 اسحب أرباحك إلى محفظة TON — ذهب حقيقي في يدك.\n\n🩸 الضعفاء يتراجعون. أيها الفايكنج… اضغط الزر! 👇`,
    warrior: 'محارب',
    openApp: '⚔️ افتح التطبيق',
    payoutsChannel: '💸 قناة السحوبات',
    newsChannel: '📢 قناة الأخبار',
    granted: (reward, sym) => `✅ تم التحقق من البايو! اتضاف +${reward} ${sym} لرصيدك.`,
    already: '✅ البايو بتاعك متحقق منه قبل كده — المكافأة اتضافت خلاص.',
    instruct: (uname) => `📝 عشان يتحقق البايو:\n١. ضيف @${uname} في البايو بتاعك في تيليجرام.\n٢. وبعدين افتح اللينك ده تاني ودوس Start: https://t.me/${uname}?start=bio`,
    retry: '⚠️ مش قادر أتحقق من البايو دلوقتي — جرب تاني بعد دقيقة.'
  },
  ru: {
    welcome: (name) => `⚔️🔥 СТОЙ, ВОИН! 🔥⚔️\n\nДобро пожаловать, ${name}, в VIKING MINER — слабым здесь не место; сокровища ждут лишь тех, кто осмелится! 🛡️\n\n⛏ В ледяных землях Севера начинается твоя сага: добывай VIKING каждые 24 часа, точи свой топор и пройди путь от новичка (уровень 1) до легенды, воспетой в Вальхалле (уровень 100)! 🏆 Каждый уровень умножает твою силу добычи — а хранилища переполняются золотом 💰\n\nТвой путь к славе:\n• ⚔️ Добывай каждый день и забирай свою долю первым\n• 🪙 Сокрушай задания и собирай добычу\n• 😀 Зови братьев по оружию: мгновенные монеты + 5% от их добычи, навсегда!\n\n💎 Выводи заработок на свой TON-кошелёк — настоящее золото в твоих руках.\n\n🩸 Слабые отступают. Викинги… жмите кнопку! 👇`,
    warrior: 'воин',
    openApp: '⚔️ Открыть приложение',
    payoutsChannel: '💸 Канал выплат',
    newsChannel: '📢 Канал новостей',
    granted: (reward, sym) => `✅ Био подтверждено! +${reward} ${sym} добавлено на ваш баланс.`,
    already: '✅ Ваше био уже подтверждено — награда уже была добавлена.',
    instruct: (uname) => `📝 Чтобы подтвердить био:\n1. Добавьте @${uname} в био вашего Telegram.\n2. Затем снова откройте эту ссылку и нажмите Start: https://t.me/${uname}?start=bio`,
    retry: '⚠️ Не удалось проверить био прямо сейчас — попробуйте ещё раз через минуту.'
  }
};
const bioLangOf = (from) => {
  // Owner order 2026-11-14: the bot's language is FIXED to English for
  // everyone — the welcome and all bio replies are always the English
  // texts, whatever the user's Telegram language_code says. The ar/ru
  // text objects above stay in the code untouched for a possible
  // future revert; just restore the language_code selection below.
  void from;
  return 'en';
  // (previous selection, kept for the revert:)
  // const lc = String((from && from.language_code) || '').toLowerCase();
  // return lc.startsWith('ar') ? 'ar' : lc.startsWith('ru') ? 'ru' : 'en';
};

/* ---------- owner-only emoji-harvest tools ----------
   Mirrors the AdVOLT messages bot's admin tools, adapted to this
   server's raw tg() style. Gated STRICTLY to OWNER_ID in a private
   chat (and, like everything on this endpoint, behind the webhook
   secret); anyone else falls through to the normal handling,
   completely untouched. Three tools:
     /emojipack <name> — list every sticker of a t.me/addemoji pack as
                         'char → <code>custom_emoji_id</code>'.
     /emojihunt        — sweep the built-in candidate packs for the
                         WANTED glyphs and report what is still missing.
     (extractor)       — any other owner message that carries custom-
                         emoji entities gets an ID listing back.
   Whenever a WANTED glyph's ID surfaces through ANY of the three, it
   is auto-saved into the RTDB `premiumEmoji` node, so pz() starts
   rendering that glyph premium (animated) everywhere the bot writes. */
const EMOJI_WANTED = ['⚔', '🔥', '🛡', '❄', '⛏', '🩸', '👇', '🌩', '🎯'];
const EMOJI_WANTED_SET = new Set(EMOJI_WANTED);
const EMOJI_PACK_CANDIDATES = ['RestrictedEmoji']; // Telegram's official animated standard-emoji pack (ex-Telemoji); extend this list to hunt more packs
const bareEmoji = (ch) => String(ch || '').replace(/\uFE0F/g, '');

async function emojiPack(chatId, name) {
  if (!name) {
    await tg('sendMessage', { chat_id: chatId, text: 'Usage: /emojipack <packName> — the name from a t.me/addemoji/<packName> link' });
    return;
  }
  const j = await tg('getStickerSet', { name });
  if (!j || !j.ok || !j.result) {
    await tg('sendMessage', { chat_id: chatId, text: '❌ ' + esc((j && j.description) || 'pack not found') });
    return;
  }
  const stickers = Array.isArray(j.result.stickers) ? j.result.stickers : [];
  const found = {};
  for (const s of stickers) {
    const bare = bareEmoji(s && s.emoji);
    if (bare && EMOJI_WANTED_SET.has(bare) && s.custom_emoji_id) found[bare] = String(s.custom_emoji_id);
  }
  await saveHarvestedEmoji(found);
  const total = stickers.length;
  let lines = stickers.map((s) => `${(s && s.emoji) || '?'} → <code>${s && s.custom_emoji_id}</code>`);
  let truncated = false;
  if (lines.length > 200) { lines = lines.slice(0, 200); truncated = true; }
  const build = () => `🎨 <b>${esc(j.result.title || name)}</b> (${total})\n\n${lines.join('\n')}${truncated ? `\n… (truncated — ${total} stickers in the pack)` : ''}`;
  let body = build();
  while (body.length > 3900 && lines.length > 1) { lines.pop(); truncated = true; body = build(); }
  await tg('sendMessage', { chat_id: chatId, text: body });
}

async function emojiHunt(chatId) {
  const sections = [];
  for (const name of EMOJI_PACK_CANDIDATES) {
    const j = await tg('getStickerSet', { name });
    if (!j || !j.ok || !j.result) {
      sections.push(`🎨 <b>${esc(name)}</b>\n❌ ${esc((j && j.description) || 'pack not found')}`);
      continue;
    }
    const stickers = Array.isArray(j.result.stickers) ? j.result.stickers : [];
    const found = {};
    const lines = [];
    for (const s of stickers) {
      const bare = bareEmoji(s && s.emoji);
      if (bare && EMOJI_WANTED_SET.has(bare) && s.custom_emoji_id) {
        if (!(bare in found)) lines.push(`${s.emoji} → <code>${s.custom_emoji_id}</code>`);
        found[bare] = String(s.custom_emoji_id);
      }
    }
    await saveHarvestedEmoji(found);
    sections.push(`🎨 <b>${esc(j.result.title || name)}</b> — ${lines.length} wanted found\n${lines.join('\n') || '(none of the wanted glyphs in this pack)'}`);
  }
  const have = new Set(Object.keys(harvestedEmoji).map(bareEmoji));
  const missing = EMOJI_WANTED.filter((w) => !have.has(w));
  sections.push(missing.length ? `Still missing: ${missing.join(' ')}` : '✅ All wanted emoji harvested!');
  await tg('sendMessage', { chat_id: chatId, text: sections.join('\n\n') });
}

/* Returns true when a tool consumed the message. Runs BEFORE the
   /start handling. Also dispatched here, under the same admin
   gate: /multi <telegramId> — the on-demand multi-account link tree
   (see multiTree; owner order 2026-11-14) — and /withdrawals, the
   pending-withdrawal review walk (see the withdrawal-review
   section; owner order 2026-11-14). The entity extractor only
   fires when the text does NOT start with '/', so it can never
   swallow the owner's /start, /emojipack, /emojihunt or /multi
   messages. */
async function handleOwnerTools(msg, text) {
  if (!msg.from) return false;
  await getConfig();
  if (!isAdminUid(msg.from.id)) return false;
  const chatId = msg.chat.id;
  if (/^\/emojihunt(@\w+)?(\s|$)/.test(text)) { await emojiHunt(chatId); return true; }
  const pm = /^\/emojipack(@\w+)?(?:\s+(\S+))?/.exec(text);
  if (pm) { await emojiPack(chatId, (pm[2] || '').trim()); return true; }
  const mm = /^\/multi(@\w+)?(?:\s+(.+))?$/.exec(text);
  if (mm) { await multiTree(chatId, (mm[2] || '').trim()); return true; }
  if (/^\/withdrawals(@\w+)?(\s|$)/.test(text)) { await startWdReview(chatId); return true; }
  if (text.startsWith('/')) return false; // commands (incl. /start) never reach the extractor
  const rawText = typeof msg.text === 'string' ? msg.text : (typeof msg.caption === 'string' ? msg.caption : '');
  const ents = [].concat(msg.entities || [], msg.caption_entities || []);
  const customs = ents.filter((e) => e && e.type === 'custom_emoji' && e.custom_emoji_id);
  if (!customs.length) return false;
  const byId = new Map(); // distinct custom emoji only, first occurrence wins
  for (const e of customs) if (!byId.has(String(e.custom_emoji_id))) byId.set(String(e.custom_emoji_id), e);
  const lines = [];
  const found = {};
  for (const [id, e] of byId) {
    const glyph = rawText.substring(e.offset, e.offset + e.length); // Telegram offsets are UTF-16 code units; JS slicing matches
    lines.push(`${glyph} → <code>${id}</code>`);
    const bare = bareEmoji(glyph);
    if (bare && EMOJI_WANTED_SET.has(bare)) found[bare] = id;
  }
  await saveHarvestedEmoji(found);
  await tg('sendMessage', { chat_id: chatId, text: `🎨 Premium emoji IDs:\n\n${lines.join('\n')}` });
  return true;
}

/* One /start message (private chats only; anything else is ignored).
   Param 'bio' = the dedicated verification flow: always answers with
   the outcome (granted / already / instructions / retry) and is the
   ONLY bot path that checks or credits the bio task. A plain /start
   sends ONE welcome message — the banner photo with the simple
   welcome copy as its caption and the keyboard attached (owner order
   2026-11-14; plain-text fallback only if the photo send fails) —
   and never touches the bio task at all: no check, no credit, no
   grant or 'already verified' note (owner order 2026-11-14: bio
   messages only when the bio task is explicitly requested). A
   matching unclaimed bio is credited only via /start bio or the API
   bioTask action. A message carrying write_access_allowed — first
   contact via the direct app link, where the user never sends
   /start — triggers the same welcome, but ONLY for a genuinely new
   player (owner order 2026-11-14). */

/* The welcome message itself: ONE sendPhoto — the banner photo
   carrying the welcome copy as its caption and the keyboard attached
   (owner order 2026-11-14; the copy is sized to fit Telegram's
   1024-char caption limit). If that send fails (bad photo URL,
   Telegram hiccup), fall back to the plain text message with the
   same copy + keyboard so the greeting is never lost. Shared by
   plain /start and the write_access_allowed trigger below — both
   deliver the identical message. */
async function sendWelcome(chatId, cfg, T, displayName) {
  // Owner-approved welcome layout: Open App alone on row 1; news
  // (cfg.channel1) then payouts (cfg.channel2) side by side on row 2 —
  // AdVOLT's order (News | Payments), owner order 2026-11-14 — each
  // included only when its cfg URL is a non-empty string. tg() attaches
  // the premium button icons and strips the plain label emoji.
  // Row 1 is a plain URL button to the bot's own app link
  // (https://t.me/<bot>/app), NOT a web_app button: Telegram renders a
  // web_app button as a detached bar under the message, while a URL
  // button renders glued to the message as a classic inline keyboard —
  // the AdVOLT welcome look (owner order 2026-11-14). The username is
  // resolved at runtime via resolveBotUsername (getMe-cached); only if
  // it cannot be resolved do we fall back to the web_app button, so
  // the Open button never breaks.
  const botUname = await resolveBotUsername(cfg);
  const openBtn = botUname
    ? { text: T.openApp, url: `https://t.me/${botUname}/app` }
    : { text: T.openApp, web_app: { url: APP_URL } };
  const rows = [[openBtn]];
  const channelRow = [];
  if (typeof cfg.channel1 === 'string' && cfg.channel1.trim()) channelRow.push({ text: T.newsChannel, url: cfg.channel1 });
  if (typeof cfg.channel2 === 'string' && cfg.channel2.trim()) channelRow.push({ text: T.payoutsChannel, url: cfg.channel2 });
  if (channelRow.length) rows.push(channelRow);
  const welcomeKb = { inline_keyboard: rows };
  const photoRes = await tg('sendPhoto', {
    chat_id: chatId, photo: WELCOME_IMAGE_URL, caption: T.welcome(displayName),
    reply_markup: welcomeKb
  });
  if (!photoRes || !photoRes.ok) {
    await tg('sendMessage', {
      chat_id: chatId, text: T.welcome(displayName),
      reply_markup: welcomeKb
    });
  }
}

async function handleBotMessage(msg) {
  if (!msg || !msg.from || !msg.chat || msg.chat.type !== 'private') return;
  const text = typeof msg.text === 'string' ? msg.text.trim() : '';
  // Owner-only emoji-harvest tools run BEFORE the /start handling and
  // consume the message when they fire. For everyone else — and for the
  // owner's own /start — they are completely silent (see handleOwnerTools).
  if (await handleOwnerTools(msg, text)) return;
  const from = msg.from;
  if (!/^\d+$/.test(String(from.id))) return;
  const chatId = msg.chat.id;
  // Owner-only maintenance (owner order 2026-11-14): while
  // settings/global.ownerOnly is on, a non-owner gets the update
  // notice instead of the welcome / bio flow. Owner unaffected.
  {
    const cfgM = await getConfig();
    const ownerOnlyLiveM = await getVal(rtdb().ref('settings/global/ownerOnly')); // fresh, like the API gate — the emergency brake never waits for the config cache
    if (ownerOnlyLiveM === true && !isTesterUid(String(from.id), cfgM)) {
      try { await tg('sendMessage', { chat_id: chatId, text: '🔧 Update in progress — VIKING MINER is being updated right now. Please check back soon!' }); } catch (e) { /* the notice is best-effort */ }
      return;
    }
  }
  // First contact via the DIRECT APP LINK: those users never send
  // /start, so Telegram's write_access_allowed service message — sent
  // when the user grants the Mini App write access (the app requests
  // it on launch) and carrying NO text — is their welcome trigger, and
  // it is handled here, BEFORE the text//start gate below. The welcome
  // goes out ONLY for a genuinely new player: read the player first,
  // create after the check (ensurePlayer does not report creation).
  // An existing player re-granting access hears nothing at all.
  // (Owner order 2026-11-14.)
  if (msg.write_access_allowed) {
    const cfgW = await getConfig();
    const existed = (await getVal(P(from.id))) !== null;
    await ensurePlayer({ user: from, body: {} }); // same creation path as the API actions
    if (!existed) {
      const TW = BIO_TEXTS[bioLangOf(from)];
      await sendWelcome(chatId, cfgW, TW, esc(String(from.first_name || '').trim() || TW.warrior));
    }
    return;
  }
  if (!text.startsWith('/start')) return;
  const parts = text.split(/\s+/);
  if (!/^\/start(@[A-Za-z0-9_]+)?$/.test(parts[0])) return;
  const param = parts[1] || '';
  const cfg = await getConfig();
  await ensurePlayer({ user: from, body: {} }); // same creation path as the API actions
  // A /start that carries a referral param (ref_<id>) attributes the
  // fresh record right here — the same fresh-account rule as state()'s
  // late attribution — so a bot-first contact never burns the referral.
  const refM = /^ref_(\d+)$/.exec(param);
  if (refM && refM[1] !== String(from.id)) {
    try {
      const meS = await getVal(P(from.id));
      if (meS && !meS.invitedBy && Date.now() - (Number(meS.createdAt) || 0) < 86400000 && !(Number(meS.mined) > 0)) {
        const invS = await getVal(P(refM[1]));
        if (invS && (invS.referrals || []).length < 3000) {
          const setS = await txUpdate(P(from.id), (cur) => {
            if (cur === null || cur.invitedBy) return { skip: true, out: false };
            return { value: { ...cur, invitedBy: refM[1] }, out: true };
          });
          if (setS) await attributeReferral(from, refM[1], '');
        }
      }
    } catch (e) { console.error('startRef', e.message); }
  }
  const T = BIO_TEXTS[bioLangOf(from)];
  if (param !== 'bio') {
    // The EN caption no longer interpolates the name (AdVOLT-style copy,
    // owner order 2026-11-14); displayName is still composed — escaped —
    // because the ar/ru texts kept in the file for a possible revert do
    // use it. tg() runs pz() over the caption, which only wraps emoji.
    await sendWelcome(chatId, cfg, T, esc(String(from.first_name || '').trim() || T.warrior));
    return;
  }
  // '/start bio' only from here on: the one bot path that checks the
  // bio and credits the reward.
  const chk = await checkBio(from.id, cfg);
  let outcome = chk.status, reward = 0;
  if (chk.status === 'match') {
    try {
      const r = await creditBioReward(from.id, cfg);
      outcome = 'granted'; reward = r.reward;
    } catch (e) {
      outcome = (e instanceof Fail && e.message === 'Already claimed') ? 'already' : 'unavailable';
    }
  }
  if (outcome === 'granted') await tg('sendMessage', { chat_id: chatId, text: T.granted(reward, cfg.coinSym) });
  else if (outcome === 'already') await tg('sendMessage', { chat_id: chatId, text: T.already });
  else if (outcome === 'unavailable') await tg('sendMessage', { chat_id: chatId, text: T.retry });
  else await tg('sendMessage', { chat_id: chatId, text: T.instruct(chk.uname) }); // 'empty' or 'mismatch'
}

/* Referral achievements: milestones for ACTIVE (verified) referrals only.
   The count is recomputed inside the player transaction on the freshest
   referrals array — 'Pending ⏳'/'⚠️ Duplicate' entries never count — and
   each milestone can be claimed exactly once (refAchClaimed[n] = timestamp
   is the dedupe memory). */
const REF_ACH_MILESTONES = [1, 10, 25, 50, 100];
async function refAch(c) {
  const n = Number(c.body.n);
  if (!REF_ACH_MILESTONES.includes(n)) fail(400, 'Bad milestone');
  const ref = await ensurePlayer(c);
  return txUpdate(ref, (d) => {
    if (d === null) return { error: new Fail(404, 'User not found') };
    if (d.banned === true) return { error: new Fail(403, 'Account banned') };
    if (countActiveRefs(d.referrals) < n) return { error: new Fail(400, 'Not enough active referrals') };
    const claimed = (d.refAchClaimed && typeof d.refAchClaimed === 'object') ? d.refAchClaimed : {};
    if (claimed[n]) return { error: new Fail(400, 'Already claimed') };
    const reward = Number(c.cfg['refAchReward' + n]) || 0;
    return {
      value: { ...d, mined: (Number(d.mined) || 0) + reward, earnRef: (Number(d.earnRef) || 0) + reward, refAchClaimed: { ...claimed, [n]: Date.now() } },
      out: { success: true, reward, milestone: n }
    };
  });
}

async function wallet(c) {
  const ref = await ensurePlayer(c); // TonConnect can fire this before state at cold start — never 404 a first-run user
  const p = await getVal(ref);
  if (!p) fail(404, 'User not found'); // unreachable after ensurePlayer; kept as a guard
  if (p.banned === true) fail(403, 'Account banned');
  const raw = c.body.address ? await rawAddress(String(c.body.address).slice(0, 100)) : p.walletAddr;
  if (!raw) fail(400, 'Connect a wallet first');
  /* Idempotent re-sync (round 3, incident 2026-11-14): the 8 s sync
     cooldown guards against bind churn, but a call whose address
     normalises to the wallet ALREADY bound changes nothing — it is
     the same sync retried (the app's own hold-sync button, or a
     re-link attempt for the same wallet after a dropped session).
     Failing it with 429 made a legitimately bound wallet look
     rejected and looped the client. Same-wallet calls therefore run
     the full normal flow below (ownership claim included) minus the
     cooldown failure; binding a DIFFERENT wallet inside the window
     still gets the 429 exactly as before. */
  if (raw !== (p.walletAddr || '') && Date.now() - (p.lastSyncAt || 0) < 8000) fail(429, 'Please wait a few seconds');
  /* The chain read must never decide whether a bind succeeds (live
     incident 2026-11-15): under the signup flood, tonapi rate-limits
     this server's single IP and jettonHold throws — and because the
     read sat BEFORE the claim + bind writes, the whole bind was
     rejected and players looped on "Not connected" although
     TonConnect had connected fine. The bind now always persists; the
     hold is best-effort: a fresh read wins; a failed read keeps the
     stored hold for the SAME wallet and falls back to 0 for a
     DIFFERENT wallet (a new wallet is never credited with the old
     one's balance). The next sync corrects the number. */
  let hold = 0, holdFresh = false;
  try { hold = await jettonHold(raw); holdFresh = true; } catch (e) { /* chain read failed — bind anyway */ }
  if (!holdFresh) hold = (raw === (p.walletAddr || '')) ? (Number(p.hold) || 0) : 0;
  const uid = String(c.user.id);
  // claim the wallet node first (the Firestore original checked ownership
  // inside its transaction before writing anything — same net effect here).
  // The claim is PERMANENT (owner order 2026-11-15): neither unlink nor
  // binding a different wallet ever deletes a registry node, so a wallet
  // belongs to the first account that linked it, forever.
  await txUpdate(walletDoc(raw), (w) => {
    if (w === null) return { value: { userId: uid } };
    if (String(w.userId) !== uid) return { error: new Fail(400, 'This wallet is linked to another account') };
    return { skip: true };
  });
  const out = await txUpdate(ref, (d) => {
    if (d === null) return { error: new Fail(404, 'User not found') };
    // Wallet verification is bound to ONE wallet (owner order
    // 2026-11-14): binding a DIFFERENT address than the verified one
    // voids the verification — the new wallet must be verified again.
    // Re-syncing the same verified wallet keeps it.
    const voidsVerify = d.walletVerified === true && (d.verifiedWallet || '') !== raw;
    // A pending verification intent belongs to ONE wallet: binding a
    // different address clears it (verifyInfo re-marks it for the new
    // wallet); re-syncing the same wallet keeps it.
    const addrChanged = (d.walletAddr || '') !== raw;
    return {
      value: { ...d, walletAddr: raw, hold, lastSyncAt: holdFresh ? Date.now() : (d.lastSyncAt || 0), ...(voidsVerify ? { walletVerified: false, verifiedWallet: '', verifiedAt: 0, verifyTx: '' } : {}), ...(addrChanged ? { verifyPendingAt: 0 } : {}) },
      out: { oldAddr: d.walletAddr || '', voided: voidsVerify }
    };
  });
  if (out.voided) await syncRefVerifiedFlag(uid, false);
  // Wallet ownership is PERMANENT (owner order 2026-11-15): the
  // registry node of the previously bound wallet is deliberately NOT
  // removed here — a wallet that was ever linked to this account can
  // never be linked to a different account, only re-linked to this
  // one. (The claim above already rejects any wallet whose registry
  // node names another userId.)
  // Referral activation is a live state (verified + hold >= minimum):
  // re-evaluate it against the hold/verification this sync just wrote —
  // reaching the minimum activates, dropping below it deactivates.
  await syncReferralActive(uid, c.cfg);
  return { success: true, hold };
}

async function unlink(c) {
  const ref = await ensurePlayer(c);
  const out = await txUpdate(ref, (d) => {
    if (d === null) return { error: new Fail(404, 'User not found') };
    // Disconnecting voids the wallet verification with the binding
    // (owner order 2026-11-14): a wallet bound later — even the same
    // one — must be verified again.
    const wasVerified = d.walletVerified === true;
    return {
      value: { ...d, walletAddr: '', hold: 0, verifyPendingAt: 0, ...(wasVerified ? { walletVerified: false, verifiedWallet: '', verifiedAt: 0, verifyTx: '' } : {}) },
      out: { oldAddr: d.walletAddr || '', voided: wasVerified }
    };
  });
  if (out.voided) await syncRefVerifiedFlag(String(c.user.id), false);
  // Unlinking zeroes the hold and voids verification: the referral
  // deactivates (live activation state — see syncReferralActive).
  await syncReferralActive(String(c.user.id), c.cfg);
  // The wallets-registry node is deliberately KEPT (owner order
  // 2026-11-15): unlinking disconnects the wallet from this account
  // but does NOT free it — it stays registered to this account
  // forever and can only be re-linked here, never to another
  // account (the claim in wallet() rejects any other userId).
  return { success: true };
}

/* ---------- wallet verification actions (owner order 2026-11-14) ----------
   verifyInfo: everything the Profile verification card needs — the
   player's permanent userNo, the exact payment instructions (deposit
   wallet, fee, comment VIKING-<userNo>) and the on-chain age of the
   currently bound wallet.
   verifyCheck: re-validates EVERYTHING server-side and then confirms
   the fee payment on-chain: it scans the deposit wallet's newest
   incoming transactions for one sent FROM the player's bound wallet,
   worth at least the fee (1% tolerance), carrying the EXACT comment,
   whose hash has not been claimed before (verifyClaims/{txHash}).
   On a match it claims the hash, marks the player verified, flags the
   wallets-registry node, and syncs the inviter's referral entry. */
const verifyComment = (userNo) => 'VIKING-' + userNo;
async function verifyGatePlayer(c) {
  const ref = await ensurePlayer(c);
  const p = await getVal(ref);
  if (!p) fail(404, 'User not found'); // unreachable after ensurePlayer; kept as a guard
  if (p.banned === true) fail(403, 'Account banned');
  return { ref, p };
}
async function verifyInfo(c) {
  const { ref, p } = await verifyGatePlayer(c);
  const userNo = await ensureUserNo(c.user.id); // lazy assignment for pre-feature players
  if (!userNo) fail(500, 'Server error');
  const wallet = p.walletAddr || '';
  const minAge = Number(c.cfg.verifyMinAgeDays) || 7;
  let ageDays = null;
  if (wallet) ageDays = await walletAgeDays(ref, p, wallet);
  const verified = p.walletVerified === true;
  // Verification intent (owner order 2026-11-14): while a wallet is
  // bound and NOT yet verified, the player is PENDING — the marker is
  // what the background deposit watcher scans for, so a payment sent
  // with the app closed still completes the verification. Set here
  // (the card always loads verifyInfo before offering payment),
  // cleared by completeVerification's flip, by unlink, and by binding
  // a different wallet (see wallet()/unlink()).
  let pending = Number(p.verifyPendingAt) || 0;
  if (wallet && !verified && !pending) {
    pending = Date.now();
    try { await ref.update({ verifyPendingAt: pending }); } catch (e) { /* the marker is advisory; verifyInfo must not fail over it */ }
  } else if ((verified || !wallet) && pending) {
    pending = 0;
    try { await ref.update({ verifyPendingAt: 0 }); } catch (e) { /* advisory, as above */ }
  }
  return {
    userNo,
    depositWallet: String(c.cfg.verifyDepositWallet || ''),
    feeTon: Number(c.cfg.verifyFeeTon) || 0,
    comment: verifyComment(userNo),
    wallet,
    ageDays,
    minAgeDays: minAge,
    ageOk: ageDays !== null && ageDays >= minAge,
    verified,
    verifiedWallet: p.verifiedWallet || '',
    verifyPending: !!wallet && !verified && pending > 0
  };
}

/* The success messages (owner order 2026-11-14): fired ONCE PER
   PAYMENT, by whichever path wins the verification flip — the
   Verify button's check or the background watcher — never by a
   loser, and never twice for the same payment: completeVerification
   takes the payment's single notification slot (the claim record's
   notifiedAt) before calling this, so a verification that is voided
   (unlink / different-wallet bind) and later re-completed from the
   SAME payment flips the player back to verified silently. The user
   gets the celebratory photo DM (welcome banner + caption,
   premiumized centrally by tg()); the owner gets a deposit alert
   with the tx link. Both are best-effort: a user who never started
   the bot cannot be DM'd, and a message failure must never fail (or
   roll back) a completed verification. */
async function sendVerificationMessages(uid, p, cfg, hash, ageDays) {
  const userNo = Number(p.userNo) || 0;
  try {
    const T = BIO_TEXTS[bioLangOf(null)]; // the bot's language is fixed (see bioLangOf)
    const caption = T.verifiedMsg({
      name: esc(p.name || 'Warrior'),
      walletShort: esc(shortFriendlyAddress(p.walletAddr || '')),
      ageDays: ageDays === null || ageDays === undefined ? '—' : Number(ageDays),
      userNo,
      date: fmtDayMonYear(Date.now())
    });
    const photoRes = await tg('sendPhoto', { chat_id: uid, photo: WELCOME_IMAGE_URL, caption });
    if (!photoRes || !photoRes.ok) await tg('sendMessage', { chat_id: uid, text: caption }); // same fallback as the welcome: never lose the message over the photo
  } catch (e) { console.error('verify user message', uid, e.message); }
  try {
    for (const adminId of adminChatIds()) {
      await tg('sendMessage', {
        chat_id: adminId, parse_mode: 'HTML',
        text: `💰 <b>New wallet verification deposit</b>\n👤 <b>User:</b> ${esc(p.name || '')} (<code>${esc(uid)}</code>) · VIKING-${userNo}\n👛 <b>Wallet:</b> <code>${esc(toFriendlyAddress(p.walletAddr || ''))}</code>\n💵 <b>Amount:</b> ${Number(cfg.verifyFeeTon) || 0} TON\n🛡️ <b>Status:</b> wallet VERIFIED ✅\n🔗 <a href="https://tonviewer.com/transaction/${hash}">View transaction</a>`
      });
    }
  } catch (e) { console.error('verify admin message', uid, e.message); }
}

/* THE shared completion path (owner order 2026-11-14): both the
   verifyCheck action and the background deposit watcher finish a
   verification HERE, so the two can never diverge. The caller has
   already established eligibility (bound wallet, age rule) and found
   a candidate payment; this function claims the payment's hash,
   flips the player to verified in ONE transaction — only if still
   unverified for the same bound wallet — flags the wallets-registry
   node, syncs the inviter's referral entry, and, ONLY when this
   caller won the flip AND the payment has never been announced
   (the claim's notifiedAt slot), sends the success messages.
   Returns { won:true, tx } to the winner; { won:false, reason } to
   everyone else ('already' | 'claimed' | 'banned' | 'nowallet' |
   'missing'). Throws Fail(409) if the bound wallet changed between
   the caller's scan and the flip (verifyCheck's long-standing
   contract; the watcher catches it per player). */
async function completeVerification(uid, hash, cfg) {
  uid = String(uid);
  const ref = P(uid);
  const p = await getVal(ref);
  if (!p) return { won: false, reason: 'missing' };
  if (p.banned === true) return { won: false, reason: 'banned' };
  const wallet = p.walletAddr || '';
  if (!wallet) return { won: false, reason: 'nowallet' };
  if (p.walletVerified === true && p.verifiedWallet === wallet) return { won: false, reason: 'already' };
  const claimRef = rtdb().ref('verifyClaims/' + hash);
  const prior = await getVal(claimRef);
  if (prior && String(prior.userId) !== uid) return { won: false, reason: 'claimed' }; // claimed by someone else — never reusable
  if (!prior) {
    // Claim the hash FIRST (atomic): two racing completions for the
    // same payment can never both pass this point.
    let claimed;
    try {
      claimed = await txUpdate(claimRef, (cur) => {
        if (cur !== null) return { skip: true, out: false };
        return { value: { userId: uid, at: Date.now() }, out: true };
      });
    } catch (e) {
      // Distinguishable in the logs (round 3): txUpdate already
      // retried any maxretry abort internally, so a claim that still
      // throws is the one failure that strands a REAL payment —
      // it must never read like a generic completion error.
      console.error('verify claim FAILED for uid', uid, 'hash', hash, '-', e.message);
      throw e;
    }
    if (!claimed) return { won: false, reason: 'claimed' };
  }
  const flip = await txUpdate(ref, (d) => {
    if (d === null) return { error: new Fail(404, 'User not found') };
    if (d.walletVerified === true) return { skip: true, out: { won: false, reason: 'already' } }; // a racer (the other path) won
    if ((d.walletAddr || '') !== wallet) return { error: new Fail(409, 'Wallet changed, try again') };
    return {
      value: { ...d, walletVerified: true, verifiedWallet: wallet, verifiedAt: Date.now(), verifyTx: hash, verifyPendingAt: 0 },
      out: { won: true, player: { ...d, walletAddr: wallet, userNo: Number(d.userNo) || 0, name: d.name || '' } }
    };
  });
  if (!flip || !flip.won) return { won: false, reason: (flip && flip.reason) || 'already' };
  // Flag the wallets-registry node for this address as verified
  // (preserving its ownership record — the node normally exists
  // from the wallet binding; recreate it WITH the owner if not).
  const wRef = walletDoc(wallet);
  const wDoc = await getVal(wRef);
  if (wDoc) await wRef.update({ verified: true });
  else await wRef.set({ userId: uid, verified: true });
  await syncRefVerifiedFlag(uid, true);
  // Verification is one of the two activation conditions: if the hold
  // already meets the minimum, the referral turns Active right here.
  await syncReferralActive(uid, cfg);
  let ageDays = null;
  try { ageDays = await walletAgeDays(ref, flip.player, wallet); } catch (e) { /* the caption falls back to '—' */ }
  /* Once per payment (owner order 2026-11-14): the flip above can
     be won MORE than once for the same payment — void the
     verification (unlink / different-wallet bind), rebind, and the
     same-user claim fall-through up top completes it again. The
     flip must still land (the player really is verified again),
     but the messages may only ever be sent once for this payment,
     so first take the notification slot on the claim record
     atomically: mark-then-send. A claim stranded by a completion
     that never won its flip has no notifiedAt yet, so its eventual
     win still takes the slot and sends — that win IS the payment's
     first (and only) announcement. If the Telegram send itself
     fails after the mark, the messages are best-effort by design
     and are NOT retried: the owner's "once only" outranks delivery
     retries. If the mark itself fails, skip the send rather than
     risk a duplicate later; a future re-completion can still take
     the slot and announce. */
  let notify = false;
  try {
    notify = await txUpdate(claimRef, (cur) => {
      if (!cur || typeof cur !== 'object') return { skip: true, out: false }; // no claim record — defensive: never announce an unclaimed payment
      if (cur.notifiedAt) return { skip: true, out: false }; // this payment already announced itself
      return { value: { ...cur, notifiedAt: Date.now() }, out: true };
    });
  } catch (e) { console.error('verify notify-mark FAILED for uid', uid, 'hash', hash, '-', e.message); }
  if (notify) await sendVerificationMessages(uid, flip.player, cfg, hash, ageDays);
  return { won: true, tx: hash };
}

async function verifyCheck(c) {
  const { ref, p } = await verifyGatePlayer(c);
  const uid = String(c.user.id);
  const wallet = p.walletAddr || '';
  if (!wallet) fail(400, 'Connect a wallet first');
  // Already verified for THIS wallet: nothing to re-prove.
  if (p.walletVerified === true && p.verifiedWallet === wallet) return { verified: true, tx: p.verifyTx || '', already: true };
  const userNo = await ensureUserNo(uid);
  if (!userNo) fail(500, 'Server error');
  const minAge = Number(c.cfg.verifyMinAgeDays) || 7;
  const age = await walletAgeDays(ref, p, wallet); // cache-aware; recomputes when stale or the wallet changed
  if (age < minAge) fail(400, 'Wallet too new: ' + age + ' days, needs ' + minAge);
  const feeTon = Number(c.cfg.verifyFeeTon) || 0;
  const minNano = BigInt(Math.floor(feeTon * 1e9 * 0.99)); // 1% tolerance for wallet-side rounding
  const comment = verifyComment(userNo);
  const depRaw = toRawAddress(c.cfg.verifyDepositWallet);
  const txs = await toncTransactions(depRaw, 50, 'desc');
  for (const tx of txs) {
    const inMsg = tx && tx.in_msg;
    if (!inMsg) continue;
    if (inMsgSourceRaw(inMsg) !== wallet) continue; // must be sent FROM the player's bound wallet
    let val;
    try { val = BigInt(String(inMsg.value || '0')); } catch (e) { continue; }
    if (val < minNano) continue;
    const text = decodeTextComment(inMsg);
    if (!text || text.trim() !== comment) continue;
    const hash = txHashHex(tx.hash); // toncenter v3 sends base64 — canonical hex before the guard/claim/store
    if (!/^[0-9a-fA-F]{64}$/.test(hash)) continue;
    const done = await completeVerification(uid, hash, c.cfg);
    if (done.won) return { verified: true, tx: hash };
    if (done.reason === 'already') return { verified: true, tx: p.verifyTx || hash, already: true }; // the watcher won the race mid-scan
    // 'claimed' (this payment belongs to another user) and friends:
    // keep scanning — another transaction may still be this player's.
  }
  fail(404, 'Payment not found yet');
}

/* ---------- background deposit watcher (owner order 2026-11-14) ----------
   Verification must complete even while the app is CLOSED: a player
   who opened the verification card (verifyInfo marked them pending),
   paid, and closed the app is finished here. Every tick: read the
   players node once and filter pending intents in memory (fine at
   the current scale — revisit with an indexed query if the player
   count grows by orders of magnitude); with nobody pending the tick
   costs that one read and ZERO chain calls. Otherwise ONE scan of
   the deposit wallet's 50 newest transactions serves every pending
   player, matched by their exact VIKING-<userNo> comment, sender ==
   their CURRENT bound wallet, value >= fee (1% tolerance), hash
   unclaimed — plus the same wallet-age rule verifyCheck applies
   (checked per player from the cache-aware age, so a too-young
   wallet simply stays pending and is retried as it ages). Completion
   goes through the shared completeVerification, so messages fire
   exactly once, from whichever path wins. Ticks never overlap and a
   failing tick is logged and swallowed — the watcher can never wedge
   the process. VERIFY_WATCH_MS: 0 disables (tests), default 10 s —
   at 10 s a tick with nobody pending is one RTDB read, and a tick
   with pending players is one chain scan, so the API load stays
   flat regardless of the interval. */
const VERIFY_WATCH_MS = (() => { const v = Number(process.env.VERIFY_WATCH_MS); return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 20000; })(); // default 20 s (was 10 s — owner load-reduction order 2026-11-15; the tick is indexed now, and verification completing a few seconds later is invisible next to the ~90 s the app itself polls)
const VERIFY_WATCH_AGE_BATCH = (() => { const v = Number(process.env.VERIFY_WATCH_AGE_BATCH); return Number.isFinite(v) && v > 0 ? Math.floor(v) : 60; })(); // fresh wallet-age determinations per tick (see verifyWatchTick)
let verifyWatchRunning = false;
async function verifyWatchTick() {
  if (verifyWatchRunning) return; // ticks never overlap
  verifyWatchRunning = true;
  try {
    const queried = await queryPlayersByChild('verifyPendingAt', 'startAt', 1);
    const players = queried || await getVal(rtdb().ref('players'));
    if (!players) return;
    const pending = Object.entries(players).filter(([, p]) => p && Number(p.verifyPendingAt) > 0);
    if (!pending.length) return; // nobody waiting: zero chain calls this tick
    /* Observability (round 3, incident 2026-11-14): a tick with at
       least one pending player logs ONE summary line when it ends —
       how many were pending, how many chain transactions were
       scanned, and the outcome for every player it skipped or tried
       to complete (won / reason / error). A stalled verification is
       therefore visible in the server logs instead of silent: in
       the incident, a paid player's completion kept dying inside
       transactions and the watcher said nothing at all. The
       nobody-pending case above stays completely silent. */
    let scanned = 0;
    const notes = [];
    try {
      const cfg = await getConfig();
      const minAge = Number(cfg.verifyMinAgeDays) || 7;
      const feeTon = Number(cfg.verifyFeeTon) || 0;
      const minNano = BigInt(Math.floor(feeTon * 1e9 * 0.99));
      const byComment = new Map(); // exact payment comment -> { uid, wallet }
      let ageReads = 0; // fresh (uncached) wallet-age determinations spent this tick
      for (const [uid, p] of pending) {
        if (p.banned === true) { notes.push(uid + ': banned'); continue; } // stays pending; an unban restores the flow
        if (p.walletVerified === true || !(p.walletAddr || '')) {
          // Stale intent (verified by another path, or wallet gone):
          // just clear the marker so the player leaves the scan set.
          try { await P(uid).update({ verifyPendingAt: 0 }); } catch (e) { /* next tick retries */ }
          notes.push(uid + ': stale-cleared');
          continue;
        }
        const userNo = await ensureUserNo(uid);
        if (!userNo) { notes.push(uid + ': no-userNo'); continue; }
        // Age determinations are this tick's only per-player chain
        // cost, and a known age is cached for 3 h — but after a
        // signup flood hundreds of pendings can be uncached at once
        // (762 on 2026-11-15), and determining all of them every
        // 20 s would keep the chain layer saturated on retries.
        // Cached ages are free and always evaluated; FRESH reads
        // are budgeted per tick and the rest defer to the next one.
        // A player paying right now still confirms instantly via
        // the in-app verifyCheck, so the budget costs nobody a
        // confirmation — it only paces the background catch-up.
        const ageCached = p.walletAgeV === WALLET_AGE_CACHE_V && p.walletAgeFor === p.walletAddr && p.walletAgeAt && (Date.now() - p.walletAgeAt) < WALLET_AGE_CACHE_MS && Number(p.walletAgeDays) >= 0;
        if (!ageCached && ageReads >= VERIFY_WATCH_AGE_BATCH) { notes.push(uid + ': age-deferred'); continue; }
        let age = null;
        try { age = await walletAgeDays(P(uid), p, p.walletAddr); } catch (e) { /* treated as not-yet-eligible below */ }
        if (!ageCached) ageReads++;
        if (age === null || age < minAge) { notes.push(uid + ': age ' + (age === null ? '?' : age) + '<' + minAge); continue; } // the age rule applies here too — retried as the wallet ages
        byComment.set(verifyComment(userNo), { uid, wallet: p.walletAddr });
      }
      if (!byComment.size) return;
      const depRaw = toRawAddress(cfg.verifyDepositWallet);
      const txs = await toncTransactions(depRaw, 50, 'desc');
      scanned = txs.length;
      for (const tx of txs) {
        const inMsg = tx && tx.in_msg;
        if (!inMsg) continue;
        const text = decodeTextComment(inMsg);
        if (!text) continue;
        const cand = byComment.get(text.trim());
        if (!cand) continue;
        if (inMsgSourceRaw(inMsg) !== cand.wallet) continue; // must be sent FROM that player's bound wallet
        let val;
        try { val = BigInt(String(inMsg.value || '0')); } catch (e) { continue; }
        if (val < minNano) continue;
        const hash = txHashHex(tx.hash);
        if (!/^[0-9a-fA-F]{64}$/.test(hash)) continue;
        try {
          const done = await completeVerification(cand.uid, hash, cfg);
          if (done.won) notes.push(cand.uid + ': WON ' + hash.slice(0, 10) + '…');
          else notes.push(cand.uid + ': ' + done.reason);
          if (done.won || done.reason === 'already') byComment.delete(text.trim());
        } catch (e) { notes.push(cand.uid + ': ERROR ' + e.message); } // per-player failure never stops the tick (and is in the summary line)
      }
    } finally {
      console.log('[verifyWatch] pending=' + pending.length + ' scanned=' + scanned + (notes.length ? ' | ' + notes.join('; ') : ''));
    }
  } catch (e) {
    console.error('verifyWatch tick', e.message);
  } finally {
    verifyWatchRunning = false;
  }
}
let verifyWatchStarted = false;
function startVerifyWatcher() {
  if (verifyWatchStarted) return;
  verifyWatchStarted = true;
  if (!(VERIFY_WATCH_MS > 0)) return; // 0 = disabled
  const bootTick = setTimeout(() => { verifyWatchTick(); }, 15000); // one early tick ~15 s after boot
  if (bootTick.unref) bootTick.unref();
  const iv = setInterval(() => { verifyWatchTick(); }, VERIFY_WATCH_MS);
  if (iv.unref) iv.unref();
}

/* ---------- referral hold watcher (owner order 2026-11-15) ----------
   Activation is a live state (wallet-verified AND hold >= refMinHold),
   but its inputs used to move only when the invitee opened the app and
   synced his wallet: sell the coins on an exchange without ever
   opening the bot and the inviter kept seeing "Verified ✅" forever.
   This watcher re-reads the on-chain hold of every VERIFIED invitee
   with a bound wallet on a slow tick and re-runs syncReferralActive,
   so buys and sells reflect on their own — the app never has to open
   (and a background activation fires the inviter's DM from
   syncReferralActive, exactly like an in-app one). A failed chain
   read skips the player: a network hiccup must never deactivate
   anyone — only a successful read may move a hold. */
const REF_HOLD_WATCH_MS = (() => { const v = Number(process.env.REF_HOLD_WATCH_MS); return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 180000; })(); // default 3 min (was 1 min — the sweep was the single biggest tonapi consumer under the signup flood; env still overrides)
const REF_HOLD_WATCH_BATCH = (() => { const v = Number(process.env.REF_HOLD_WATCH_BATCH); return Number.isFinite(v) && v > 0 ? Math.floor(v) : 90; })(); // candidates re-read per tick, stalest first (see refHoldWatchTick)
const MULTI_CHECK_MS = (() => { const v = Number(process.env.MULTI_CHECK_MS); return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 600000; })(); // per-player multi-link recompute cadence in state() (owner load-reduction order 2026-11-15); default 10 min, env overrides, 0 = recompute on every state call
let refHoldWatchRunning = false;
async function refHoldWatchTick() {
  if (refHoldWatchRunning) return; // ticks never overlap
  refHoldWatchRunning = true;
  try {
    const queried = await queryPlayersByChild('walletVerified', 'equalTo', true);
    const players = queried || await getVal(rtdb().ref('players'));
    if (!players) return;
    const cands = Object.entries(players).filter(([, p]) => p && p.invitedBy && p.walletVerified === true && (p.walletAddr || '') && p.banned !== true);
    if (!cands.length) return;
    // Batch cap (incident 2026-11-15): the candidate set grows with
    // the verified population (447 during the flood) and re-reading
    // ALL of them every tick keeps the chain layer busy around the
    // clock, starving player-facing reads. Stalest-first ordering
    // rotates coverage — every candidate is re-read within a few
    // ticks — and an in-app sync still refreshes a hold the moment
    // it matters to the player himself.
    cands.sort((a, b) => (Number(a[1].lastSyncAt) || 0) - (Number(b[1].lastSyncAt) || 0));
    const batch = cands.slice(0, REF_HOLD_WATCH_BATCH);
    const cfg = await getConfig();
    const notes = [];
    for (const [uid, p] of batch) {
      try {
        const hold = await jettonHold(p.walletAddr);
        if (!Number.isFinite(hold)) continue;
        if (Math.abs(hold - (Number(p.hold) || 0)) < 1e-9) continue; // unchanged: no write, no re-eval
        await P(uid).update({ hold, lastSyncAt: Date.now() });
        await syncReferralActive(uid, cfg);
        notes.push(uid + ': hold ' + (Number(p.hold) || 0) + '->' + hold);
      } catch (e) { /* failed read: skip this player this tick */ }
    }
    if (notes.length) console.log('[refHoldWatch] ' + notes.join('; '));
  } catch (e) {
    console.error('refHoldWatch tick', e.message);
  } finally {
    refHoldWatchRunning = false;
  }
}
let refHoldWatchStarted = false;
function startRefHoldWatcher() {
  if (refHoldWatchStarted) return;
  refHoldWatchStarted = true;
  if (!(REF_HOLD_WATCH_MS > 0)) return; // 0 = disabled
  const bootTick = setTimeout(() => { refHoldWatchTick(); }, 30000); // first sweep ~30 s after boot
  if (bootTick.unref) bootTick.unref();
  const iv = setInterval(() => { refHoldWatchTick(); }, REF_HOLD_WATCH_MS);
  if (iv.unref) iv.unref();
}

/* ---------- referral repair sweep (owner case 2026-11-15, Hisham) ----
   Attribution writes the invitee's invitedBy on the invitee's own
   (cold) record and appends the entry to the INVITER's (hot) record
   in a second step. Under the signup flood that append could lose
   its transaction-retry war on the hot record and fail — silently
   and permanently: the invitee kept his inviter, the inviter never
   saw him (25 of one player's 26 referrals vanished this way;
   50 entries across 15 inviters in one evening). No code path ever
   retried the append. This sweep is the retry, forever: every
   REF_REPAIR_MS it reconciles the two sides — any player whose
   invitedBy points at an inviter whose list lacks his entry gets
   the entry restored (silently, with his real join time), and his
   activation state is re-synced. Idempotent: the append dedupes by
   id inside its transaction, so a healthy list is never touched. */
const REF_REPAIR_MS = (() => { const v = Number(process.env.REF_REPAIR_MS); return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 600000; })(); // default 10 min; env overrides, 0 disables
let refRepairRunning = false;
async function refRepairTick() {
  if (refRepairRunning) return; // ticks never overlap
  refRepairRunning = true;
  try {
    const cfg = await getConfig();
    /* Queue first (owner load order 2026-11-15): appends that lost
       their contention war AND exhausted the in-process retry ladder
       leave an entry in refRepairQueue (written at handoff time, so
       even a process restart cannot lose it). Processing the queue
       costs one small read instead of downloading every player. */
    const queue = await getVal(rtdb().ref('refRepairQueue'));
    if (queue) {
      let qFixed = 0;
      for (const [inviteeId, ent] of Object.entries(queue)) {
        if (qFixed >= 200) break; // per-tick cap; the next tick continues
        const p = await getVal(P(inviteeId));
        if (!p || !p.invitedBy || String(p.invitedBy) !== String(ent && ent.inv)) {
          await rtdb().ref('refRepairQueue/' + inviteeId).remove().catch(() => {}); // stale entry (record gone / inviter changed)
          continue;
        }
        const inv = await getVal(P(String(p.invitedBy)));
        if (inv && (inv.referrals || []).some((r) => String(r.id) === String(inviteeId))) {
          await rtdb().ref('refRepairQueue/' + inviteeId).remove().catch(() => {}); // already landed via another path
          continue;
        }
        const ok = await attributeReferral({ id: inviteeId, first_name: p.name || 'Warrior' }, String(p.invitedBy), p.deviceHash || '', { silent: true, at: Number(p.createdAt) || Date.now() });
        if (ok) {
          qFixed++;
          await syncReferralActive(inviteeId, cfg);
          await rtdb().ref('refRepairQueue/' + inviteeId).remove().catch(() => {});
        }
      }
      if (qFixed) console.log('[refRepair] restored ' + qFixed + ' queued referral entries');
    }
    /* Full reconciliation at most once a day: it downloads the whole
       players node, which grows with every signup — as the standing
       sweep it was the priciest background read in the system. It
       remains as the final safety net for any loss class the queue
       cannot know about. The stamp is written BEFORE the pass so a
       crash mid-pass cannot hot-loop it. */
    const meta = await getVal(rtdb().ref('meta/refRepair'));
    if (Date.now() - (Number(meta && meta.fullAt) || 0) < 86400000) return;
    await rtdb().ref('meta/refRepair').update({ fullAt: Date.now() }).catch(() => {});
    const players = await getVal(rtdb().ref('players'));
    if (!players) return;
    let repaired = 0;
    for (const [uid, p] of Object.entries(players)) {
      if (repaired >= 200) break; // per-pass cap; the next pass continues
      if (!p || !p.invitedBy) continue;
      const inv = players[String(p.invitedBy)];
      if (!inv) continue;
      if ((inv.referrals || []).some((r) => String(r.id) === String(uid))) continue;
      const ok = await attributeReferral({ id: uid, first_name: p.name || 'Warrior' }, String(p.invitedBy), p.deviceHash || '', { silent: true, at: Number(p.createdAt) || Date.now() });
      if (ok) { repaired++; await syncReferralActive(uid, cfg); }
    }
    if (repaired) console.log('[refRepair] restored ' + repaired + ' missing referral entries');
  } catch (e) {
    console.error('refRepair tick', e.message);
  } finally {
    refRepairRunning = false;
  }
}
let refRepairStarted = false;
function startRefRepairWatcher() {
  if (refRepairStarted) return;
  refRepairStarted = true;
  if (!(REF_REPAIR_MS > 0)) return; // 0 = disabled
  const bootTick = setTimeout(() => { refRepairTick(); }, 45000); // first sweep ~45 s after boot
  if (bootTick.unref) bootTick.unref();
  const iv = setInterval(() => { refRepairTick(); }, REF_REPAIR_MS);
  if (iv.unref) iv.unref();
}

async function refCollect(c) {
  const ref = await ensurePlayer(c);
  return txUpdate(ref, (d) => {
    if (d === null) return { error: new Fail(404, 'User not found') };
    if (d.banned === true) return { error: new Fail(403, 'Account banned') };
    const amt = Number(d.pendingRefComm) || 0;
    if (amt <= 0) return { error: new Fail(400, 'No pending referral profits') };
    return {
      value: { ...d, pendingRefComm: 0, mined: (Number(d.mined) || 0) + amt, refCommissionEarned: (Number(d.refCommissionEarned) || 0) + amt, earnRef: (Number(d.earnRef) || 0) + amt },
      out: { success: true, amount: amt }
    };
  });
}

/* True when uid is on the withdrawal-cooldown exemption list
   (cfg.withdrawCooldownExempt, seeded by DEFAULTS). RTDB may hand
   a stored list back as an array or as an object of values — both
   are normalised to strings before comparing. */
function isCooldownExempt(cfg, uid) {
  const raw = cfg ? cfg.withdrawCooldownExempt : null;
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.values(raw) : []);
  return list.map((v) => String(v)).includes(String(uid));
}

async function withdraw(c) {
  const cfg = c.cfg, ref = await ensurePlayer(c);
  const amt = Math.floor(Number(c.body.amount));
  const pre = await getVal(ref);
  if (!pre) fail(404, 'User not found');
  const addr = pre.walletAddr;
  if (!addr) fail(400, 'Connect TON wallet first');
  // Owner order 2026-11-14: no withdrawal without a VERIFIED wallet.
  // Connecting is not enough — the 0.05 TON verification must be done
  // (binding a different wallet voids it — see wallet()), so a true
  // flag here always refers to the currently bound wallet.
  if (pre.walletVerified !== true) fail(403, 'Verify your wallet first');
  if (!Number.isFinite(amt) || amt < Number(cfg.minWithdraw)) fail(400, 'Minimum is ' + cfg.minWithdraw);
  const hold = await jettonHold(addr); // re-checked on-chain at withdrawal time
  const needHold = Math.ceil(amt * Number(cfg.holdPercentReq) / 100);
  if (hold < needHold) fail(400, 'Need ' + needHold + ' in wallet hold');
  const fee = Math.ceil(amt * Number(cfg.withdrawFeePercent) / 100), net = amt - fee;
  // Firestore original: balance deduction + counter increment + withdrawal
  // doc were ONE transaction. RTDB: player transaction (all guards live
  // here), then the counter transaction (serialises wd numbers), then the
  // doc write — see PORT_NOTES.md for the atomicity caveat.
  const cdExempt = isCooldownExempt(cfg, c.user.id);
  const me = await txUpdate(ref, (d) => {
    if (d === null) return { error: new Fail(500, 'Server error') }; // player was pre-checked above; matches the original crashing on a vanished doc
    if (d.banned === true) return { error: new Fail(403, 'Account banned') };
    if (d.walletAddr !== addr) return { error: new Fail(409, 'Wallet changed, try again') };
    if (!cdExempt && Date.now() - (d.lastWithdrawTime || 0) < 86400000) return { error: new Fail(429, 'You can request once every 24 hours') };
    if (amt > (Number(d.mined) || 0)) return { error: new Fail(400, 'Insufficient balance') };
    return {
      // Exempt accounts keep lastWithdrawTime at 0: the app's own
      // countdown lock reads the same field, so it never locks either.
      value: { ...d, mined: (Number(d.mined) || 0) - amt, lastWithdrawTime: cdExempt ? 0 : Date.now(), hold },
      out: { name: d.name }
    };
  });
  const num = await bumpCounter('withdrawals');
  const wd = { wdNum: num, userId: String(c.user.id), userName: clean(me.name, 64), walletAddr: addr, amt, net, fee, status: 'Pending ⏳', timestamp: Date.now() };
  await rtdb().ref('withdrawals/wd_' + num).set(wd);
  // NO automatic payout any more (owner order 2026-11-14 ~07:29):
  // withdrawals wait for the owner's manual decision. NO review
  // card is sent from here (owner order 2026-11-14, round 2):
  // cards are presented ONLY when the owner pulls the queue with
  // /withdrawals — approve there fires attemptPayout (see the
  // withdrawal-review section below).
  let rk = null;
  try { rk = await riskOf(c.user.id); } catch (e) { console.error('risk', e.message); }
  if (cfg.adminChatId) {
    await tg('sendMessage', {
      chat_id: cfg.adminChatId, parse_mode: 'HTML',
      text: `🔔 <b>New withdrawal #${wd.wdNum}</b>\n👤 ${esc(wd.userName)} (<code>${esc(wd.userId)}</code>)\n💰 ${wd.amt} ${esc(cfg.coinSym)}\n💎 Net: ${wd.net}\n👛 <code>${esc(wd.walletAddr)}</code>${rk && rk.level !== 'low' ? '\n⚠️ تعدد حسابات: ' + (rk.level === 'high' ? 'عالي' : 'متوسط') : ''}`
    });
  }
  return { success: true, wdNum: wd.wdNum };
}

/* ---------- automatic $VIKING jetton payouts (owner order 2026-11-14) ----------
   When PAYOUT_MNEMONIC is configured, an APPROVED withdrawal is
   paid by attemptPayout(), which pays the NET amount in the
   $VIKING jetton from the payout wallet to the player's bound
   wallet. (Approval moved from withdraw()-time to the owner's bot
   review card — owner order 2026-11-14 ~07:29; see the withdrawal-
   review section.) Safety comes from a tiny state machine on the
   withdrawal record itself (field `payoutState`):

     (absent)/'none'  --claim-->  'paying'  --confirmed-->  'paid'
                                    |
                                    +-- any failure -->  'failed'

   - The claim is ONE transaction on the withdrawal node: only the
     caller that flips absent/'none' -> 'paying' may broadcast, so
     retries, double invocations and process restarts can never
     produce a second transfer for the same record.
   - 'paying' is hands-off forever: if the process dies mid-broadcast
     the transfer may or may not have landed, and only a human may
     resolve it (adminWd refuses to touch 'paying'/'paid' records).
   - 'failed' is never auto-retried either: an explicit future admin
     action is the only way back (out of scope here). A failure
     NEVER re-credits the player automatically — the deduction made
     by withdraw() stands, exactly like a manual payout that is still
     waiting, and the owner is DM'd the reason.
   - On success the record is flipped to status 'Paid ✅' with
     payoutState 'paid', payoutTx and payoutAt. payoutTx holds ONLY
     the chain-resolved transaction hash (findTransferTx): the hash
     the seam computes locally from the external message is NOT the
     on-chain tx id for V5R1 wallets (live proof 2026-11-14 — links
     built from it 404 on tonviewer), so it is logged, never stored.
     When resolution times out, payoutTx stays '' and payoutTxLink
     points at the payout wallet's tonviewer page instead.

   The chain layer sits behind getPayoutClient(): production builds
   the real @ton/ton client (createRealPayoutClient); local suites
   point the PAYOUT_STUB_MODULE env var at a fake (the same
   env-override style as TONAPI_BASE / TG_API_BASE) — the state
   machine above never knows the difference. */
function payoutEnabled() {
  return PAYOUT_MNEMONIC.split(/\s+/).filter(Boolean).length === 24;
}

/* The @ton/* libraries are required lazily, only on the payout path:
   a deployment without the feature must boot (and serve everything
   else) even if the packages were somehow missing. */
let _tonLibs = null;
function tonLibs() {
  if (_tonLibs) return _tonLibs;
  _tonLibs = { ton: require('@ton/ton'), core: require('@ton/core'), tcrypto: require('@ton/crypto') };
  return _tonLibs;
}

/* Derive the payout wallet contract address for a mnemonic + wallet
   version ('v5' -> WalletContractV5R1, 'v4' -> WalletContractV4;
   workchain 0, default wallet id — the derivation Tonkeeper uses).
   With the owner's configured mnemonic and 'v5' this yields
   EQANevKlqkfvfsF4vPfTpUxQs7ed92ZTkYi7JD7p0kgflaUA. */
async function derivePayoutAddress(words, version) {
  const { ton, tcrypto } = tonLibs();
  const kp = await tcrypto.mnemonicToPrivateKey(words);
  const Contract = version === 'v4' ? ton.WalletContractV4 : ton.WalletContractV5R1;
  return Contract.create({ workchain: 0, publicKey: kp.publicKey }).address;
}

async function createRealPayoutClient() {
  const { ton, core, tcrypto } = tonLibs();
  const { Address, beginCell, toNano } = core;
  const words = PAYOUT_MNEMONIC.split(/\s+/).filter(Boolean);
  const keyPair = await tcrypto.mnemonicToPrivateKey(words);
  // toncenter v2 JSON-RPC with a key from the same pool the v3 reads use.
  const client = new ton.TonClient({ endpoint: 'https://toncenter.com/api/v2/jsonRPC', apiKey: nextToncKey() || undefined });
  const ownerAddr = await derivePayoutAddress(words, PAYOUT_WALLET_VERSION);
  const Contract = PAYOUT_WALLET_VERSION === 'v4' ? ton.WalletContractV4 : ton.WalletContractV5R1;
  const contract = Contract.create({ workchain: 0, publicKey: keyPair.publicKey });
  const wallet = client.open(contract);
  const masterAddr = Address.parse(JETTON);
  // The payout wallet's own jetton wallet, resolved from the jetton
  // master (get_wallet_address) — needed both to read the balance
  // and as the destination of the internal transfer message.
  async function myJettonWallet() {
    const res = await client.runMethod(masterAddr, 'get_wallet_address', [
      { type: 'slice', cell: beginCell().storeAddress(ownerAddr).endCell() }
    ]);
    return res.stack.readAddress();
  }
  return {
    addressRaw: ownerAddr.toRawString(),
    addressFriendly: ownerAddr.toString(),
    async getTonBalance() { return client.getBalance(ownerAddr); },
    async getJettonBalance() {
      const res = await client.runMethod(await myJettonWallet(), 'get_wallet_data');
      return res.stack.readBigNumber(); // stack: balance, owner, master, code
    },
    /* Standard TEP-74 jetton transfer (op 0x0f8a7ea5) from the payout
       wallet's jetton wallet to the recipient's OWNER wallet (their
       jetton wallet credits them), comment `VIKING-<wdNum>` as the
       forward payload so every payout is traceable on-chain.
       Returns after the wallet seqno has moved (the external message
       has landed) — bounded at ~60 s. */
    async sendJetton({ toRaw, amount, comment }) {
      const dest = Address.parse(String(toRaw));
      const jw = await myJettonWallet();
      const seqno = await wallet.getSeqno();
      const forwardPayload = beginCell().storeUint(0, 32).storeStringTail(String(comment || '')).endCell();
      const body = beginCell()
        .storeUint(0x0f8a7ea5, 32)          // transfer op
        .storeUint(0, 64)                   // query id
        .storeCoins(amount)                 // jetton amount, base units
        .storeAddress(dest)                 // recipient owner wallet
        .storeAddress(ownerAddr)            // response destination (excess TON returns here)
        .storeBit(0)                        // no custom payload
        .storeCoins(toNano('0.05'))         // forward TON amount (~0.05)
        .storeBit(1)                        // forward payload in a ref
        .storeRef(forwardPayload)
        .endCell();
      const msg = ton.internal({ to: jw, value: toNano('0.1'), body });
      let txHash = '';
      if (typeof wallet.createTransfer === 'function' && typeof wallet.send === 'function') {
        const ext = await wallet.createTransfer({ seqno, secretKey: keyPair.secretKey, messages: [msg] });
        txHash = ext.hash().toString('hex'); // LOCALLY computed external-message hash — NOT the on-chain tx id for V5R1 wallets (its tonviewer links 404); kept for logging only, findTransferTx resolves the real hash
        await wallet.send(ext);
      } else {
        await wallet.sendTransfer({ seqno, secretKey: keyPair.secretKey, messages: [msg] });
      }
      const deadline = Date.now() + 60000;
      let cur = seqno;
      while (Date.now() < deadline) {
        await txSleep(2500);
        try { cur = await wallet.getSeqno(); } catch (e) { /* a lagging read is not a failure */ }
        if (cur > seqno) break;
      }
      if (cur <= seqno) throw new Error('broadcast unconfirmed: seqno did not move within 60s');
      return { seqno, txHash };
    },
    /* Resolve the REAL on-chain transaction hash of a transfer this
       client just broadcast (called after sendJetton's seqno
       confirmation). Scan the payout wallet's newest transactions
       (toncenter v3, newest first) for OURS: the transaction at or
       after the broadcast whose FIRST out-message goes to our
       jetton wallet carrying a TEP-74 transfer body (op 0x0f8a7ea5)
       with the exact base amount and recipient, AND whose forward
       comment — decoded from the payload ref with the exact layout
       sendJetton builds (uint32 0 + string tail) — equals `comment`
       (VIKING-<wdNum>, unique per withdrawal). Polls every 5 s for up
       to ~90 s; a lagging index or a failed read just costs one
       poll. Returns the lowercase hex hash, or null on timeout —
       the caller then links the wallet page, never the local hash. */
    async findTransferTx({ comment, toRaw, amountBase, sinceMs }) {
      const { Cell } = core;
      const jwRaw = toRawAddress((await myJettonWallet()).toRawString());
      const ownerRaw = ownerAddr.toRawString();
      const wantDest = toRawAddress(String(toRaw || ''));
      let wantAmt;
      try { wantAmt = BigInt(amountBase); } catch (e) { return null; }
      const wantComment = String(comment || '');
      const bodyMatches = (cell) => {
        try {
          const s = cell.beginParse();
          if (s.loadUint(32) !== 0x0f8a7ea5) return false;   // TEP-74 transfer op
          s.loadUint(64);                                    // query id
          if (s.loadCoins() !== wantAmt) return false;       // exact base amount
          if (toRawAddress(s.loadAddress().toRawString()) !== wantDest) return false; // recipient owner wallet
          s.loadAddress();                                   // response destination (ourselves)
          s.loadBit();                                       // no custom payload
          s.loadCoins();                                     // forward TON amount
          if (!s.loadBit()) return false;                    // forward payload lives in a ref (sendJetton's layout)
          const f = s.loadRef().beginParse();
          if (f.loadUint(32) !== 0) return false;            // text-comment opcode
          return f.loadStringTail() === wantComment;
        } catch (e) { return false; }
      };
      const cutoff = (Number(sinceMs) || 0) - 15000; // small slack for indexer/clock skew
      const deadline = Date.now() + 90000;
      for (;;) {
        try {
          const txs = await toncTransactions(ownerRaw, 10, 'desc');
          for (const tx of txs) {
            const txMs = (Number(tx && tx.now) || 0) * 1000;
            if (!txMs || txMs < cutoff) continue;
            const outs = (tx && tx.out_msgs) || [];
            if (!Array.isArray(outs) || !outs.length) continue;
            const out = outs[0]; // this wallet sends exactly one internal message per transfer
            const dst = out && typeof out.destination === 'object' && out.destination ? out.destination.address : (out && out.destination);
            if (toRawAddress(dst || '') !== jwRaw) continue; // the message must go to OUR jetton wallet
            const mc = (out && out.message_content) || {};
            const bodyStr = typeof mc.body === 'string' ? mc.body : (typeof mc.body_hex === 'string' ? mc.body_hex : '');
            if (!bodyStr) continue;
            let cell = null;
            try {
              cell = (/^[0-9a-fA-F]+$/.test(bodyStr) && bodyStr.length % 2 === 0)
                ? Cell.fromBoc(Buffer.from(bodyStr, 'hex'))[0]
                : Cell.fromBase64(bodyStr);
            } catch (e) { continue; }
            if (!cell || !bodyMatches(cell)) continue;
            const h = txHashHex(tx.hash); // toncenter v3 hash is base64 — canonical hex
            if (h) return h;
          }
        } catch (e) { /* a lagging/failing read is not a failure — keep polling until the deadline */ }
        if (Date.now() >= deadline) return null;
        await txSleep(5000);
      }
    }
  };
}

let _payoutClientPromise = null;
function getPayoutClient() {
  if (!_payoutClientPromise) {
    _payoutClientPromise = (async () => {
      const stubPath = String(process.env.PAYOUT_STUB_MODULE || '');
      if (stubPath) { const m = require(stubPath); return m.createPayoutClient(); }
      return createRealPayoutClient();
    })();
    // Construction sends nothing, so a failed build must not poison
    // the process: drop the cached promise and let a later attempt
    // rebuild (each attempt re-runs its own claim first anyway).
    _payoutClientPromise.catch(() => { _payoutClientPromise = null; });
  }
  return _payoutClientPromise;
}

/* Owner alert for a failed automatic payout (Arabic admin style, via
   tg() like the other owner DMs). Best-effort: a failed alert must
   never mask the payout failure handling itself. */
async function payoutAlert(wd, reason) {
  if (!wd) return;
  await getConfig();
  const text = `🚨 <b>فشل الدفع التلقائي لسحب #${wd.wdNum}</b>\n👤 ${esc(wd.userName || '')} (<code>${esc(String(wd.userId || ''))}</code>)\n💎 <b>الصافي:</b> ${wd.net} $VIKING\n❌ <b>السبب:</b> ${esc(reason)}\nالسحب لسه «Pending» ورصيد اللاعب اتخصم خلاص — ادفع يدويًا أو ارفضه من لوحة التحكم.`;
  for (const adminId of adminChatIds()) {
    try {
      await tg('sendMessage', { chat_id: adminId, parse_mode: 'HTML', text });
    } catch (e) { console.error('payout alert', e.message); }
  }
}

async function attemptPayout(wdNum) {
  if (!payoutEnabled()) return;
  const num = Math.floor(Number(wdNum));
  if (!Number.isFinite(num) || num <= 0) return;
  const ref = rtdb().ref('withdrawals/wd_' + num);
  let wd = null;
  try {
    // 1) Atomic claim: only the invocation that flips the record
    //    from absent/'none' to 'paying' may proceed; 'paying',
    //    'paid' and 'failed' records are all hands-off (see header).
    wd = await txUpdate(ref, (x) => {
      if (x === null) return { skip: true, out: null };
      if ((x.payoutState || 'none') !== 'none') return { skip: true, out: null };
      return { value: { ...x, payoutState: 'paying', payoutAttemptAt: Date.now() }, out: x };
    });
    if (!wd) return; // claimed by someone else, or not in a payable state
    const decimals = await jettonDecimals();
    const amountBase = BigInt(Math.max(0, Math.floor(Number(wd.net) || 0))) * (10n ** BigInt(decimals));
    const client = await getPayoutClient();
    // 2) Balance gate: not enough jettons in the payout wallet is a
    //    clean failure — no broadcast, the record stays Pending for
    //    the manual flow, the owner hears about it once.
    const bal = await client.getJettonBalance();
    if (bal < amountBase) {
      await ref.update({ payoutState: 'failed', payoutError: 'insufficient jetton balance' });
      await payoutAlert(wd, 'insufficient jetton balance');
      return;
    }
    // 3+4) Broadcast the jetton transfer; once the seqno confirms
    //      it landed, resolve the REAL on-chain transaction hash and
    //      only then flip the record to Paid. The seam's returned
    //      hash is computed locally from the external message and,
    //      for V5R1 wallets, is NOT the transaction id (live proof
    //      2026-11-14: the stored local hash 404s on tonviewer while
    //      the transfer sits on-chain under a different hash). It is
    //      logged for forensics and NEVER stored or linked: payoutTx
    //      holds only the chain-resolved hash; when resolution times
    //      out the record keeps payoutTx '' and gains payoutTxLink
    //      (the payout wallet's tonviewer page) as the link target.
    const broadcastAt = Date.now();
    const sent = await client.sendJetton({ toRaw: wd.walletAddr, amount: amountBase, comment: 'VIKING-' + num });
    if (sent && sent.txHash) console.log('payout', num, 'local external hash (not the on-chain tx id):', String(sent.txHash));
    let resolvedTx = '';
    if (typeof client.findTransferTx === 'function') {
      try {
        resolvedTx = String((await client.findTransferTx({ comment: 'VIKING-' + num, toRaw: wd.walletAddr, amountBase, sinceMs: broadcastAt })) || '');
      } catch (e) { console.error('payout tx resolve', num, e.message); }
    }
    if (!/^[0-9a-fA-F]{64}$/.test(resolvedTx)) resolvedTx = '';
    const payoutTxLinkVal = resolvedTx ? '' : 'https://tonviewer.com/' + client.addressFriendly;
    await ref.update({
      status: 'Paid ✅', payoutState: 'paid',
      payoutTx: resolvedTx,
      payoutTxLink: resolvedTx ? null : payoutTxLinkVal, // null deletes a stale link if one ever existed
      payoutAt: Date.now()
    });
    // The celebration (photo DM + payouts-channel post, exactly once
    // via the payoutNotifiedAt claim). It must NEVER flip a completed
    // payout into the failure path below: sendPayoutSuccess swallows
    // its own errors, and this dedicated guard keeps even a surprise
    // throw out of the catch.
    try {
      const cfg = await getConfig();
      const p = await getVal(P(wd.userId)).catch(() => null);
      await sendPayoutSuccess({ ...wd, payoutTx: resolvedTx, payoutTxLink: payoutTxLinkVal }, p, cfg);
    } catch (e) { console.error('payout success notify', num, e.message); }
  } catch (e) {
    // 5) ANY failure lands here exactly once per attempt: mark the
    //    record failed (status stays 'Pending ⏳'), never re-credit,
    //    never broadcast again, and tell the owner why.
    const reason = String((e && e.message) || e || 'unknown error').slice(0, 200);
    console.error('payout', num, reason);
    try { await ref.update({ payoutState: 'failed', payoutError: reason }); } catch (e2) { console.error('payout state write', num, e2.message); }
    if (!wd) { try { wd = await getVal(ref); } catch (e3) { /* the alert tolerates a missing record */ } }
    await payoutAlert(wd, reason);
  }
}

/* ---------- payout success celebration (owner order 2026-11-14) ----------
   ONE shared celebration for EVERY withdrawal that becomes Paid —
   fired by attemptPayout's success path and by adminWd's manual
   approve alike. Two FIXED designs, deliberately different from
   each other (owner correction 2026-11-14): the player's DM is the
   personal one (warrior banner, «Your Payout is Sent!», his wallet,
   the tx button), the payouts-channel post (cfg.channel2) is the
   public proof (treasure-chest banner, «New Payout!», full name
   + the FULL receiver wallet in a code span — the owner reversed
   his earlier no-wallet-in-channel rule).
   Exactly-once is enforced on the record itself: the caller claims
   `payoutNotifiedAt` in a transaction BEFORE sending anything, so
   retries, races and re-approvals can never double-send. The claim
   is taken once the code is committed to attempting the user DM;
   the channel post is best-effort afterwards — its failure is
   logged and never re-opens the claim, never touches the payout
   state (the bot is not yet an admin in that channel; the post will
   simply start landing once the owner promotes it). */
const PAYOUT_DM_BANNER = 'https://ahmedrabieharoun-eng.github.io/viking/payout-banner2.webp';       // warrior with the glowing coin
const PAYOUT_CHANNEL_BANNER = 'https://ahmedrabieharoun-eng.github.io/viking/payout-banner.webp';   // treasure chest
/* The on-chain link for a paid withdrawal, in precedence order:
   the chain-resolved payoutTx hash (auto path) → payoutTxLink (the
   payout wallet's tonviewer page, stored when hash resolution
   timed out) → the txLink adminWd stored on manual approval → ''.
   No button is better than a dead link: the seam's locally computed
   external hash is never part of this chain — for V5R1 wallets it
   is not the transaction id, and links built from it 404. */
function payoutTxUrl(wd) {
  const h = String((wd && wd.payoutTx) || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(h)) return 'https://tonviewer.com/transaction/' + h;
  if (wd && wd.payoutTxLink) return String(wd.payoutTxLink);
  if (wd && wd.txLink) return String(wd.txLink);
  return '';
}
const fmtCoins = (n) => (Number(n) || 0).toLocaleString('en-US');

async function sendPayoutSuccess(wd, player, cfg) {
  try {
    if (!wd || !wd.wdNum || !cfg) return;
    const num = wd.wdNum;
    const claimed = await txUpdate(rtdb().ref('withdrawals/wd_' + num), (x) => {
      if (x === null) return { skip: true, out: false };
      if (x.payoutNotifiedAt) return { skip: true, out: false };
      return { value: { ...x, payoutNotifiedAt: Date.now() }, out: true };
    });
    if (!claimed) return; // already celebrated (or the record is gone)
    const amount = fmtCoins(wd.net);
    const botUname = await resolveBotUsername(cfg);
    const appUrl = botUname ? `https://t.me/${botUname}/app` : '';
    const txUrl = payoutTxUrl(wd); // shared by BOTH messages' «View Transaction» buttons (owner order 2026-11-14)
    /* ---- the player's DM ---- */
    try {
      const walletRaw = (player && player.walletAddr) || wd.walletAddr || '';
      const rows = [];
      if (appUrl) rows.push([{ text: '⚔️ Open VIKING', url: appUrl }]);
      if (txUrl) rows.push([{ text: '🔗 View Transaction', url: txUrl }]);
      const kb = rows.length ? { inline_keyboard: rows } : undefined;
      const caption = `💸 Your Payout is Sent!\n💎 <b>+${amount} ${esc(cfg.coinSym)}</b>\n👛 Wallet: <code>${esc(shortFriendlyAddress(walletRaw))}</code>\n🔢 Withdrawal #${num}\n📅 ${fmtDayMonYear(Date.now())}`;
      const photoRes = await tg('sendPhoto', { chat_id: String(wd.userId), photo: PAYOUT_DM_BANNER, caption, reply_markup: kb });
      if (!photoRes || !photoRes.ok) {
        await tg('sendMessage', { chat_id: String(wd.userId), text: caption, reply_markup: kb });
      }
    } catch (e) { console.error('payout success dm', num, e.message); }
    /* ---- the payouts-channel post (best-effort) ---- */
    try {
      const chanId = chatIdOf(cfg.channel2);
      if (chanId !== null && chanId !== '') {
        const fullName = (player && player.name) || wd.userName || '';
        const displayName = esc(String(fullName).trim() || 'Viking');
        const rows = [];
        if (appUrl) rows.push([{ text: '⚔️ Start Mining Now', url: appUrl }]);
        if (txUrl) rows.push([{ text: '🔗 View Transaction', url: txUrl }]);
        const kb = rows.length ? { inline_keyboard: rows } : undefined;
        // Public proof style — different wording/layout from the DM:
        // FULL name (owner order 2026-11-14) + amount + the FULL
        // friendly receiver wallet (owner reversed the earlier
        // no-wallet-in-channel rule) + WD number. The DM still
        // shows only the SHORT wallet form.
        const caption = `🏆 New Payout!\n👤 <b>${displayName}</b>\n💰 <b>${amount} ${esc(cfg.coinSym)}</b>\n👛 <code>${esc(toFriendlyAddress(wd.walletAddr || ''))}</code>\n🔢 Withdrawal #${num}`;
        let ok = false;
        const photoRes = await tg('sendPhoto', { chat_id: chanId, photo: PAYOUT_CHANNEL_BANNER, caption, reply_markup: kb });
        if (photoRes && photoRes.ok) ok = true;
        else {
          const msgRes = await tg('sendMessage', { chat_id: chanId, text: caption, reply_markup: kb });
          ok = !!(msgRes && msgRes.ok);
        }
        if (!ok) console.error('payout channel post failed', num);
      }
    } catch (e) { console.error('payout channel post failed', num, e.message); }
  } catch (e) {
    // The celebration must never break its callers (a completed
    // payout in attemptPayout, an approval in adminWd).
    console.error('payout success', wd && wd.wdNum, e.message);
  }
}

/* ---------- withdrawal review: the owner's bot panel (owner order 2026-11-14 ~07:29) ----------
   Automatic payout-on-request is REPLACED by manual review in the
   bot chat, modelled on the owner's AdVOLT messages bot: the owner
   pulls the pending queue with /withdrawals (round 2: NO card is
   sent when a withdrawal is created) and each withdrawal is
   presented as a review card carrying the full picture
   (identity + player number, wallet + verification + wallet age,
   current in-bot balance, join date, who referred him, his referral
   counts, the LIVE on-chain hold, the multi-account verdict +
   count, where his coins came from, his previous withdrawals) and four decision
   buttons — ✅ approve (fires the EXISTING attemptPayout state
   machine, unchanged), ❌ reject (NO refund: the deducted coins stay
   deducted — the owner's explicit order, deliberately unlike the
   admin panel's reject-refund), 🚫 ban (reject + ban the player),
   ⏭ skip. /withdrawals walks the pending queue one card at a time;
   every decision advances to the next card and the end of the queue
   prints a session summary. Sessions live in a process-local Map —
   a restart just means /withdrawals starts the walk over; the
   cards already in chat keep working because each decision
   re-reads the record and re-checks its status. Decisions are made
   in the DB FIRST and messaged second, so a Telegram failure can
   never corrupt a decision. */
const wdSessions = new Map(); // chatId -> { presented:Set<number>, paid, rejected, banned, skipped }
const fmtAmt = (n) => { const v = Number(n) || 0; return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: 2 }); };
const fmtDateTime = (ts) => fmtDayMonYear(ts) + ' · ' + new Date(Number(ts) || 0).toISOString().slice(11, 19) + ' UTC';

async function pendingWithdrawals() {
  const all = (await getVal(rtdb().ref('withdrawals'))) || {};
  return Object.values(all).filter((w) => w && w.status === 'Pending ⏳').sort((a, b) => (Number(a.wdNum) || 0) - (Number(b.wdNum) || 0));
}

/* The multi-account cluster around a player: the same both-
   directions BFS over the stored multiLinks lists that /multi
   (multiTree) performs — a player's links are its multiLinks.ids
   PLUS every player whose stored ids contain it (the stored lists
   are asymmetric). Returns the BFS order (target first) and each
   node's parent (the account it was first reached through), which
   is what linkReason() labels are read off. */
function multiClusterOf(players, target) {
  const idsOf = (p) => (p && p.multiLinks && Array.isArray(p.multiLinks.ids)) ? p.multiLinks.ids.map(String) : [];
  const listedBy = new Map();
  for (const [uid, p] of Object.entries(players || {})) {
    for (const id of idsOf(p)) {
      if (!listedBy.has(id)) listedBy.set(id, []);
      listedBy.get(id).push(uid);
    }
  }
  const neighborsOf = (uid) => [...new Set([...idsOf(players[uid]), ...(listedBy.get(uid) || [])])]
    .filter((id) => id !== uid && players[id]).sort();
  const parent = new Map([[target, null]]);
  const order = [target];
  for (let i = 0; i < order.length; i++) {
    for (const nb of neighborsOf(order[i])) {
      if (!parent.has(nb)) { parent.set(nb, order[i]); order.push(nb); }
    }
  }
  return { order, parent };
}

async function buildWdReviewCard(wd, position) {
  const cfg = await getConfig();
  const sym = esc(cfg.coinSym);
  const num = Number(wd.wdNum);
  const uid = String(wd.userId);
  const [player, players, prevWds] = await Promise.all([
    getVal(P(uid)),
    getVal(rtdb().ref('players')),
    withdrawalsOfUser(uid)
  ]);
  const p = player || {};
  const allPlayers = players || {};
  const name = esc(p.name || wd.userName || '—');
  const uname = p.username ? ' (@' + esc(p.username) + ')' : '';
  /* multi-account verdict (owner order 2026-11-14, round 2): the
     card shows ONLY the verdict + the cluster size, on its own
     line — never the linked accounts themselves (the full tree
     stays in /multi). The cluster is the stored-link cluster
     (both-directions BFS, as /multi) unioned with riskOf()'s live
     sig-registry links; after the round-2 rule a shared IP
     contributes to NEITHER source. */
  const linked = new Set();
  const { order } = multiClusterOf(allPlayers, uid);
  for (const id of order.slice(1)) linked.add(id);
  try {
    const rk = await riskOf(uid);
    for (const row of (rk && rk.linked) || []) linked.add(String(row.id));
  } catch (e) { /* the stored cluster alone is a complete picture */ }
  const multiLine = linked.size
    ? `🔴 <b>عامل تعدد — مرتبط بـ ${linked.size} حساب</b>`
    : '✅ <b>مش عامل تعدد</b>';
  /* live on-chain hold; a chain hiccup falls back to the player's
     last synced hold, labelled as such */
  let holdTxt;
  try { holdTxt = fmtAmt(await jettonHold(wd.walletAddr || p.walletAddr || '')); }
  catch (e) { holdTxt = fmtAmt(p.hold) + ' (آخر مزامنة)'; }
  const inv = p.invitedBy ? allPlayers[String(p.invitedBy)] : null;
  const invLine = p.invitedBy
    ? (inv ? `<b>${esc(inv.name || '—')}</b>${inv.username ? ' (@' + esc(inv.username) + ')' : ''} — <code>${esc(String(p.invitedBy))}</code>` : `<code>${esc(String(p.invitedBy))}</code>`)
    : 'دخول مباشر (بدون إحالة)';
  const refTotal = Object.values(allPlayers).filter((x) => x && String(x.invitedBy) === uid).length;
  const refActive = countActiveRefs(p.referrals); // the exact counter state() ships as player.activeRefs
  const prev = (prevWds || []).filter((w) => Number(w.wdNum) !== num);
  const prevSum = prev.reduce((s, w) => s + (Number(w.amt) || 0), 0);
  const verifiedLine = p.walletVerified === true
    ? '✅ موثّقة' + (Number(p.verifiedAt) > 0 ? ` (${fmtDayMonYear(p.verifiedAt)})` : '')
    : '❌ غير موثّقة';
  const ageLine = (p.walletAgeDays !== undefined && p.walletAgeDays !== null && Number.isFinite(Number(p.walletAgeDays)))
    ? `\n🕰 عمر المحفظة: ${Number(p.walletAgeDays)} يوم` : '';
  const joinLine = Number(p.createdAt) > 0
    ? `${fmtDayMonYear(p.createdAt)} (منذ ${Math.max(0, Math.floor((Date.now() - Number(p.createdAt)) / 86400000))} يوم)`
    : '—';
  /* earnings sources (owner order 2026-11-14, round 2): the
     earn* counters only started counting when they shipped, so a
     pre-existing player reads all zeros and the grid looks broken.
     When EVERY source is zero, say so in one honest line instead —
     presentation only, the counters themselves are never invented. */
  const sourcesAllZero = !(Number(p.earnMining) || 0) && !(Number(p.earnDaily) || 0) && !(Number(p.earnTasks) || 0) && !(Number(p.earnRef) || 0) && !(Number(p.refCommissionEarned) || 0);
  const sourcesBlock = sourcesAllZero
    ? '📊 <b>مصادر أرباحه:</b> مفيش أرباح متسجلة بالمصدر لحد دلوقتي'
    : `📊 <b>مصادر أرباحه:</b>\n⛏ التعدين: ${fmtAmt(p.earnMining)} · 📅 الدخول اليومي: ${fmtAmt(p.earnDaily)}\n✅ المهام: ${fmtAmt(p.earnTasks)} · 👥 الإحالات: ${fmtAmt(p.earnRef)} · 💸 عمولات محصّلة: ${fmtAmt(p.refCommissionEarned)}`;
  /* Layout (owner order 2026-11-14, round 2): one fact per line,
     a blank line between sections. With the multi section reduced
     to a single verdict line the card stays far under Telegram's
     4096 cap by construction — no shedding pass any more. */
  const text = [
    `🔍 <b>طلب سحب #${num}</b>${position ? ` — سحب ${position.index} من ${position.total}` : ''}`,
    '',
    `👤 <b>${name}</b>${uname}`,
    `🆔 <code>${esc(uid)}</code> · رقم اللاعب: ${Number(p.userNo) || '—'}`,
    '',
    `💰 <b>مبلغ السحب:</b> ${fmtCoins(wd.amt)} ${sym}`,
    `🧾 الرسوم: ${fmtCoins(wd.fee)} · الصافي: <b>${fmtCoins(wd.net)} ${sym}</b>`,
    '',
    `👛 <b>المحفظة:</b> <code>${esc(toFriendlyAddress(wd.walletAddr || p.walletAddr || ''))}</code>`,
    `🛡 التوثيق: ${verifiedLine}${ageLine}`,
    '',
    `💎 <b>رصيده في البوت الآن:</b> ${fmtAmt(p.mined)} ${sym} (بعد خصم السحب)`,
    `🪙 الهولد على الشبكة الآن: ${holdTxt} ${sym}`,
    '',
    `🗓 في البوت من: ${joinLine}`,
    `🔗 أحاله: ${invLine}`,
    `👥 إحالاته: ${refTotal} · النشطة: ${refActive}`,
    '',
    multiLine,
    '',
    sourcesBlock,
    '',
    `⌛ سحوبات سابقة: ${prev.length} (إجمالي ${fmtCoins(prevSum)} ${sym})`,
    `⏱ وقت الطلب: ${fmtDateTime(wd.timestamp)}`
  ].join('\n');
  const keyboard = {
    inline_keyboard: [
      [{ text: '✅ موافقة', callback_data: 'wdok:' + num }, { text: '❌ رفض', callback_data: 'wdno:' + num }],
      [{ text: '🚫 حظر المستخدم', callback_data: 'wdban:' + num }, { text: '⏭ تخطي', callback_data: 'wdskip:' + num }]
    ]
  };
  return { text, keyboard };
}

/* Send one review card for a withdrawal. Default target is the
   owner; review sessions pass their chat explicitly. With OWNER_ID
   unset there is nobody to review with — skip silently. */
async function sendWdReviewCard(wdNum, position, chatId) {
  const target = (chatId !== undefined && chatId !== null) ? chatId : OWNER_ID;
  if (!target) return;
  const wd = await getVal(rtdb().ref('withdrawals/wd_' + Number(wdNum)));
  if (!wd) return;
  const card = await buildWdReviewCard(wd, position);
  await tg('sendMessage', { chat_id: target, parse_mode: 'HTML', text: card.text, reply_markup: card.keyboard });
}

function ensureWdSession(chatId, num) {
  let s = wdSessions.get(chatId);
  if (!s) { s = { presented: new Set(), paid: 0, rejected: 0, banned: 0, skipped: 0 }; wdSessions.set(chatId, s); }
  if (num !== undefined && num !== null) s.presented.add(Number(num));
  return s;
}

/* Send the session's next card: the lowest still-pending withdrawal
   this session has not presented yet. Returns false at queue end. */
async function sendNextWdCard(chatId) {
  const s = wdSessions.get(chatId);
  if (!s) return false;
  const pending = await pendingWithdrawals();
  const rest = pending.filter((w) => !s.presented.has(Number(w.wdNum)));
  if (!rest.length) return false;
  const next = rest[0];
  const position = { index: s.presented.size + 1, total: s.presented.size + rest.length };
  s.presented.add(Number(next.wdNum));
  await sendWdReviewCard(Number(next.wdNum), position, chatId);
  return true;
}

/* After a decision/skip: present the next card, or close the
   session with its summary when the queue is exhausted. */
async function advanceWdSession(chatId) {
  const s = wdSessions.get(chatId);
  if (!s) return;
  let sent = false;
  try { sent = await sendNextWdCard(chatId); } catch (e) { console.error('wd session next', e.message); }
  if (sent) return;
  wdSessions.delete(chatId);
  try {
    await tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `🏁 <b>انتهت المراجعة</b> — ✅ مدفوع: ${s.paid} · ❌ مرفوض: ${s.rejected} · 🚫 محظور: ${s.banned} · ⏭ متخطى: ${s.skipped}` });
  } catch (e) { console.error('wd session summary', e.message); }
}

/* /withdrawals (owner-only, dispatched from handleOwnerTools):
   start a fresh review walk over the pending queue. */
async function startWdReview(chatId) {
  const pending = await pendingWithdrawals();
  if (!pending.length) {
    await tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: 'لا توجد سحوبات معلّقة ✅' });
    return;
  }
  wdSessions.set(chatId, { presented: new Set(), paid: 0, rejected: 0, banned: 0, skipped: 0 });
  await sendNextWdCard(chatId);
}

/* The review-card buttons (callback_query updates). Strictly
   owner-only; the callback is ALWAYS answered (a spinning button
   is a broken button). Every decision is committed to the DB
   before any message moves, and every Telegram call is
   best-effort — a messaging failure never corrupts a decision. */
async function handleBotCallback(cq) {
  let answered = false;
  const answer = async (text, alert) => {
    if (answered || !cq || !cq.id) return;
    answered = true;
    try { await tg('answerCallbackQuery', { callback_query_id: cq.id, ...(text ? { text, show_alert: !!alert } : {}) }); } catch (e) { /* best-effort */ }
  };
  try {
    const fromId = cq && cq.from ? String(cq.from.id) : '';
    await getConfig();
    if (!isAdminUid(fromId)) { await answer('⛔ للمالك فقط', true); return; }
    const m = /^wd(ok|no|ban|skip):(\d+)$/.exec(String((cq && cq.data) || ''));
    if (!m) { await answer(''); return; }
    const op = m[1], num = Number(m[2]);
    const msg = (cq && cq.message) || {};
    const chatId = msg.chat ? msg.chat.id : Number(OWNER_ID);
    const editCard = async (suffix) => {
      if (!msg.message_id || chatId === undefined || chatId === null) return;
      try {
        await tg('editMessageText', { chat_id: chatId, message_id: msg.message_id, parse_mode: 'HTML', text: String(msg.text || '') + suffix, reply_markup: { inline_keyboard: [] } });
      } catch (e) { console.error('wd card edit', num, e.message); }
    };
    const ref = rtdb().ref('withdrawals/wd_' + num);
    const wd = await getVal(ref);
    if (!wd || wd.status !== 'Pending ⏳') {
      await answer('اتقرر في السحب ده خلاص');
      if (wd) await editCard(`\n\n— <b>الحالة الحالية:</b> ${esc(wd.status)}`);
      return;
    }
    if (op === 'skip') {
      const s = ensureWdSession(chatId, num);
      s.skipped++;
      await answer('تم التخطي');
      await advanceWdSession(chatId);
      return;
    }
    if (op === 'ok') {
      if (!payoutEnabled()) { await answer('الدفع التلقائي مش مفعّل على السيرفر', true); return; }
      if (wd.payoutState === 'paying') { await answer('الدفع جاري تنفيذه بالفعل'); return; }
      ensureWdSession(chatId, num);
      await answer('جاري الدفع…');
      await editCard('\n\n✅ <b>تمت الموافقة — جاري الدفع…</b>');
      // Fire the EXISTING payout state machine WITHOUT awaiting it
      // in the webhook path (seqno confirmation + tx-hash
      // resolution can take a couple of minutes). The settle
      // handler reports the outcome to the owner and only then
      // advances the review session.
      attemptPayout(num).then(async () => {
        try {
          const fin = await getVal(ref);
          const cfg = await getConfig();
          if (fin && fin.status === 'Paid ✅') {
            const s = wdSessions.get(chatId);
            if (s) s.paid++;
            const txUrl = payoutTxUrl(fin);
            await tg('sendMessage', {
              chat_id: chatId, parse_mode: 'HTML',
              text: `💸 <b>سحب #${num} اتدفع</b> — ${fmtCoins(fin.net)} ${esc(cfg.coinSym)}`,
              ...(txUrl ? { reply_markup: { inline_keyboard: [[{ text: '🔗 View Transaction', url: txUrl }]] } } : {})
            });
          } else if (fin && fin.payoutState === 'failed') {
            await tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `⚠️ <b>سحب #${num}: الدفع فشل</b> — ${esc(fin.payoutError || 'خطأ غير معروف')} (السحب لسه معلّق)` });
          } else {
            await tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `ℹ️ سحب #${num}: الدفع اتقرر أو جاري من مكان تاني — الحالة الحالية: ${esc((fin && fin.status) || '؟')}` });
          }
        } catch (e) { console.error('wd approve followup', num, e.message); }
        await advanceWdSession(chatId);
      }).catch((e) => console.error('wd approve payout', num, e.message));
      return;
    }
    /* wdno / wdban: flip the record FIRST (atomically — a second
       tap on a stale card loses the race and changes nothing),
       then message. NO refund either way: the deducted coins stay
       deducted (owner's explicit order). */
    const flip = await txUpdate(ref, (x) => {
      if (x === null) return { skip: true, out: null };
      if (x.status !== 'Pending ⏳') return { skip: true, out: null };
      return { value: { ...x, status: 'Rejected ❌', decidedAt: Date.now() }, out: x };
    });
    if (!flip) { await answer('اتقرر في السحب ده خلاص'); return; }
    const s = ensureWdSession(chatId, num);
    const cfg = await getConfig();
    if (op === 'ban') {
      try {
        const pref = P(wd.userId);
        if ((await getVal(pref)) !== null) await pref.update({ banned: true });
      } catch (e) { console.error('wd ban', num, e.message); }
      s.banned++;
      await answer('تم حظر المستخدم ورفض السحب');
      await editCard('\n\n🚫 <b>تم حظر المستخدم ورفض السحب — لم تُسترد العملات</b>');
      try { await tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `🚫 تم حظر <b>${esc(wd.userName || '')}</b> ورفض سحبه #${num} (${fmtCoins(wd.amt)} ${esc(cfg.coinSym)}) — لم تُسترد عملاته` }); } catch (e) { console.error('wd ban confirm', num, e.message); }
    } else {
      s.rejected++;
      await answer('تم الرفض');
      await editCard('\n\n❌ <b>تم الرفض — لم تُسترد العملات</b>');
      try { await tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `❌ تم رفض سحب #${num} (<b>${esc(wd.userName || '')}</b> — ${fmtCoins(wd.amt)} ${esc(cfg.coinSym)}) ولم تُسترد عملاته` }); } catch (e) { console.error('wd reject confirm', num, e.message); }
    }
    await advanceWdSession(chatId);
  } catch (e) {
    console.error('bot callback', e.message);
    await answer('');
  }
}

/* Boot line (owner order 2026-11-14): one startup line, always —
   the disabled line, or the live wallet + balances when enabled.
   Balances are best-effort: a chain hiccup at boot is logged,
   never fatal. */
async function initPayout() {
  if (!payoutEnabled()) {
    console.log(PAYOUT_MNEMONIC ? '[payout] disabled (PAYOUT_MNEMONIC is not a 24-word mnemonic)' : '[payout] disabled (PAYOUT_MNEMONIC not set)');
    return;
  }
  try {
    const client = await getPayoutClient();
    let tonTxt = '?', jTxt = '?';
    try { tonTxt = (Number(await client.getTonBalance()) / 1e9).toFixed(4); } catch (e) { /* best-effort */ }
    try {
      const d = await jettonDecimals();
      jTxt = (Number(await client.getJettonBalance()) / Math.pow(10, d)).toLocaleString('en-US');
    } catch (e) { /* best-effort */ }
    console.log(`[payout] wallet ${client.addressFriendly} | TON ${tonTxt} | VIKING ${jTxt}`);
  } catch (e) {
    console.error('[payout] init failed:', e.message);
  }
}

/* ---------- owner-only actions ---------- */
function owner(c) {
  if (!isAdminUid(c.user.id)) fail(403, 'Forbidden');
  if (Date.now() / 1000 - (c.authDate || 0) > 3600) fail(401, 'Reopen the app to use the admin tools');
}

async function adminState(c) {
  owner(c);
  const [playersObj, wdsObj] = await Promise.all([
    getVal(rtdb().ref('players').orderByChild('lastSeen').limitToLast(300)),
    getVal(rtdb().ref('withdrawals').orderByChild('wdNum').limitToLast(200))
  ]);
  // RTDB queries return the newest N in ascending order — sort desc in code
  // to match Firestore's orderBy(..., 'desc') results.
  const players = Object.values(playersObj || {}).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  // Multi-account links (report-only): each entry's persisted multiLinks
  // {count, ids} is enriched in the response with the linked users'
  // names/usernames (from this page where possible, else a direct read).
  const byId = new Map(players.map((p) => [String(p.id), p]));
  await Promise.all(players.filter((p) => p.multiLinks && (p.multiLinks.ids || []).length).map(async (p) => {
    const users = [];
    for (const id of (p.multiLinks.ids || []).slice(0, MULTI_IDS_CAP)) {
      let src = byId.get(String(id));
      if (!src) { try { src = await getVal(P(id)); } catch (e) { src = null; } }
      if (src) users.push({ id: String(id), name: src.name || '', username: src.username || '' });
    }
    p.multiLinks = { ...p.multiLinks, users };
  }));
  const wds = Object.entries(wdsObj || {}).map(([docId, v]) => ({ docId, ...v })).sort((a, b) => (b.wdNum || 0) - (a.wdNum || 0));
  // Verified badges in the admin withdrawal list: one bounded lookup
  // per distinct withdrawal user (from this page where possible).
  {
    const seen = new Map();
    await Promise.all([...new Set(wds.map((x) => String(x.userId)))].map(async (id) => {
      let src = byId.get(id);
      if (!src) { try { src = await getVal(P(id)); } catch (e) { src = null; } }
      seen.set(id, !!(src && src.walletVerified === true));
    }));
    wds.forEach((x) => { x.userVerified = seen.get(String(x.userId)) === true; });
  }
  const pending = wds.filter((x) => String(x.status).includes('Pending')).slice(0, 15);
  await Promise.all(pending.map(async (x) => { try { x.risk = await riskOf(x.userId); } catch (e) { console.error('risk', e.message); } }));
  return { players, withdrawals: wds, config: c.cfg };
}

async function adminBan(c) {
  owner(c);
  if (!isId(c.body.id)) fail(400, 'Bad id');
  const ref = P(c.body.id);
  // Firestore .update() errors on a missing doc (-> 500 in the handler);
  // RTDB update() would silently create a stub, so check first to match.
  if ((await getVal(ref)) === null) fail(500, 'Server error');
  await ref.update({ banned: c.body.banned === true });
  return { success: true };
}

async function adminAdjust(c) {
  owner(c);
  const amt = Number(c.body.amount);
  // |amt| bound: an unbounded value (e.g. 1e308 from a fat-fingered panel
  // input) would make `mined` un-storable (Infinity) and fail writes later.
  if (!isId(c.body.id) || !Number.isFinite(amt) || Math.abs(amt) > 1e12) fail(400, 'Bad input');
  const ref = P(c.body.id);
  if ((await getVal(ref)) === null) fail(500, 'Server error'); // same missing-doc behaviour as adminBan
  await ref.update({ mined: admin.database.ServerValue.increment(amt) });
  return { success: true };
}

async function adminWd(c) {
  owner(c);
  const docId = String(c.body.docId || '');
  if (!/^wd_\d+$/.test(docId)) fail(400, 'Bad id'); // docId is used as an RTDB path segment — never let it traverse
  const ref = rtdb().ref('withdrawals/' + docId);
  const reject = c.body.decision === 'reject';
  const txHash = clean(c.body.txHash, 100).trim();
  // the status flip stays atomic on the withdrawal node (double-processing
  // guard); the reject refund is applied right after — see PORT_NOTES.md
  const w = await txUpdate(ref, (x) => {
    if (x === null) return { error: new Fail(404, 'Not found') };
    // The auto-payout state machine owns 'paying'/'paid' records: a
    // manual decision here could double-pay (approve while a jetton
    // broadcast is in flight) or double-credit (reject-refund a
    // transfer that already landed). 'Paid ✅' via payout is final.
    if (x.payoutState === 'paid' || x.payoutState === 'paying') return { error: new Fail(400, 'Already processed') };
    if (!String(x.status).includes('Pending')) return { error: new Fail(400, 'Already processed') };
    const upd = reject
      ? { status: 'Rejected ❌' }
      : { status: 'Paid ✅', txLink: txHash ? 'https://tonviewer.com/transaction/' + encodeURIComponent(txHash) : 'https://tonviewer.com/' + encodeURIComponent(x.walletAddr) };
    return { value: { ...x, ...upd }, out: x };
  });
  if (reject) {
    try {
      await P(w.userId).update({ mined: admin.database.ServerValue.increment(w.amt) });
    } catch (e) {
      // Never leave a withdrawal marked Rejected while its refund failed:
      // flip it back to its Pending status so the owner can retry, then
      // surface the error. (The Firestore original did flip+refund in one
      // transaction; RTDB cannot — see PORT_NOTES.md.)
      try { await ref.update({ status: w.status }); } catch (e2) { console.error('adminWd revert', e2.message); }
      throw e;
    }
  }
  if (!reject) {
    // The shared payout celebration (photo DM + payouts-channel
    // post) — the same helper the automatic payout fires, exactly
    // once via the payoutNotifiedAt claim, so a manually approved
    // withdrawal celebrates identically and can never double-send
    // (e.g. auto-paid first, approved later — already refused above
    // by the payoutState guard, and the claim would stop it anyway).
    try {
      const txLink = txHash ? 'https://tonviewer.com/transaction/' + encodeURIComponent(txHash) : 'https://tonviewer.com/' + encodeURIComponent(w.walletAddr);
      await sendPayoutSuccess({ ...w, txLink }, null, c.cfg);
    } catch (e) { console.error('adminWd celebrate', e.message); }
  }
  if (!reject && c.cfg.payoutChannel) {
    const url = txHash ? 'https://tonviewer.com/transaction/' + encodeURIComponent(txHash) : 'https://tonviewer.com/' + encodeURIComponent(w.walletAddr);
    const a = String(w.walletAddr);
    // 'Start Mining Now' points at the direct app link built from the
    // RESOLVED real username (getMe, via resolveBotUsername) — the
    // admin-set cfg.botUsername goes stale (owner order 2026-11-14).
    // Only if no username can be resolved at all do we keep the old
    // ?startapp construction so the button still renders.
    const startUname = (await resolveBotUsername(c.cfg)) || String(c.cfg.botUsername || '').replace(/^@/, '').trim();
    const startUrl = startUname ? `https://t.me/${startUname}/app` : `https://t.me/${c.cfg.botUsername}?startapp`;
    await tg('sendMessage', {
      chat_id: c.cfg.payoutChannel, parse_mode: 'HTML',
      text: `✅ <b>Successful Withdrawal Proof #${w.wdNum} | ${esc(c.cfg.brandTitle)}</b>\n\n🔢 <b>Operation ID:</b> <code>#${w.wdNum}</code>\n👤 <b>Player:</b> ${esc(w.userName)} (<code>${esc(String(w.userId).slice(0, 4))}***</code>)\n💰 <b>Withdrawn Amount:</b> ${w.amt} ${esc(c.cfg.coinSym)}\n💎 <b>Net Sent:</b> ${w.net} ${esc(c.cfg.coinSym)}\n👛 <b>Receiver Wallet:</b> <code>${esc(a.slice(0, 6) + '...' + a.slice(-6))}</code>\n\n@${esc(c.cfg.botUsername)}`,
      reply_markup: { inline_keyboard: [[{ text: '🔗 View Real TX Link', url }], [{ text: '⚔️ Start Mining Now', url: startUrl }]] }
    });
  }
  return { success: true };
}

async function adminSettings(c) {
  owner(c);
  const s = c.body.settings || {}, out = {};
  for (const k of NUM_KEYS) if (s[k] !== undefined) { const v = Number(s[k]); if (!Number.isFinite(v) || v < 0 || v > 1e12) fail(400, 'Bad ' + k); if ((k === 'withdrawFeePercent' || k === 'holdPercentReq') && v > 100) fail(400, 'Bad ' + k); out[k] = v; } // percents above 100 would make withdraw nets negative / holds impossible
  for (const k of STR_KEYS) if (s[k] !== undefined) out[k] = clean(s[k], 300);
  out.botToken = null; // was FieldValue.delete(): null in an RTDB update() deletes the child
  await rtdb().ref('settings/global').update(out);
  cfgCache = null;
  return { success: true };
}

const ACTIONS = { state, collect, daily, task, bioTask, refAch, wallet, unlink, verifyInfo, verifyCheck, refCollect, withdraw, setAvatar, adminState, adminBan, adminAdjust, adminWd, adminSettings };

ensureWebhook(); // self-register the Telegram webhook once per process (never blocks boot)
startVerifyWatcher(); // background deposit watcher (see verifyWatchTick; no-op when VERIFY_WATCH_MS=0)
startRefHoldWatcher(); // background referral-hold watcher (see refHoldWatchTick; no-op when REF_HOLD_WATCH_MS=0)
startRefRepairWatcher(); // background referral repair sweep (see refRepairTick; no-op when REF_REPAIR_MS=0)
initPayout(); // automatic-payout boot line (disabled line, or wallet + balances when PAYOUT_MNEMONIC is set)

functions.http('collectMining', async (req, res) => {
  res.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.set('Vary', 'Origin');
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Methods', 'POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).send('');
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  // Telegram webhook updates arrive on this same endpoint: they carry
  // update_id + message (or callback_query, for the withdrawal-review
  // card buttons) instead of initData/action and are authenticated
  // by the webhook secret header, never by initData — handled BEFORE
  // the API path (and before its rate limiter: Telegram retries must
  // not be throttled into dropping a verification).
  const updBody = req.body || {};
  if (typeof updBody.update_id === 'number' && (updBody.message || updBody.callback_query)) {
    const given = String(req.headers['x-telegram-bot-api-secret-token'] || '');
    const secret = webhookSecret();
    if (!BOT_TOKEN || given.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (markUpdateSeen(updBody.update_id)) {
      try {
        if (updBody.message) await handleBotMessage(updBody.message);
        else await handleBotCallback(updBody.callback_query); // withdrawal-review card buttons
      } catch (e) { console.error('bot update', e.message); }
    }
    return res.status(200).json({ ok: true });
  }
  try {
    const ip = clientIp(req);
    if (!hit('ip:' + ip, 600, 60000)) return res.status(429).json({ error: 'Too many requests, slow down' });
    const body = req.body || {};
    const auth = verifyInitData(body.initData);
    if (auth.error === 'config') { console.error('BOT_TOKEN env var is not set'); return res.status(500).json({ error: 'Server not configured' }); }
    if (auth.error === 'expired') return res.status(401).json({ error: 'Session expired, reopen the app' });
    if (auth.error) return res.status(401).json({ error: 'Unauthorized' });
    const name = typeof body.action === 'string' ? body.action : 'collect';
    if (!Object.prototype.hasOwnProperty.call(ACTIONS, name)) return res.status(400).json({ error: 'Unknown action' });
    const uid = String(auth.user.id);
    if (!/^\d+$/.test(uid)) return res.status(401).json({ error: 'Unauthorized' }); // Telegram user ids are numeric; anything else never reaches an RTDB path
    if (!hit('u:' + uid, 90, 60000) || !hit('a:' + uid + ':' + name, ACTION_LIMIT[name] || 60, 60000)) return res.status(429).json({ error: 'Too many requests, slow down' });
    const cfg = await getConfig();
    // Owner-only maintenance gate (owner order 2026-11-14): the app
    // renders its «update in progress» screen off the maintenance flag.
    // The switch itself is an emergency brake, so it is read FRESH on
    // every request (a single-value read — the cheapest there is)
    // instead of from the 60 s config cache: flipping ownerOnly in
    // Firebase must bite immediately, in both directions. Every other
    // setting may lag by the cache TTL; this one may not.
    const ownerOnlyLive = await getVal(rtdb().ref('settings/global/ownerOnly'));
    if (ownerOnlyLive === true && !isTesterUid(uid, cfg)) return res.status(403).json({ error: 'Update in progress', maintenance: true });
    const actx = { user: auth.user, startParam: auth.startParam, authDate: auth.authDate, body, cfg, ip };
    let result;
    try {
      result = await ACTIONS[name](actx);
    } catch (err) {
      // Self-heal (owner report 2026-11-14): the 'User not found'
      // hardening made this rare, not impossible — a NON-admin player
      // action that still surfaces it gets ONE ensurePlayer + retry
      // before the error reaches the user. Admin actions and every
      // other error pass straight through.
      if (!(err instanceof Fail) || err.message !== 'User not found' || name.startsWith('admin')) throw err;
      await ensurePlayer(actx);
      result = await ACTIONS[name](actx);
    }
    await noteSignals(uid, ip ? ['ip:' + hashIp(ip)] : []);
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof Fail) return res.status(err.status).json({ error: err.message });
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = { verifyInitData, clientKeys, riskOf, noteSignals, hit, publicConfig, chatIdOf, memberStatus, updateMultiLinks, completeVerification, verifyWatchTick, toFriendlyAddress, fmtDayMonYear, txUpdate, attemptPayout, derivePayoutAddress, payoutEnabled, sendPayoutSuccess, buildWdReviewCard, sendWdReviewCard, handleBotCallback, attributeReferral, syncReferralActive, refHoldWatchTick, refRepairTick };
