'use strict';
/* Field-name diff for the VIKING migration gate report.
   Runs ON the EC2 instance from ~/viking-server. For each given
   player id (or doc:<path>), reads the record from RTDB and from
   Supabase and prints ONLY the names of top-level fields whose
   canonical values differ — never values, never credentials.
   Usage: node field_diff.js [playerId ...] [doc:path ...] */
const fs = require('fs');
const path = require('path');

function loadEnv() {
  const env = {};
  try {
    for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) env[m[1]] = m[2].trim();
    }
  } catch (e) { /* fall through */ }
  return { ...env, ...process.env };
}
const ENV = loadEnv();
const REST = String(ENV.SUPABASE_REST_URL || '').replace(/\/+$/, '');
const KEY = ENV.SUPABASE_SERVICE_KEY || '';
if (!REST || !KEY) { console.error('SUPABASE env missing'); process.exit(2); }

async function sbReq(method, p) {
  const r = await fetch(REST + p, {
    method,
    headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
  });
  const t = await r.text();
  if (!r.ok) throw new Error('supabase ' + method + ' ' + p.split('?')[0] + ' -> ' + r.status);
  return t ? JSON.parse(t) : null;
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

function canon(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
}
function diffFields(a, b) {
  const out = [];
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    if (canon((a || {})[k]) !== canon((b || {})[k])) out.push(k);
  }
  return out.sort();
}

(async () => {
  const args = process.argv.slice(2);
  const playerIds = args.filter((a) => !a.startsWith('doc:'));
  const docPaths = args.filter((a) => a.startsWith('doc:')).map((a) => a.slice(4));
  for (const id of playerIds) {
    const rt = (await rtdb().ref('players/' + id).once('value')).val();
    const rows = await sbReq('GET', '/players?id=eq.' + encodeURIComponent(id) + '&select=data');
    const sb = rows && rows.length ? rows[0].data : null;
    if (rt == null || sb == null) { console.log('PLAYER ' + id + ': present rtdb=' + (rt != null) + ' supabase=' + (sb != null)); continue; }
    const d = diffFields(rt, sb);
    console.log('PLAYER ' + id + ': ' + (d.length ? 'DIFF fields=[' + d.join(',') + ']' : 'MATCH'));
  }
  for (const p of docPaths) {
    const segs = p.split('/');
    let rt = (await rtdb().ref(segs.length > 1 ? segs[0] : p).once('value')).val();
    if (segs.length > 1) { for (let i = 1; i < segs.length; i++) rt = rt == null ? null : rt[segs[i]]; }
    const rows = await sbReq('GET', '/docs?path=eq.' + encodeURIComponent(p) + '&select=data');
    const sb = rows && rows.length ? rows[0].data : null;
    if (rt == null || sb == null) { console.log('DOC ' + p + ': present rtdb=' + (rt != null) + ' supabase=' + (sb != null)); continue; }
    const d = diffFields(rt, sb);
    console.log('DOC ' + p + ': ' + (d.length ? 'DIFF fields=[' + d.join(',') + ']' : 'MATCH'));
  }
  console.log('FIELD-DIFF DONE');
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
