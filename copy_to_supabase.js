'use strict';
/* One-time RTDB -> Supabase copy + reconciliation for the VIKING
   migration. Runs ON the EC2 instance from ~/viking-server (where
   firebase-admin, service-account.json and .env already live).
   Modes:  node copy_to_supabase.js probe | copy | check
   Prints COUNTS ONLY — never record contents, never credentials. */
const fs = require('fs');
const path = require('path');

function loadEnv() {
  const env = {};
  try {
    for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) env[m[1]] = m[2].trim();
    }
  } catch (e) { /* fall through to process.env */ }
  return { ...env, ...process.env };
}
const ENV = loadEnv();
const REST = String(ENV.SUPABASE_REST_URL || '').replace(/\/+$/, '');
const KEY = ENV.SUPABASE_SERVICE_KEY || '';
if (!REST || !KEY) { console.error('SUPABASE env missing'); process.exit(2); }

async function sbReq(method, p, body) {
  const r = await fetch(REST + p, {
    method,
    headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  if (!r.ok) throw new Error('supabase ' + method + ' ' + p.split('?')[0] + ' -> ' + r.status + ' ' + t.slice(0, 160));
  return t ? JSON.parse(t) : null;
}
const sbRpc = (name, args) => sbReq('POST', '/rpc/' + name, args);
async function sbReadAll(table) {
  const out = [];
  const keyCol = table === 'docs' ? 'path' : 'id';
  for (let off = 0; ; off += 1000) {
    const rows = await sbReq('GET', '/' + table + '?select=' + keyCol + ',data&limit=1000&offset=' + off);
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

let _db = null;
function rtdb() {
  if (_db) return _db;
  const admin = require('firebase-admin');
  const saPath = path.join(__dirname, 'service-account.json');
  const cred = fs.existsSync(saPath) ? admin.credential.cert(require(saPath)) : admin.credential.applicationDefault();
  admin.initializeApp({ credential: cred, databaseURL: ENV.FIREBASE_DATABASE_URL });
  _db = admin.database();
  return _db;
}
async function snapshot() {
  const snap = await rtdb().ref('/').once('value');
  return snap.val() || {};
}

const MAP_ROOTS = ['wallets', 'sigs', 'deviceIds', 'devices', 'verifyClaims', 'refRepairQueue', 'settings', 'meta'];
function transform(root) {
  const players = [], withdrawals = [], docs = [];
  for (const [id, data] of Object.entries(root.players || {})) players.push({ id, data });
  for (const [id, data] of Object.entries(root.withdrawals || {})) withdrawals.push({ id, data });
  for (const [node, value] of Object.entries(root)) {
    if (node === 'players' || node === 'withdrawals') continue;
    if (node === 'premiumEmoji') { docs.push({ path: 'premiumEmoji', data: value }); continue; }
    if (value && typeof value === 'object') {
      for (const [child, data] of Object.entries(value)) docs.push({ path: node + '/' + child, data });
    } else {
      docs.push({ path: node, data: value });
    }
  }
  return { players, withdrawals, docs };
}

async function bulkPut(table, rows) {
  let n = 0;
  for (let i = 0; i < rows.length; i += 200) {
    n += await sbRpc('bulk_put', { p_table: table, p_rows: rows.slice(i, i + 200) });
  }
  return n;
}

const canon = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
};

(async () => {
  const mode = process.argv[2];
  if (mode === 'probe') {
    await sbReq('GET', '/players?select=id&limit=1');
    await sbRpc('doc_write', { p_table: 'docs', p_key: 'meta/__probe', p_subpath: [], p_value: { t: 1 }, p_mode: 'set', p_expect_v: null });
    const rows = await sbReq('GET', '/docs?path=eq.meta%2F__probe&select=data');
    if (!rows.length || rows[0].data.t !== 1) throw new Error('probe read-back mismatch');
    await sbRpc('doc_write', { p_table: 'docs', p_key: 'meta/__probe', p_subpath: [], p_value: null, p_mode: 'remove', p_expect_v: null });
    console.log('PROBE OK (tables + doc_write + bulk schema present)');
    return;
  }
  if (mode === 'copy') {
    const root = await snapshot();
    const t = transform(root);
    const np = await bulkPut('players', t.players);
    const nw = await bulkPut('withdrawals', t.withdrawals);
    const nd = await bulkPut('docs', t.docs);
    console.log(`COPY DONE players=${np} withdrawals=${nw} docs=${nd}`);
    return;
  }
  if (mode === 'check') {
    const root = await snapshot();
    const t = transform(root);
    const compare = async (table, rows) => {
      const sbRows = await sbReadAll(table);
      const keyOf = (r) => (table === 'docs' ? r.path : r.id);
      const sbMap = new Map(sbRows.map((r) => [keyOf(r), r.data]));
      let missing = 0, mismatch = 0; const badIds = [];
      for (const r of rows) {
        const k = keyOf(r);
        if (!sbMap.has(k)) { missing++; if (badIds.length < 5) badIds.push(k); }
        else if (canon(sbMap.get(k)) !== canon(r.data)) { mismatch++; if (badIds.length < 5) badIds.push(k); }
        sbMap.delete(k);
      }
      console.log(`CHECK ${table}: rtdb=${rows.length} supabase=${sbRows.length} missing=${missing} mismatched=${mismatch} extra=${sbMap.size}${badIds.length ? ' sample=' + badIds.join(',') : ''}`);
    };
    await compare('players', t.players);
    await compare('withdrawals', t.withdrawals);
    await compare('docs', t.docs);
    return;
  }
  console.error('usage: node copy_to_supabase.js probe|copy|check');
  process.exit(2);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
