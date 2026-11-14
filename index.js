const functions = require('@google-cloud/functions-framework');
const admin = require('firebase-admin');
const crypto = require('crypto');

/* RTDB port of the Firestore original — same API, same logic, only the
   persistence layer changed (see PORT_NOTES.md for the mapping + caveats).
   The database is initialised lazily on first use so the module still boots
   (and answers auth errors) when the DB env is not configured yet. */
let _rtdb = null;
function rtdb() {
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

const JETTON = 'EQC6uN73kvaKh8LrTHQ8TQ5_vgqheI93iny5XUWkpQL9vjxI';
const MAX_AUTH_AGE_SEC = 24 * 60 * 60;
const MIN_COLLECT_SEC = 10;
const BASE_RATE = 250; // coins per day (same as before)
const DAILY = [10, 20, 30, 50, 70, 100, 200];
const DEFAULTS = {
  brandTitle: '$VIKING MINER', coinSym: '$VIKING', taskReward: 50,
  bioReward: 50, refAchReward1: 50, refAchReward10: 100, refAchReward25: 250, refAchReward50: 500, refAchReward100: 1000,
  refClaimPercent: 5, refMinHold: 200, minWithdraw: 5000, holdPercentReq: 25, withdrawFeePercent: 5,
  lvl1PerDay: 250, payoutWallet: '', payoutChannel: '@YGRAM1', adminChatId: '',
  buySwapUrl: 'https://app.ston.fi/swap?chartVisible=false&tt=EQC6uN73kvaKh8LrTHQ8TQ5_vgqheI93iny5XUWkpQL9vjxI&ft=GRAM',
  channel1: 'https://t.me/YGRAM1', channel2: 'https://t.me/telegram', botUsername: 'VIKINGMINER_BOT',
  // Wallet verification (owner order 2026-11-14): the fee is paid to
  // verifyDepositWallet with the comment VIKING-<userNo>; a wallet must
  // be at least verifyMinAgeDays old to be verified.
  verifyDepositWallet: 'UQBCoy7KjhL9VnKA_YOp4_hxmYKAQ8P8mIfx5FdIdSA6qvxE', verifyFeeTon: 0.05, verifyMinAgeDays: 7
};
const NUM_KEYS = ['lvl1PerDay', 'taskReward', 'bioReward', 'refAchReward1', 'refAchReward10', 'refAchReward25', 'refAchReward50', 'refAchReward100', 'refClaimPercent', 'refMinHold', 'minWithdraw', 'holdPercentReq', 'withdrawFeePercent', 'verifyFeeTon', 'verifyMinAgeDays'];
const STR_KEYS = ['brandTitle', 'coinSym', 'payoutWallet', 'payoutChannel', 'adminChatId', 'channel1', 'channel2', 'botUsername', 'buySwapUrl', 'verifyDepositWallet'];

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
/* A referral counts as ACTIVE only once it is verified: wallet() flips the
   inviter's referral entry to this status when the invitee syncs a wallet
   meeting the hold requirement. 'Pending ⏳' and '⚠️ Duplicate' never count
   (owner rule for the referral achievements). */
const ACTIVE_REF_STATUS = 'Verified ✅';
const countActiveRefs = (refs) => Object.values(refs || {}).filter((r) => r && String(r.status || '').trim() === ACTIVE_REF_STATUS).length;
const publicPlayer = (d) => {
  const o = { ...(d || {}) };
  delete o.sigs;
  delete o.multiLinks; // owner-only detection data (adminState + alerts) — never shown to the player
  // ads were removed from the app (owner order): the stored counters stay in
  // the DB as inert data but are no longer exposed to the client
  delete o.adsWatched;
  delete o.lastAdUtcDay;
  delete o.lastAdAt;
  o.referrals = (o.referrals || []).map((r) => { const x = { ...r }; delete x.deviceHash; x.verified = x.verified === true; return x; });
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
const WHY = { cid: 'نفس نسخة التطبيق', dev: 'نفس الجهاز', ip: 'نفس الـ IP' };
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
   Detection and owner notification ONLY. Nothing here bans, blocks or
   delays any action: state() calls updateMultiLinks() inside a try/catch
   after its main work, and the stored `banned` flag is never touched by
   this code.

   The detection itself is a faithful port of the AdVOLT anti-fraud
   system (lux_v5/send_worker_v802.js, checkAntiFraud + helpers) — the
   owner ordered THE SAME system here, with exactly one difference:
   where VOLT blocks the later account (blockNow), Viking RECORDS a link
   to the device owner in player.multiLinks and alerts the owner.

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
    if (mergedPre.length === storedML.length && mergedPre.every((x, i) => x === storedML[i])) return; // unchanged: no write, nothing fresh to alert
  }
  /* Persist + decide what is "fresh" INSIDE one transaction on the player
     node, against the freshest stored list. The stored list is the alert
     dedupe memory, and this is what makes an alert STRICTLY once per
     (user, linkedId) pair:
     - concurrent state calls for the same user cannot both see the pair
       as new — the loser's transaction re-runs against the committed
       list and finds nothing fresh;
     - a pair can alert again ONLY after it fully cleared from the stored
       list in between (a genuine unlink under this system, e.g. the
       device record changed hands) — never from a toggling computation.
     (The pre-port rule flapped exactly here: its link set was computed
     from the read-merge-write sigs arrays, and a concurrently dropped
     array entry toggled the set, re-alerting the same pair at 03:08 and
     03:11 after the first alerts at 03:05/03:06. The registry records
     used now are single-owner writes that are never merged, so the
     computed set is stable as well.) */
  const out = await txUpdate(ref, (cur) => {
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
    if (!changed && storedV2) return { skip: true, out: { fresh: [] } }; // nothing new: no write churn, no duplicate alert
    const fresh = merged.filter((id) => !(stored || []).includes(id));
    // Persist BEFORE alerting: an alert-send failure can lose one
    // message but can never duplicate one.
    return { value: { ...cur, multiLinks: { count: merged.length, ids: merged, updatedAt: Date.now(), v: 2 } }, out: { fresh } };
  });
  const fresh = (out && out.fresh) || [];
  if (!fresh.length || !OWNER_ID) return; // alerts are skipped silently without an owner id
  const rows = await Promise.all(fresh.slice(0, 15).map(async (id) => {
    const d = (await getVal(P(id))) || {};
    return { id, name: d.name || '', username: d.username || '' };
  }));
  const lines = rows.map((r) => `• <code>${esc(r.id)}</code> ${esc(r.name)}${r.username ? ' (@' + esc(r.username) + ')' : ''}`).join('\n');
  await tg('sendMessage', {
    chat_id: OWNER_ID, parse_mode: 'HTML',
    text: `⚠️ <b>تعدد حسابات — روابط جديدة</b>\n👤 ${esc(me.name || '')} (<code>${esc(uid)}</code>)${me.username ? ' (@' + esc(me.username) + ')' : ''}\n🔗 إجمالي الحسابات المرتبطة: ${ids.length}\nحسابات ارتبطت حديثًا:\n${lines}${fresh.length > rows.length ? '\n… +' + (fresh.length - rows.length) + ' أخرى' : ''}`
  });
}

let cfgCache = null;
async function getConfig() {
  if (cfgCache && Date.now() - cfgCache.t < 20000) return cfgCache.v;
  const s = await getVal(rtdb().ref('settings/global'));
  const v = { ...DEFAULTS, ...(s || {}) };
  delete v.botToken;
  cfgCache = { t: Date.now(), v };
  await loadHarvestedEmoji(); // the harvested premium-emoji map rides the same refresh cycle
  return v;
}
const PUBLIC_KEYS = ['brandTitle', 'coinSym', 'taskReward', 'bioReward', 'refAchReward1', 'refAchReward10', 'refAchReward25', 'refAchReward50', 'refAchReward100', 'refClaimPercent', 'refMinHold', 'minWithdraw', 'holdPercentReq', 'withdrawFeePercent', 'lvl1PerDay', 'buySwapUrl', 'channel1', 'channel2', 'botUsername'];
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
const ACTION_LIMIT = { state: 20, collect: 6, daily: 6, task: 8, bioTask: 8, refAch: 8, wallet: 8, unlink: 6, refCollect: 6, withdraw: 4, verifyInfo: 20, verifyCheck: 20 }; // per user per minute

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
async function tg(method, body) {
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
  const j = await ton('/address/' + encodeURIComponent(addr) + '/parse');
  if (!j || !j.raw_form) fail(400, 'Invalid wallet address');
  return j.raw_form;
}
async function jettonHold(raw) {
  const j = await ton('/accounts/' + encodeURIComponent(raw) + '/jettons/' + JETTON);
  if (!j) return 0;
  return parseFloat(j.balance || '0') / Math.pow(10, (j.jetton && j.jetton.decimals) || 9);
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
  const r = await fetch(TON_API_BASE + path, { headers: TON_API_KEY ? { 'X-API-Key': TON_API_KEY } : {}, signal: AbortSignal.timeout(10000) });
  if (r.status === 404 || r.status === 400) return null;
  if (!r.ok) fail(502, 'TON network is busy, try again');
  return r.json();
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
    await txUpdate(P(inv), (d) => {
      if (d === null) return { skip: true };
      const refs = d.referrals || [];
      if (!refs.some((r) => String(r.id) === String(uid))) return { skip: true };
      return { value: { ...d, referrals: refs.map((r) => (String(r.id) === String(uid) ? { ...r, verified: !!verified } : r)) } };
    });
  } catch (e) { console.error('refVerifiedFlag', e.message); }
}

const newPlayer = (user, extra) => ({
  id: String(user.id), name: clean(user.first_name || 'Warrior', 64), username: clean(user.username || 'user', 64),
  deviceHash: '', mined: 0, hold: 0, lastCollectTime: Date.now(), walletAddr: '', banned: false, invitedBy: null,
  refBonusPaid: false, refCommissionEarned: 0, pendingRefComm: 0, lastWithdrawTime: 0, adsWatched: 0,
  lastAdUtcDay: dayOf(Date.now()), task1Done: false, task2Done: false, bioTaskDone: false, dailyStreak: 0, lastDailyCheckIn: 0,
  lastSeen: Date.now(), referrals: [], createdAt: Date.now(), ...extra
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
    if (created && ok) {
      const dup = inv.deviceHash && inv.deviceHash === dev;
      const entry = { id: String(c.user.id), name: clean(c.user.first_name || 'Warrior', 64), deviceHash: dev, status: dup ? '⚠️ Duplicate' : 'Pending ⏳', profit: 0, at: Date.now() };
      await txUpdate(invRef, (cur) => {
        if (cur === null) return { skip: true };
        const refs = cur.referrals || [];
        if (refs.length >= 3000) return { skip: true }; // re-check the cap on the freshest value (the pre-read can race a burst of signups)
        if (refs.some((r) => String(r.id) === String(c.user.id))) return { skip: true };
        return { value: { ...cur, referrals: [...refs, entry] } };
      });
    }
  }
  await noteSignals(String(c.user.id), clientKeys(c.body.fp));
  // Multi-account detection (report-only): refresh this player's linked
  // accounts and alert the owner about NEW links. Strictly best-effort —
  // wrapped so it can never fail, block or meaningfully delay state.
  try { await updateMultiLinks(String(c.user.id), c.body); } catch (e) { console.error('multiLinks', e.message); }
  const [player, wds] = await Promise.all([getVal(ref), withdrawalsOfUser(c.user.id)]);
  // Expose the bot's REAL username (getMe, cached) so the bio task shows and
  // verifies the right handle; falls back to the settings value inside
  // resolveBotUsername, and publicConfig's copy is kept when both are empty.
  const botUsername = await resolveBotUsername(c.cfg);
  return { player: publicPlayer(player), settings: { ...publicConfig(c.cfg), ...(botUsername ? { botUsername } : {}) }, withdrawals: wds, now: Date.now() };
}

async function collect(c) {
  const ref = await ensurePlayer(c);
  const out = await txUpdate(ref, (d) => {
    if (d === null) return { error: new Fail(404, 'User not found') };
    if (d.banned === true) return { error: new Fail(403, 'Account banned') };
    const now = Date.now();
    const elapsed = Math.max(0, (now - (Number(d.lastCollectTime) || now)) / 1000);
    if (elapsed < MIN_COLLECT_SEC) return { error: new Fail(400, 'Wait 10 seconds') };
    const added = Math.min(86400, elapsed) * (BASE_RATE / 86400);
    return {
      value: { ...d, mined: (Number(d.mined) || 0) + added, lastCollectTime: now },
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
      value: { ...d, dailyStreak: streak, lastDailyCheckIn: now, mined: (Number(d.mined) || 0) + reward },
      out: { success: true, reward, streak }
    };
  });
}

async function task(c) {
  const n = Number(c.body.n);
  if (n !== 1 && n !== 2) fail(400, 'Bad task');
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
      value: { ...d, [key]: true, mined: (Number(d.mined) || 0) + reward },
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
      value: { ...d, bioTaskDone: true, mined: (Number(d.mined) || 0) + reward },
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
    allowed_updates: ['message']
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
   /start handling. The entity extractor only fires when the text does
   NOT start with '/', so it can never swallow the owner's /start,
   /emojipack or /emojihunt messages. */
async function handleOwnerTools(msg, text) {
  if (!OWNER_ID || !msg.from || String(msg.from.id) !== OWNER_ID) return false;
  const chatId = msg.chat.id;
  if (/^\/emojihunt(@\w+)?(\s|$)/.test(text)) { await emojiHunt(chatId); return true; }
  const pm = /^\/emojipack(@\w+)?(?:\s+(\S+))?/.exec(text);
  if (pm) { await emojiPack(chatId, (pm[2] || '').trim()); return true; }
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
      value: { ...d, mined: (Number(d.mined) || 0) + reward, refAchClaimed: { ...claimed, [n]: Date.now() } },
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
  const hold = await jettonHold(raw);
  const need = Number(c.cfg.refMinHold) || 200;
  const uid = String(c.user.id);
  // claim the wallet node first (the Firestore original checked ownership
  // inside its transaction before writing anything — same net effect here)
  await txUpdate(walletDoc(raw), (w) => {
    if (w === null) return { value: { userId: uid } };
    if (String(w.userId) !== uid) return { error: new Fail(400, 'This wallet is linked to another account') };
    return { skip: true };
  });
  const out = await txUpdate(ref, (d) => {
    if (d === null) return { error: new Fail(404, 'User not found') };
    const activate = !!(d.invitedBy && !d.refBonusPaid && hold >= need);
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
      value: { ...d, walletAddr: raw, hold, lastSyncAt: Date.now(), ...(activate ? { refBonusPaid: true } : {}), ...(voidsVerify ? { walletVerified: false, verifiedWallet: '', verifiedAt: 0, verifyTx: '' } : {}), ...(addrChanged ? { verifyPendingAt: 0 } : {}) },
      out: { oldAddr: d.walletAddr || '', inviterId: activate ? String(d.invitedBy) : null, myDeviceHash: d.deviceHash, voided: voidsVerify }
    };
  });
  if (out.voided) await syncRefVerifiedFlag(uid, false);
  if (out.oldAddr && out.oldAddr !== raw) await walletDoc(out.oldAddr).remove();
  if (out.inviterId) {
    await txUpdate(P(out.inviterId), (inv) => {
      if (inv === null) return { skip: true };
      if (inv.deviceHash === out.myDeviceHash) return { skip: true }; // original updated only when the hashes differ
      return { value: { ...inv, referrals: (inv.referrals || []).map((r) => (String(r.id) === uid ? { ...r, status: 'Verified ✅' } : r)) } };
    });
  }
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
  if (out.oldAddr) await walletDoc(out.oldAddr).remove();
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

/* The success messages (owner order 2026-11-14): fired ONCE, by
   whichever path wins the verification flip — the Verify button's
   check or the background watcher — never by a loser. The user gets
   the celebratory photo DM (welcome banner + caption, premiumized
   centrally by tg()); the owner gets a deposit alert with the tx
   link. Both are best-effort: a user who never started the bot
   cannot be DM'd, and a message failure must never fail (or roll
   back) a completed verification. */
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
    if (OWNER_ID) {
      await tg('sendMessage', {
        chat_id: OWNER_ID, parse_mode: 'HTML',
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
   caller won the flip, sends the success messages.
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
  let ageDays = null;
  try { ageDays = await walletAgeDays(ref, flip.player, wallet); } catch (e) { /* the caption falls back to '—' */ }
  await sendVerificationMessages(uid, flip.player, cfg, hash, ageDays);
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
const VERIFY_WATCH_MS = (() => { const v = Number(process.env.VERIFY_WATCH_MS); return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 10000; })();
let verifyWatchRunning = false;
async function verifyWatchTick() {
  if (verifyWatchRunning) return; // ticks never overlap
  verifyWatchRunning = true;
  try {
    const players = await getVal(rtdb().ref('players'));
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
        let age = null;
        try { age = await walletAgeDays(P(uid), p, p.walletAddr); } catch (e) { /* treated as not-yet-eligible below */ }
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

async function refCollect(c) {
  const ref = await ensurePlayer(c);
  return txUpdate(ref, (d) => {
    if (d === null) return { error: new Fail(404, 'User not found') };
    if (d.banned === true) return { error: new Fail(403, 'Account banned') };
    const amt = Number(d.pendingRefComm) || 0;
    if (amt <= 0) return { error: new Fail(400, 'No pending referral profits') };
    return {
      value: { ...d, pendingRefComm: 0, mined: (Number(d.mined) || 0) + amt, refCommissionEarned: (Number(d.refCommissionEarned) || 0) + amt },
      out: { success: true, amount: amt }
    };
  });
}

async function withdraw(c) {
  const cfg = c.cfg, ref = await ensurePlayer(c);
  const amt = Math.floor(Number(c.body.amount));
  const pre = await getVal(ref);
  if (!pre) fail(404, 'User not found');
  const addr = pre.walletAddr;
  if (!addr) fail(400, 'Connect TON wallet first');
  if (!Number.isFinite(amt) || amt < Number(cfg.minWithdraw)) fail(400, 'Minimum is ' + cfg.minWithdraw);
  const hold = await jettonHold(addr); // re-checked on-chain at withdrawal time
  const needHold = Math.ceil(amt * Number(cfg.holdPercentReq) / 100);
  if (hold < needHold) fail(400, 'Need ' + needHold + ' in wallet hold');
  const fee = Math.ceil(amt * Number(cfg.withdrawFeePercent) / 100), net = amt - fee;
  // Firestore original: balance deduction + counter increment + withdrawal
  // doc were ONE transaction. RTDB: player transaction (all guards live
  // here), then the counter transaction (serialises wd numbers), then the
  // doc write — see PORT_NOTES.md for the atomicity caveat.
  const me = await txUpdate(ref, (d) => {
    if (d === null) return { error: new Fail(500, 'Server error') }; // player was pre-checked above; matches the original crashing on a vanished doc
    if (d.banned === true) return { error: new Fail(403, 'Account banned') };
    if (d.walletAddr !== addr) return { error: new Fail(409, 'Wallet changed, try again') };
    if (Date.now() - (d.lastWithdrawTime || 0) < 86400000) return { error: new Fail(429, 'You can request once every 24 hours') };
    if (amt > (Number(d.mined) || 0)) return { error: new Fail(400, 'Insufficient balance') };
    return {
      value: { ...d, mined: (Number(d.mined) || 0) - amt, lastWithdrawTime: Date.now(), hold },
      out: { name: d.name }
    };
  });
  const num = await bumpCounter('withdrawals');
  const wd = { wdNum: num, userId: String(c.user.id), userName: clean(me.name, 64), walletAddr: addr, amt, net, fee, status: 'Pending ⏳', timestamp: Date.now() };
  await rtdb().ref('withdrawals/wd_' + num).set(wd);
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

/* ---------- owner-only actions ---------- */
function owner(c) {
  if (!OWNER_ID || String(c.user.id) !== OWNER_ID) fail(403, 'Forbidden');
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

const ACTIONS = { state, collect, daily, task, bioTask, refAch, wallet, unlink, verifyInfo, verifyCheck, refCollect, withdraw, adminState, adminBan, adminAdjust, adminWd, adminSettings };

ensureWebhook(); // self-register the Telegram webhook once per process (never blocks boot)
startVerifyWatcher(); // background deposit watcher (see verifyWatchTick; no-op when VERIFY_WATCH_MS=0)

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
  // update_id + message instead of initData/action and are authenticated
  // by the webhook secret header, never by initData — handled BEFORE
  // the API path (and before its rate limiter: Telegram retries must
  // not be throttled into dropping a verification).
  const updBody = req.body || {};
  if (typeof updBody.update_id === 'number' && updBody.message) {
    const given = String(req.headers['x-telegram-bot-api-secret-token'] || '');
    const secret = webhookSecret();
    if (!BOT_TOKEN || given.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (markUpdateSeen(updBody.update_id)) {
      try { await handleBotMessage(updBody.message); } catch (e) { console.error('bot update', e.message); }
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

module.exports = { verifyInitData, clientKeys, riskOf, noteSignals, hit, publicConfig, chatIdOf, memberStatus, updateMultiLinks, completeVerification, verifyWatchTick, toFriendlyAddress, fmtDayMonYear, txUpdate };
