'use strict';
/* Server-level smoke test: boots the REAL server (functions-framework,
   target collectMining) with DB_BACKEND=supabase against the local
   PostgREST stack — with NO Firebase env at all — and drives the
   public API the way the Mini App does.
   Run: SB_KEY_FILE=~/workspace/tools/postgrest/local_service_key.txt node test_sb_server.js */
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');

const APP_PORT = 18096, TG_PORT = 18097, TON_PORT = 18098;
const BOT_TOKEN = '999:smoke-token';
const REST = 'http://127.0.0.1:3000';
const KEY = fs.readFileSync((process.env.SB_KEY_FILE || '').replace(/^~/, process.env.HOME), 'utf8').trim();

let pass = 0, fail = 0;
const chk = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok', name); }
  else { fail++; console.log('  FAIL', name, extra === undefined ? '' : JSON.stringify(extra)); }
};

function makeInitData(user) {
  const params = new URLSearchParams();
  params.set('user', JSON.stringify(user));
  params.set('auth_date', String(Math.floor(Date.now() / 1000)));
  params.set('query_id', 'AAEsmoke');
  const dcs = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return params.toString();
}

const rpc = async (name, args) => {
  const r = await fetch(REST + '/rpc/' + name, { method: 'POST', headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
  if (!r.ok) throw new Error('rpc ' + name + ' ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
};
const restGet = async (table, q) => {
  const r = await fetch(REST + '/' + table + '?' + q, { headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } });
  return r.json();
};

function stubServer(handler) { return http.createServer(handler); }
const tgStub = stubServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
    const m = /\/bot[^/]+\/(\w+)$/.exec(req.url || ''); const method = m ? m[1] : '';
    res.setHeader('Content-Type', 'application/json');
    if (method === 'getMe') return res.end(JSON.stringify({ ok: true, result: { id: 9051667903, username: 'VIKING_MINER_BOT', first_name: 'VIKING MINER', is_bot: true } }));
    if (method === 'getChatMember') return res.end(JSON.stringify({ ok: true, result: { status: 'member', user: { id: 1 } } }));
    if (method === 'sendMessage' || method === 'sendPhoto') return res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    return res.end(JSON.stringify({ ok: true, result: true }));
  });
});
const tonStub = stubServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if ((req.url || '').includes('jetton/wallets')) return res.end(JSON.stringify({ jetton_wallets: [] }));
    if ((req.url || '').includes('accounts/')) return res.end(JSON.stringify({ balance: '0', status: 'active', interfaces: ['wallet_v5r1'] }));
    if ((req.url || '').includes('transactions')) return res.end(JSON.stringify({ transactions: [] }));
    return res.end(JSON.stringify({}));
  });
});

const api = async (initData, action, body = {}) => {
  const r = await fetch(`http://127.0.0.1:${APP_PORT}/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData, action, ...body }) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* keep null */ }
  return { status: r.status, json, text };
};

const FIX = 700000777, FRESH = 700000778;
const RAW = '0:' + 'ab'.repeat(32);

(async () => {
  await new Promise((r) => tgStub.listen(TG_PORT, '127.0.0.1', r));
  await new Promise((r) => tonStub.listen(TON_PORT, '127.0.0.1', r));

  // seed fixtures straight into the Supabase-side tables
  const now = Date.now();
  await rpc('bulk_put', { p_table: 'docs', p_rows: [{ path: 'settings/global', data: { ownerOnly: false, adminUsers: [], channel1: 'https://t.me/VIKING_Updates', channel2: 'https://t.me/VIKING_PAYOUT', channel3: 'https://t.me/VikingMiner_Community' } }] });
  await rpc('bulk_put', { p_table: 'players', p_rows: [{ id: String(FIX), data: { id: FIX, userNo: 777, name: 'Fixture', username: 'fixture', avatar: 5, walletVerified: true, walletAddr: RAW, verifiedWallet: RAW, hold: 2600, mined: 1000, lastCollectTime: now - 86400000, lastSyncAt: now, createdAt: now - 86400000, referrals: [], dailyStreak: 0, banned: false } }] });
  await fetch(REST + '/players?id=eq.' + FRESH, { method: 'DELETE', headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } });

  const env = {
    ...process.env,
    BOT_TOKEN, OWNER_ID: '700000001', ALLOWED_ORIGIN: '*',
    DB_BACKEND: 'supabase', SUPABASE_REST_URL: REST, SUPABASE_SERVICE_KEY: KEY,
    TG_API_BASE: `http://127.0.0.1:${TG_PORT}`, TON_API_BASE: `http://127.0.0.1:${TON_PORT}/v3`, TONAPI_BASE: `http://127.0.0.1:${TON_PORT}/tonapi`,
    VERIFY_WATCH_MS: '0', REF_HOLD_WATCH_MS: '0',
  };
  delete env.FIREBASE_DATABASE_URL; delete env.GOOGLE_APPLICATION_CREDENTIALS; delete env.FIREBASE_DATABASE_EMULATOR_HOST;
  const child = spawn(path.join(__dirname, 'node_modules', '.bin', 'functions-framework'), ['--target=collectMining', '--port=' + APP_PORT], { env, cwd: __dirname });
  let bootLog = '';
  child.stdout.on('data', (d) => (bootLog += d));
  child.stderr.on('data', (d) => (bootLog += d));

  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const probe = await fetch(`http://127.0.0.1:${APP_PORT}/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => null);
      if (probe && probe.status === 401) up = true;
    }
    chk('server boots on Supabase alone and answers 401 unauthenticated', up, bootLog.slice(-300));

    const fixUser = { id: FIX, first_name: 'Fixture', username: 'fixture' };
    const st = await api(makeInitData(fixUser), 'state');
    chk('state 200 for fixture', st.status === 200, st.text.slice(0, 200));
    chk('fixture reads back from Supabase (hold 2600, mined 1000)',
      st.json && st.json.player && Number(st.json.player.hold) === 2600 && Number(st.json.player.mined) === 1000,
      st.json && st.json.player && { hold: st.json.player.hold, mined: st.json.player.mined });

    const before = (await restGet('players', 'id=eq.' + FIX + '&select=data'))[0].data;
    const col = await api(makeInitData(fixUser), 'collect');
    chk('collect succeeds', col.status === 200, col.text.slice(0, 200));
    const after = (await restGet('players', 'id=eq.' + FIX + '&select=data'))[0].data;
    chk('collect paid exactly perDay into mined (Supabase row)', Number(after.mined) - Number(before.mined) === 750, { before: before.mined, after: after.mined });
    chk('collect stamped lastCollectTime', Number(after.lastCollectTime) > now - 60000, after.lastCollectTime);

    const col2 = await api(makeInitData(fixUser), 'collect');
    const after2 = (await restGet('players', 'id=eq.' + FIX + '&select=data'))[0].data;
    chk('immediate second collect does not pay twice', Number(after2.mined) === Number(after.mined), { s2: col2.status, mined: after2.mined });

    const freshUser = { id: FRESH, first_name: 'Fresh', username: 'freshy' };
    const st2 = await api(makeInitData(freshUser), 'state');
    chk('fresh user state 200 (ensurePlayer on Supabase)', st2.status === 200, st2.text.slice(0, 200));
    const freshRows = await restGet('players', 'id=eq.' + FRESH + '&select=data');
    chk('fresh player record created with a userNo', freshRows.length === 1 && Number(freshRows[0].data.userNo) > 0, freshRows[0] && freshRows[0].data);

    const task = await api(makeInitData(fixUser), 'task', { n: 1 });
    chk('channel task claim works (stubbed member check)', task.status === 200, task.text.slice(0, 200));
    const afterTask = (await restGet('players', 'id=eq.' + FIX + '&select=data'))[0].data;
    chk('task reward landed in mined', Number(afterTask.mined) === Number(after2.mined) + 50, { mined: afterTask.mined });
  } finally {
    child.kill('SIGTERM');
    tgStub.close(); tonStub.close();
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SMOKE ERROR', e); process.exit(2); });
