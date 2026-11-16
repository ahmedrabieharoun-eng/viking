'use strict';
/* Dual-mode check: boots the REAL server with DB_BACKEND=dual —
   RTDB (emulator) primary, Supabase (local PostgREST) shadow — and
   verifies that committed writes land in BOTH databases.
   Run: SB_KEY_FILE=~/workspace/tools/postgrest/local_service_key.txt node test_sb_dual.js */
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');

const APP_PORT = 18099, TG_PORT = 18100, TON_PORT = 18101;
const BOT_TOKEN = '999:smoke-token';
const NS = 'demo-viking-default-rtdb';
const EMU = '127.0.0.1:9000';
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
  params.set('query_id', 'AAEdual');
  const dcs = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return params.toString();
}

// RTDB emulator REST helpers
const emu = async (method, p, body) => {
  const r = await fetch(`http://${EMU}/${p}.json?ns=${NS}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  try { return JSON.parse(t); } catch (e) { return t; }
};
const pgGet = async (table, q) => {
  const r = await fetch(REST + '/' + table + '?' + q, { headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } });
  return r.json();
};
const pgDel = async (table, q) => {
  await fetch(REST + '/' + table + '?' + q, { method: 'DELETE', headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } });
};

const tgStub = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
    const m = /\/bot[^/]+\/(\w+)$/.exec(req.url || ''); const method = m ? m[1] : '';
    res.setHeader('Content-Type', 'application/json');
    if (method === 'getMe') return res.end(JSON.stringify({ ok: true, result: { id: 9051667903, username: 'VIKING_MINER_BOT', first_name: 'VIKING MINER', is_bot: true } }));
    if (method === 'getChatMember') return res.end(JSON.stringify({ ok: true, result: { status: 'member', user: { id: 1 } } }));
    if (method === 'sendMessage' || method === 'sendPhoto') return res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    return res.end(JSON.stringify({ ok: true, result: true }));
  });
});
const tonStub = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if ((req.url || '').includes('jetton/wallets')) return res.end(JSON.stringify({ jetton_wallets: [] }));
    if ((req.url || '').includes('transactions')) return res.end(JSON.stringify({ transactions: [] }));
    return res.end(JSON.stringify({}));
  });
});

const api = async (initData, action, body = {}) => {
  const r = await fetch(`http://127.0.0.1:${APP_PORT}/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData, action, ...body }) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* ignore */ }
  return { status: r.status, json, text };
};

const FIX = 700000777, FRESH = 700000778;
const RAW = '0:' + 'cd'.repeat(32);

(async () => {
  await new Promise((r) => tgStub.listen(TG_PORT, '127.0.0.1', r));
  await new Promise((r) => tonStub.listen(TON_PORT, '127.0.0.1', r));

  // fake service account for the admin SDK against the emulator
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const saPath = path.join(os.tmpdir(), 'fake-sa-dual.json');
  fs.writeFileSync(saPath, JSON.stringify({
    type: 'service_account', project_id: 'demo-viking', private_key_id: 'fake',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    client_email: 'fake@demo-viking.iam.gserviceaccount.com', client_id: '1',
    token_uri: 'https://oauth2.googleapis.com/token',
  }));

  // wipe both sides
  await emu('DELETE', '');
  await pgDel('players', 'id=eq.' + FIX); await pgDel('players', 'id=eq.' + FRESH);
  await pgDel('docs', 'path=eq.meta%2Fcounters');

  const now = Date.now();
  await emu('PUT', 'players/' + FIX, { id: FIX, userNo: 777, name: 'Fixture', username: 'fixture', avatar: 5, walletVerified: true, walletAddr: RAW, verifiedWallet: RAW, hold: 2600, mined: 1000, lastCollectTime: now - 86400000, lastSyncAt: now, createdAt: now - 86400000, referrals: [], dailyStreak: 0, banned: false });
  await emu('PUT', 'settings/global', { ownerOnly: false, adminUsers: [] });

  const env = {
    ...process.env,
    BOT_TOKEN, OWNER_ID: '700000001', ALLOWED_ORIGIN: '*',
    DB_BACKEND: 'dual', SUPABASE_REST_URL: REST, SUPABASE_SERVICE_KEY: KEY,
    FIREBASE_DATABASE_URL: `https://${NS}.firebaseio.com`, FIREBASE_DATABASE_EMULATOR_HOST: EMU,
    GOOGLE_APPLICATION_CREDENTIALS: saPath,
    TG_API_BASE: `http://127.0.0.1:${TG_PORT}`, TON_API_BASE: `http://127.0.0.1:${TON_PORT}/v3`, TONAPI_BASE: `http://127.0.0.1:${TON_PORT}/tonapi`,
    VERIFY_WATCH_MS: '0', REF_HOLD_WATCH_MS: '0',
  };
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
    chk('dual server boots (RTDB emulator + Supabase shadow)', up, bootLog.slice(-300));

    const fixUser = { id: FIX, first_name: 'Fixture', username: 'fixture' };
    const st = await api(makeInitData(fixUser), 'state');
    chk('state reads from RTDB primary', st.status === 200 && st.json && st.json.player && Number(st.json.player.mined) === 1000, st.text.slice(0, 160));

    const col = await api(makeInitData(fixUser), 'collect');
    chk('collect succeeds in dual mode', col.status === 200, col.text.slice(0, 160));
    const rtdbAfter = await emu('GET', 'players/' + FIX);
    chk('RTDB has the payout (mined 1750)', Number(rtdbAfter.mined) === 1750, rtdbAfter && rtdbAfter.mined);
    const pgRows = await pgGet('players', 'id=eq.' + FIX + '&select=data');
    chk('Supabase shadow received the same committed record', pgRows.length === 1 && Number(pgRows[0].data.mined) === 1750, pgRows[0] && pgRows[0].data && pgRows[0].data.mined);

    const task = await api(makeInitData(fixUser), 'task', { n: 1 });
    chk('task claim succeeds', task.status === 200, task.text.slice(0, 160));
    const pgRows2 = await pgGet('players', 'id=eq.' + FIX + '&select=data');
    chk('shadow tracked the task write too', pgRows2.length === 1 && pgRows2[0].data.task1Done === true && Number(pgRows2[0].data.mined) === 1800, pgRows2[0] && pgRows2[0].data && { t: pgRows2[0].data.task1Done, m: pgRows2[0].data.mined });

    const freshUser = { id: FRESH, first_name: 'Fresh', username: 'freshy' };
    const st2 = await api(makeInitData(freshUser), 'state');
    chk('fresh user created via dual writes', st2.status === 200, st2.text.slice(0, 160));
    const pgFresh = await pgGet('players', 'id=eq.' + FRESH + '&select=data');
    chk('fresh player exists in the shadow with a userNo', pgFresh.length === 1 && Number(pgFresh[0].data.userNo) > 0, pgFresh[0] && pgFresh[0].data);
    const pgCounters = await pgGet('docs', 'path=eq.meta%2Fcounters&select=data');
    chk('meta/counters mirrored', pgCounters.length === 1 && Number(pgCounters[0].data.users) >= 1, pgCounters[0] && pgCounters[0].data);
  } finally {
    child.kill('SIGTERM');
    tgStub.close(); tonStub.close();
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('DUAL ERROR', e); process.exit(2); });
