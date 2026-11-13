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

const JETTON = 'EQBah244kAnjZEDX9HOIit4BX3UoGFmvp-y013x-14U3PLpg';
const MAX_AUTH_AGE_SEC = 24 * 60 * 60;
const MIN_COLLECT_SEC = 10;
const BASE_RATE = 250; // coins per day (same as before)
const DAILY = [10, 20, 30, 50, 70, 100, 200];
const DEFAULTS = {
  brandTitle: '$VIKING MINER', coinSym: '$VIKING', adReward: 5, maxAdsPerDay: 10, taskReward: 50,
  refClaimPercent: 5, refMinHold: 200, minWithdraw: 5000, holdPercentReq: 25, withdrawFeePercent: 5,
  lvl1PerDay: 250, payoutWallet: '', adsgramBlockId: '', payoutChannel: '@YGRAM1', adminChatId: '',
  buySwapUrl: 'https://app.ston.fi/swap?chartVisible=false&tt=' + JETTON + '&ft=GRAM',
  channel1: 'https://t.me/YGRAM1', channel2: 'https://t.me/telegram', botUsername: 'VIKINGMINER_BOT'
};
const NUM_KEYS = ['lvl1PerDay', 'adReward', 'maxAdsPerDay', 'taskReward', 'refClaimPercent', 'refMinHold', 'minWithdraw', 'holdPercentReq', 'withdrawFeePercent'];
const STR_KEYS = ['brandTitle', 'coinSym', 'payoutWallet', 'adsgramBlockId', 'payoutChannel', 'adminChatId', 'channel1', 'channel2', 'botUsername', 'buySwapUrl'];

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
   fn may run several times under contention; only the last run's result counts. */
async function txUpdate(ref, fn) {
  let out, err = null, skip = false;
  const res = await ref.transaction((cur) => {
    const r = fn(cur) || {};
    if (r.error) { err = r.error; out = undefined; skip = false; return undefined; }
    if (r.skip) { skip = true; err = null; out = r.out; return undefined; }
    skip = false; err = null; out = r.out;
    return r.value;
  });
  if (err) throw err;
  if (!res.committed && !skip) throw new Fail(500, 'Server error');
  return out;
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
const publicPlayer = (d) => {
  const o = { ...(d || {}) };
  delete o.sigs;
  o.referrals = (o.referrals || []).map((r) => { const x = { ...r }; delete x.deviceHash; return x; });
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
    return { id, name: d.name || '', mined: d.mined || 0, banned: d.banned === true, via: [...linked[id]].map((k) => WHY[k]) };
  }));
  return { level, reasons, linked: rows };
}

let cfgCache = null;
async function getConfig() {
  if (cfgCache && Date.now() - cfgCache.t < 20000) return cfgCache.v;
  const s = await getVal(rtdb().ref('settings/global'));
  const v = { ...DEFAULTS, ...(s || {}) };
  delete v.botToken;
  cfgCache = { t: Date.now(), v };
  return v;
}
const PUBLIC_KEYS = ['brandTitle', 'coinSym', 'adReward', 'maxAdsPerDay', 'taskReward', 'refClaimPercent', 'refMinHold', 'minWithdraw', 'holdPercentReq', 'withdrawFeePercent', 'lvl1PerDay', 'adsgramBlockId', 'buySwapUrl', 'channel1', 'channel2', 'botUsername'];
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
const ACTION_LIMIT = { state: 20, collect: 6, daily: 6, ad: 12, task: 8, wallet: 8, unlink: 6, refCollect: 6, withdraw: 4 }; // per user per minute

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

async function tg(method, body) {
  if (!BOT_TOKEN) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    return await r.json();
  } catch (e) { console.error('telegram', method, e.message); return null; }
}
async function isMember(url, userId) {
  const m = /t\.me\/([A-Za-z][A-Za-z0-9_]{3,})/.exec(String(url || ''));
  if (!m) return null;
  const j = await tg('getChatMember', { chat_id: '@' + m[1], user_id: Number(userId) });
  if (!j || !j.ok) return null; // bot cannot check this channel
  const s = j.result.status;
  return ['creator', 'administrator', 'member'].includes(s) || (s === 'restricted' && j.result.is_member === true);
}

async function ton(path) {
  const r = await fetch('https://tonapi.io/v2' + path, { headers: TONAPI_KEY ? { Authorization: 'Bearer ' + TONAPI_KEY } : {} });
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

const newPlayer = (user, extra) => ({
  id: String(user.id), name: clean(user.first_name || 'Warrior', 64), username: clean(user.username || 'user', 64),
  deviceHash: '', mined: 0, hold: 0, lastCollectTime: Date.now(), walletAddr: '', banned: false, invitedBy: null,
  refBonusPaid: false, refCommissionEarned: 0, pendingRefComm: 0, lastWithdrawTime: 0, adsWatched: 0,
  lastAdUtcDay: dayOf(Date.now()), task1Done: false, task2Done: false, dailyStreak: 0, lastDailyCheckIn: 0,
  lastSeen: Date.now(), referrals: [], createdAt: Date.now(), ...extra
});

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
    if (created && ok) {
      const dup = inv.deviceHash && inv.deviceHash === dev;
      const entry = { id: String(c.user.id), name: clean(c.user.first_name || 'Warrior', 64), deviceHash: dev, status: dup ? '⚠️ Duplicate' : 'Pending ⏳', profit: 0, at: Date.now() };
      await txUpdate(invRef, (cur) => {
        if (cur === null) return { skip: true };
        const refs = cur.referrals || [];
        if (refs.some((r) => String(r.id) === String(c.user.id))) return { skip: true };
        return { value: { ...cur, referrals: [...refs, entry] } };
      });
    }
  }
  await noteSignals(String(c.user.id), clientKeys(c.body.fp));
  const [player, wds] = await Promise.all([getVal(ref), withdrawalsOfUser(c.user.id)]);
  return { player: publicPlayer(player), settings: publicConfig(c.cfg), withdrawals: wds, now: Date.now() };
}

async function collect(c) {
  const ref = P(c.user.id);
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
  const ref = P(c.user.id);
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

async function ad(c) {
  const ref = P(c.user.id);
  return txUpdate(ref, (d) => {
    if (d === null) return { error: new Fail(404, 'User not found') };
    if (d.banned === true) return { error: new Fail(403, 'Account banned') };
    const now = Date.now(), today = dayOf(now);
    const seen = d.lastAdUtcDay === today ? d.adsWatched || 0 : 0;
    if (seen >= Number(c.cfg.maxAdsPerDay)) return { error: new Fail(400, 'Daily ad limit reached') };
    if (now - (d.lastAdAt || 0) < 15000) return { error: new Fail(429, 'Please wait before the next ad') };
    const reward = Number(c.cfg.adReward) || 5;
    return {
      value: { ...d, adsWatched: seen + 1, lastAdUtcDay: today, lastAdAt: now, mined: (Number(d.mined) || 0) + reward },
      out: { success: true, reward }
    };
  });
}

async function task(c) {
  const n = Number(c.body.n);
  if (n !== 1 && n !== 2) fail(400, 'Bad task');
  if ((await isMember(c.cfg['channel' + n], c.user.id)) === false) fail(400, 'Join the channel first');
  const ref = P(c.user.id), key = 'task' + n + 'Done';
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

async function wallet(c) {
  const ref = P(c.user.id);
  const p = await getVal(ref);
  if (!p) fail(404, 'User not found');
  if (p.banned === true) fail(403, 'Account banned');
  if (Date.now() - (p.lastSyncAt || 0) < 8000) fail(429, 'Please wait a few seconds');
  const raw = c.body.address ? await rawAddress(String(c.body.address).slice(0, 100)) : p.walletAddr;
  if (!raw) fail(400, 'Connect a wallet first');
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
    return {
      value: { ...d, walletAddr: raw, hold, lastSyncAt: Date.now(), ...(activate ? { refBonusPaid: true } : {}) },
      out: { oldAddr: d.walletAddr || '', inviterId: activate ? String(d.invitedBy) : null, myDeviceHash: d.deviceHash }
    };
  });
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
  const ref = P(c.user.id);
  const out = await txUpdate(ref, (d) => {
    if (d === null) return { error: new Fail(404, 'User not found') };
    return { value: { ...d, walletAddr: '', hold: 0 }, out: { oldAddr: d.walletAddr || '' } };
  });
  if (out.oldAddr) await walletDoc(out.oldAddr).remove();
  return { success: true };
}

async function refCollect(c) {
  const ref = P(c.user.id);
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
  const cfg = c.cfg, ref = P(c.user.id);
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
  const cres = await rtdb().ref('meta/counters').transaction((cur) => ({ ...(cur || {}), withdrawals: ((cur && cur.withdrawals) || 0) + 1 }));
  const num = cres.snapshot.val().withdrawals;
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
  const wds = Object.entries(wdsObj || {}).map(([docId, v]) => ({ docId, ...v })).sort((a, b) => (b.wdNum || 0) - (a.wdNum || 0));
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
  if (!isId(c.body.id) || !Number.isFinite(amt)) fail(400, 'Bad input');
  const ref = P(c.body.id);
  if ((await getVal(ref)) === null) fail(500, 'Server error'); // same missing-doc behaviour as adminBan
  await ref.update({ mined: admin.database.ServerValue.increment(amt) });
  return { success: true };
}

async function adminWd(c) {
  owner(c);
  const ref = rtdb().ref('withdrawals/' + String(c.body.docId));
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
  if (reject) await P(w.userId).update({ mined: admin.database.ServerValue.increment(w.amt) });
  if (!reject && c.cfg.payoutChannel) {
    const url = txHash ? 'https://tonviewer.com/transaction/' + encodeURIComponent(txHash) : 'https://tonviewer.com/' + encodeURIComponent(w.walletAddr);
    const a = String(w.walletAddr);
    await tg('sendMessage', {
      chat_id: c.cfg.payoutChannel, parse_mode: 'HTML',
      text: `✅ <b>Successful Withdrawal Proof #${w.wdNum} | ${esc(c.cfg.brandTitle)}</b>\n\n🔢 <b>Operation ID:</b> <code>#${w.wdNum}</code>\n👤 <b>Player:</b> ${esc(w.userName)} (<code>${esc(String(w.userId).slice(0, 4))}***</code>)\n💰 <b>Withdrawn Amount:</b> ${w.amt} ${esc(c.cfg.coinSym)}\n💎 <b>Net Sent:</b> ${w.net} ${esc(c.cfg.coinSym)}\n👛 <b>Receiver Wallet:</b> <code>${esc(a.slice(0, 6) + '...' + a.slice(-6))}</code>\n\n@${esc(c.cfg.botUsername)}`,
      reply_markup: { inline_keyboard: [[{ text: '🔗 View Real TX Link', url }], [{ text: '⚔️ Start Mining Now', url: `https://t.me/${c.cfg.botUsername}?startapp` }]] }
    });
  }
  return { success: true };
}

async function adminSettings(c) {
  owner(c);
  const s = c.body.settings || {}, out = {};
  for (const k of NUM_KEYS) if (s[k] !== undefined) { const v = Number(s[k]); if (!Number.isFinite(v) || v < 0) fail(400, 'Bad ' + k); out[k] = v; }
  for (const k of STR_KEYS) if (s[k] !== undefined) out[k] = clean(s[k], 300);
  out.botToken = null; // was FieldValue.delete(): null in an RTDB update() deletes the child
  await rtdb().ref('settings/global').update(out);
  cfgCache = null;
  return { success: true };
}

const ACTIONS = { state, collect, daily, ad, task, wallet, unlink, refCollect, withdraw, adminState, adminBan, adminAdjust, adminWd, adminSettings };

functions.http('collectMining', async (req, res) => {
  res.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.set('Vary', 'Origin');
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Methods', 'POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).send('');
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
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
    if (!hit('u:' + uid, 90, 60000) || !hit('a:' + uid + ':' + name, ACTION_LIMIT[name] || 60, 60000)) return res.status(429).json({ error: 'Too many requests, slow down' });
    const cfg = await getConfig();
    const result = await ACTIONS[name]({ user: auth.user, startParam: auth.startParam, authDate: auth.authDate, body, cfg, ip });
    await noteSignals(uid, ip ? ['ip:' + hashIp(ip)] : []);
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof Fail) return res.status(err.status).json({ error: err.message });
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = { verifyInitData, clientKeys, riskOf, noteSignals, hit, publicConfig };
