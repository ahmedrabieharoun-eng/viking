/* Acceptance tests for the in-bot bio verification flow (BOT_BIO).
 *
 * Same harness as test_local3.js (real RTDB emulator + Telegram stub),
 * focused on the new webhook update path:
 *   T0  the server self-registers the webhook on boot with the derived
 *       secret and allowed_updates ['message', 'callback_query'] (callback_query added by the manual withdrawal-review round, owner order 2026-11-14).
 *   T1  /start bio, bio contains the bot username -> credited once with
 *       cfg.bioReward, bioTaskDone set, success reply sent.
 *   T2  the SAME update delivered twice -> still credited exactly once,
 *       no second reply (update_id dedupe).
 *   T3  /start bio, empty bio -> instruction reply with the deep link,
 *       no credit.
 *   T4  /start bio, bio present without the username -> instruction
 *       reply, no credit.
 *   T5  update posts with a wrong / missing secret header -> 401 and
 *       nothing processed (no player, no messages); the same update
 *       with the right secret then processes normally.
 *   T6  plain /start, bio without username -> ONE welcome message
 *       (banner photo + caption + keyboard) only, no credit,
 *       NO bio nag message.
 *   T7  plain /start, bio WITH username (lowercase — the match is
 *       case-insensitive), not done -> welcome ONLY: no bio message
 *       and NO credit (bioTaskDone stays false; owner order
 *       2026-11-14: bio messages only on explicit request). A second
 *       plain /start is the same. /start bio then grants exactly
 *       once; a second /start bio answers 'already verified'.
 *   T8  /start bio with getChat failing -> 'try again' reply, no
 *       credit; once getChat recovers, the same flow grants.
 *   T9  Telegram rejects the welcome sendPhoto with 400
 *       EMOJI_ID_INVALID -> tg() retries the photo once fully
 *       stripped and the welcome is still delivered as ONE photo
 *       message (no tg-emoji, no button icons, no text fallback).
 *   T10 plain /start is ONE sendPhoto: WELCOME_IMAGE_URL, the
 *       AdVOLT-mirrored welcome as caption (exact text, NO user
 *       name in it), keyboard attached, no separate sendMessage;
 *       🪙 wraps premium inside the caption; the caption's
 *       visible length fits the 1024 limit; users with
 *       language_code ar/ru still receive the ENGLISH caption
 *       (bot language fixed to English, owner order 2026-11-14);
 *       /start bio sends NO photo.
 *   T11 sendPhoto stubbed to fail (non-emoji error) -> the handler
 *       falls back to ONE sendMessage carrying the same welcome
 *       copy + keyboard (the greeting is never lost over the photo).
 *   T12 /emojipack (owner): reply lists both stub sticker IDs, one
 *       getStickerSet call, WANTED 🔥 auto-saved to `premiumEmoji`;
 *       non-owner: silence, no getStickerSet call; unknown pack ->
 *       the Telegram error description is replied.
 *   T13 entity extractor (owner): a plain message carrying a
 *       custom_emoji entity gets an ID reply and auto-saves 🔥;
 *       the same from a non-owner -> silence.
 *   T14 /emojihunt (owner): the stubbed RestrictedEmoji pack's 🔥/⚔️
 *       are saved under both key forms, the reply lists them and the
 *       missing line excludes them; the NEXT welcome caption wraps
 *       ⚔ (its header glyph) with the harvested ID; non-owner:
 *       silence, no getStickerSet call.
 *   T15 write_access_allowed service message (first contact via
 *       the direct app link; no text, no /start): a genuinely NEW
 *       player gets the same single welcome photo as plain /start
 *       (same caption + /app-URL keyboard); an existing player —
 *       created by an earlier write_access_allowed or by /start —
 *       gets total silence.
 *
 * Welcome assertions (T6/T7/T10) cover the owner-approved form
 * (2026-11-14): ONE message — the banner photo with the
 * AdVOLT-mirrored English copy as its caption (bot language fixed
 * to English; NO name line — header / intro / 3 bullets / closing,
 * one sentence per line), parse_mode HTML with premium <tg-emoji>
 * tags, keyboard = 'Open VIKING' alone on row 1 — a plain URL
 * button to https://t.me/<bot>/app (username resolved at runtime;
 * a web_app button renders as a detached bar in Telegram, a URL
 * button stays glued to the message — owner order 2026-11-14) —
 * and news (cfg.channel1) + payouts (cfg.channel2) side by side on
 * row 2 in AdVOLT's order (News | Payments), one-word labels.
 *
 * Run:  node test_local4.js     (ports: app 18088, stub 18089, emu 9000)
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
const APP_PORT = 18088;
const STUB_PORT = 18089;
const NS = 'demo-viking-default-rtdb';
const EMU = `127.0.0.1:${EMU_PORT}`;
const APP_LINK_EXPECTED = 'https://t.me/TestVikingBot/app'; // welcome row 1: URL button to the bot's app link (stub getMe username)
const WELCOME_IMAGE_URL_EXPECTED = 'https://ahmedrabieharoun-eng.github.io/viking/welcome-banner.webp?v=2';
const SECRET = crypto.createHash('sha256').update(BOT_TOKEN).digest('hex').slice(0, 32);

function cleanEnv(extra) {
  const env = { ...process.env };
  for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'NODE_USE_ENV_PROXY']) delete env[k];
  return { ...env, ...extra };
}

/* ---------- Telegram stub: getChat bios + setWebhook capture ---------- */
const sentMessages = [];
const sendAttempts = [];    // EVERY sendMessage body received, incl. rejected ones
const webhookCalls = [];
let failNextSendEmoji = false; // next sendMessage -> 400 EMOJI_ID_INVALID, once
const sentPhotos = [];      // successful sendPhoto bodies
const photoAttempts = [];   // EVERY sendPhoto body received, incl. rejected ones
const callLog = [];         // ordered {method, chat_id} of successful sends (single-message ordering checks)
let failNextPhoto = false;  // next sendPhoto -> ok:false, once
let failNextPhotoEmoji = false; // next sendPhoto -> 400 EMOJI_ID_INVALID, once
const stickerSetCalls = []; // every getStickerSet pack name requested, in order
const stickerSets = {
  TestPack: { title: 'Test Pack', stickers: [
    { emoji: '🔥', custom_emoji_id: '111222333' },
    { emoji: '😀', custom_emoji_id: '444555666' }
  ] },
  RestrictedEmoji: { title: 'Restricted Emoji', stickers: [
    { emoji: '🔥', custom_emoji_id: '777000111' },
    { emoji: '⚔️', custom_emoji_id: '777000222' },
    { emoji: '😀', custom_emoji_id: '777000333' }
  ] }
};
const bios = {};            // chatId (string) -> bio text; absent key = Telegram returns no bio field
const getChatFail = new Set(); // chatIds for which getChat answers ok:false
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch (e) { /* ignore */ }
    const m = /\/bot[^/]+\/(\w+)$/.exec(req.url || '');
    const method = m ? m[1] : '';
    res.setHeader('Content-Type', 'application/json');
    if (method === 'sendMessage') {
      sendAttempts.push(body);
      if (failNextSendEmoji) {
        failNextSendEmoji = false;
        return res.end(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: EMOJI_ID_INVALID' }));
      }
      sentMessages.push(body);
      callLog.push({ method: 'sendMessage', chat_id: String(body.chat_id) });
    }
    if (method === 'sendPhoto') {
      photoAttempts.push(body);
      if (failNextPhotoEmoji) {
        failNextPhotoEmoji = false;
        return res.end(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: EMOJI_ID_INVALID' }));
      }
      if (failNextPhoto) {
        failNextPhoto = false;
        return res.end(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: wrong file identifier' }));
      }
      sentPhotos.push(body);
      callLog.push({ method: 'sendPhoto', chat_id: String(body.chat_id) });
      return res.end(JSON.stringify({ ok: true, result: { message_id: 5000 + sentPhotos.length } }));
    }
    if (method === 'getStickerSet') {
      stickerSetCalls.push(body.name);
      if (stickerSets[body.name]) return res.end(JSON.stringify({ ok: true, result: stickerSets[body.name] }));
      return res.end(JSON.stringify({ ok: false, error_code: 404, description: 'Bad Request: STICKERSET_INVALID' }));
    }
    if (method === 'setWebhook') webhookCalls.push(body);
    if (method === 'getMe') return res.end(JSON.stringify({ ok: true, result: { id: 424242, is_bot: true, first_name: 'Test Viking', username: 'TestVikingBot' } }));
    if (method === 'getChat') {
      const cid = String(body.chat_id);
      if (getChatFail.has(cid)) return res.end(JSON.stringify({ ok: false, error_code: 500, description: 'stub getChat failure' }));
      const result = { id: Number(body.chat_id), type: 'private', first_name: 'Stub User' };
      if (Object.prototype.hasOwnProperty.call(bios, cid)) result.bio = bios[cid];
      return res.end(JSON.stringify({ ok: true, result }));
    }
    return res.end(JSON.stringify({ ok: true, result: { message_id: sentMessages.length } }));
  });
});

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS', name); }
  else { failed++; console.log('  FAIL', name, extra !== undefined ? '-> ' + JSON.stringify(extra) : ''); }
}

async function tgUpdate(update, secretHeader) {
  const headers = { 'Content-Type': 'application/json' };
  if (secretHeader !== undefined) headers['x-telegram-bot-api-secret-token'] = secretHeader;
  const r = await fetch(`http://127.0.0.1:${APP_PORT}/`, {
    method: 'POST', headers, body: JSON.stringify(update)
  });
  let j = null;
  try { j = await r.json(); } catch (e) { /* ignore */ }
  return { status: r.status, body: j };
}
const startUpdate = (updateId, user, text) => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    from: user,
    chat: { id: user.id, type: 'private' },
    date: Math.floor(Date.now() / 1000),
    text
  }
});
const FROM = (id, first_name, username, language_code) => ({ id, is_bot: false, first_name, username, language_code: language_code || 'en' });
const OWNER_USER = FROM(700000001, 'Boss Man', 'bossman'); // matches the OWNER_ID env the server is spawned with
const msgsTo = (id) => sentMessages.filter((m) => String(m.chat_id) === String(id));

async function dbGet(p) {
  const r = await fetch(`http://${EMU}/${p}.json?ns=${NS}`);
  return r.json();
}
async function dbWipe() {
  for (const p of ['players', 'withdrawals', 'settings', 'meta', 'sigs', 'wallets', 'deviceIds', 'devices', 'premiumEmoji']) {
    await fetch(`http://${EMU}/${p}.json?ns=${NS}`, { method: 'DELETE' });
  }
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

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viking-test4-'));
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

    const emuUp = await fetch(`http://${EMU}/.json?ns=${NS}`).then(() => true).catch(() => false);
    if (!emuUp) {
      const emuDir = path.join(tmp, 'emu');
      fs.mkdirSync(emuDir);
      fs.writeFileSync(path.join(emuDir, 'database.rules.json'), JSON.stringify({
        rules: {
          '.read': true, '.write': true,
          players: { '.indexOn': ['lastSeen', 'deviceHash'] },
          withdrawals: { '.indexOn': ['userId', 'wdNum'] }
        }
      }));
      fs.writeFileSync(path.join(emuDir, 'firebase.json'), JSON.stringify({
        database: { rules: 'database.rules.json' },
        emulators: { database: { host: '127.0.0.1', port: EMU_PORT }, ui: { enabled: false }, singleProjectMode: true }
      }));
      const emuLog = path.join(tmp, 'emulator.log');
      const logFd = fs.openSync(emuLog, 'a');
      const fb = spawn(process.env.FIREBASE_BIN || 'firebase', ['emulators:start', '--only', 'database', '--project', 'demo-viking'],
        { cwd: emuDir, env: cleanEnv({}), stdio: ['ignore', logFd, logFd] });
      children.push(fb);
      try {
        await waitFor(async () => { await fetch(`http://${EMU}/.json?ns=${NS}`); return true; }, 90000, 'RTDB emulator');
      } catch (e) {
        console.error('--- emulator log tail ---\n' + fs.readFileSync(emuLog, 'utf8').split('\n').slice(-25).join('\n'));
        throw e;
      }
    }
    await dbWipe();

    await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));

    const srv = spawn(path.join(__dirname, 'node_modules', '.bin', 'functions-framework'),
      ['--target=collectMining', '--port=' + APP_PORT], {
        cwd: __dirname,
        env: cleanEnv({
          BOT_TOKEN, OWNER_ID, ALLOWED_ORIGIN: '*',
          FIREBASE_DATABASE_URL: `http://${EMU}?ns=${NS}`,
          FIREBASE_DATABASE_EMULATOR_HOST: EMU,
          GOOGLE_APPLICATION_CREDENTIALS: saPath,
          TG_API_BASE: `http://127.0.0.1:${STUB_PORT}`
        }),
        stdio: 'ignore'
      });
    children.push(srv);
    await waitFor(async () => (await fetch(`http://127.0.0.1:${APP_PORT}/`)).status === 405, 30000, 'server');

    /* ---------------- T0: webhook self-registration ---------------- */
    console.log('\n[T0: setWebhook self-registration on boot]');
    {
      await waitFor(async () => webhookCalls.length >= 1, 15000, 'setWebhook call');
      const w = webhookCalls[0] || {};
      check('webhook url is the default public URL', w.url === 'https://viking-miner-server.onrender.com/', w.url);
      check('secret_token is the first 32 hex chars of sha256(BOT_TOKEN)', w.secret_token === SECRET, w.secret_token);
      check("allowed_updates is ['message', 'callback_query']", JSON.stringify(w.allowed_updates) === JSON.stringify(['message', 'callback_query']), w.allowed_updates);
    }

    /* ---------------- T1: /start bio, matching bio -> grant ---------------- */
    console.log('\n[T1: /start bio with the username in the bio -> granted]');
    let updT1;
    {
      const A = FROM(700002001, 'Bio Ann', 'bioann');
      bios['700002001'] = 'Miner. Follow @TestVikingBot!';
      updT1 = startUpdate(900001, A, '/start bio');
      const r = await tgUpdate(updT1, SECRET);
      check('handler answers 200', r.status === 200, r);
      const p = await dbGet('players/700002001');
      check('player created by the bot flow (ensurePlayer)', !!p && p.name === 'Bio Ann', p && p.name);
      check('credited exactly cfg.bioReward (50)', !!p && Number(p.mined) === 50, p && p.mined);
      check('bioTaskDone set', !!p && p.bioTaskDone === true, p && p.bioTaskDone);
      const ms = msgsTo(700002001);
      check('exactly one reply', ms.length === 1, ms.length);
      check('reply is the success text with +50', !!ms[0] && /Bio verified/.test(ms[0].text || '') && /\+50/.test(ms[0].text || ''), ms[0] && ms[0].text);
    }

    /* ---------------- T2: same update redelivered ---------------- */
    console.log('\n[T2: duplicate delivery of the same update -> no reprocessing]');
    {
      const r = await tgUpdate(updT1, SECRET);
      check('duplicate still answers 200', r.status === 200, r);
      const p = await dbGet('players/700002001');
      check('still credited exactly once', !!p && Number(p.mined) === 50, p && p.mined);
      check('no second reply', msgsTo(700002001).length === 1, msgsTo(700002001).length);
    }

    /* ---------------- T3: /start bio, empty bio ---------------- */
    console.log('\n[T3: /start bio, empty bio -> instructions, no credit]');
    {
      const B = FROM(700002002, 'Bio Bob', 'biobob');
      const r = await tgUpdate(startUpdate(900002, B, '/start bio'), SECRET);
      check('handler answers 200', r.status === 200, r);
      const p = await dbGet('players/700002002');
      check('player exists but mined 0 and bioTaskDone unset', !!p && Number(p.mined || 0) === 0 && p.bioTaskDone !== true, p);
      const ms = msgsTo(700002002);
      check('exactly one reply', ms.length === 1, ms.length);
      check('reply carries the add-bio + deep-link instructions',
        !!ms[0] && /@TestVikingBot/.test(ms[0].text || '') && /https:\/\/t\.me\/TestVikingBot\?start=bio/.test(ms[0].text || ''), ms[0] && ms[0].text);
    }

    /* ---------------- T4: /start bio, bio without username ---------------- */
    console.log('\n[T4: /start bio, bio present without the username -> instructions, no credit]');
    {
      const C = FROM(700002003, 'Bio Cy', 'biocy');
      bios['700002003'] = 'just a normal bio, nothing here';
      const r = await tgUpdate(startUpdate(900003, C, '/start bio'), SECRET);
      check('handler answers 200', r.status === 200, r);
      const p = await dbGet('players/700002003');
      check('no credit', !!p && Number(p.mined || 0) === 0 && p.bioTaskDone !== true, p);
      const ms = msgsTo(700002003);
      check('instruction reply sent', ms.length === 1 && /start=bio/.test(ms[0].text || ''), ms.map((x) => x.text));
    }

    /* ---------------- T5: webhook secret enforcement ---------------- */
    console.log('\n[T5: wrong / missing secret header -> 401, nothing processed]');
    {
      const D = FROM(700002004, 'Bio Dan', 'biodan');
      bios['700002004'] = '@TestVikingBot';
      const upd = startUpdate(900004, D, '/start bio');
      const rWrong = await tgUpdate(upd, 'deadbeefdeadbeefdeadbeefdeadbeef');
      check('wrong secret -> 401', rWrong.status === 401, rWrong.status);
      const rNone = await tgUpdate(upd, undefined);
      check('missing secret -> 401', rNone.status === 401, rNone.status);
      const p = await dbGet('players/700002004');
      check('no player was created', p === null, p);
      check('no messages were sent', msgsTo(700002004).length === 0, msgsTo(700002004).length);
      const rOk = await tgUpdate(upd, SECRET);
      const p2 = await dbGet('players/700002004');
      check('the same update with the right secret then processes + credits',
        rOk.status === 200 && !!p2 && Number(p2.mined) === 50 && p2.bioTaskDone === true, { status: rOk.status, mined: p2 && p2.mined });
    }

    /* ---------------- T6: plain /start, bio without username ---------------- */
    console.log('\n[T6: plain /start, no bio match -> welcome only, silent about bio]');
    {
      const E = FROM(700002005, 'Bio Eve', 'bioeve');
      bios['700002005'] = 'no username in this bio';
      const r = await tgUpdate(startUpdate(900005, E, '/start'), SECRET);
      check('handler answers 200', r.status === 200, r);
      const phs = sentPhotos.filter((p) => String(p.chat_id) === '700002005');
      check('exactly one send: the welcome photo, no separate text message',
        phs.length === 1 && msgsTo(700002005).length === 0,
        { photos: phs.length, msgs: msgsTo(700002005).length });
      const cap = (phs[0] || {}).caption || '';
      check('caption parse_mode is HTML', !!phs[0] && phs[0].parse_mode === 'HTML', phs[0] && phs[0].parse_mode);
      check('caption carries premium tg-emoji tags', /<tg-emoji emoji-id="/.test(cap), cap.slice(0, 200));
      check('caption carries NO user name (AdVOLT-style copy has no name line)', !cap.includes('Bio Eve'), cap.slice(0, 200));
      check('caption is the AdVOLT-mirrored welcome (header + intro + closing lines)', cap.includes('Welcome to VIKING MINER') && cap.includes('Jump in and start your Viking saga:') && cap.includes('Tap the button below and start mining now!'), cap.slice(0, 200));
      const kb = phs[0] && phs[0].reply_markup && phs[0].reply_markup.inline_keyboard;
      const btn = kb && kb[0] && kb[0][0];
      check('welcome row 1 is a URL button to the bot app link (no web_app button)', !!btn && btn.url === APP_LINK_EXPECTED && !btn.web_app, btn);
      check('keyboard: row 1 is the single Open App button', Array.isArray(kb) && kb.length === 2 && kb[0].length === 1, kb);
      check('keyboard: row 2 = news (cfg.channel1) then payouts (cfg.channel2) — AdVOLT order',
        !!kb && kb.length === 2 && kb[1].length === 2 && kb[1][0].url === 'https://t.me/YGRAM1' && kb[1][1].url === 'https://t.me/telegram',
        kb && kb[1]);
      check('keyboard: at least one button carries a premium icon_custom_emoji_id',
        !!kb && kb.flat().some((b) => b && b.icon_custom_emoji_id), kb);
      const p = await dbGet('players/700002005');
      check('no credit', !!p && Number(p.mined || 0) === 0 && p.bioTaskDone !== true, p);
    }

    /* ---------------- T7: plain /start never touches the bio task ---------------- */
    console.log('\n[T7: plain /start with a matching bio -> welcome only, NO credit; /start bio grants, then already]');
    {
      const F = FROM(700002006, 'Bio Fay', 'biofay');
      bios['700002006'] = 'my bio mentions @testvikingbot in lowercase';
      const r = await tgUpdate(startUpdate(900006, F, '/start'), SECRET);
      check('handler answers 200', r.status === 200, r);
      const phs = sentPhotos.filter((p) => String(p.chat_id) === '700002006');
      const cap = (phs[0] || {}).caption || '';
      check('exactly one send: the welcome photo (keyboard attached), no text message, no bio note',
        phs.length === 1 && !!(phs[0].reply_markup) && msgsTo(700002006).length === 0,
        { photos: phs.length, msgs: msgsTo(700002006).length });
      check('caption has premium emoji tags and NO user name in it',
        !cap.includes('Bio Fay') && /<tg-emoji emoji-id="/.test(cap), cap.slice(0, 200));
      const p = await dbGet('players/700002006');
      check('matching bio NOT credited by a plain /start (bioTaskDone stays false)',
        !!p && Number(p.mined || 0) === 0 && p.bioTaskDone !== true, p && { mined: p.mined, done: p.bioTaskDone });
      const r2 = await tgUpdate(startUpdate(900007, F, '/start'), SECRET);
      const p2 = await dbGet('players/700002006');
      check('second plain /start: welcome photo only again, still no credit, no text messages',
        r2.status === 200 && sentPhotos.filter((x) => String(x.chat_id) === '700002006').length === 2 && msgsTo(700002006).length === 0 && Number(p2.mined || 0) === 0 && p2.bioTaskDone !== true,
        { photos: sentPhotos.filter((x) => String(x.chat_id) === '700002006').length, mined: p2 && p2.mined, done: p2 && p2.bioTaskDone });
      const r3 = await tgUpdate(startUpdate(900011, F, '/start bio'), SECRET);
      const ms3 = msgsTo(700002006);
      const p3 = await dbGet('players/700002006');
      check('/start bio grants the matching bio (case-insensitive match) exactly once',
        r3.status === 200 && ms3.length === 1 && /Bio verified/.test(ms3[0].text || '') && /\+50/.test(ms3[0].text || '') && Number(p3.mined) === 50 && p3.bioTaskDone === true,
        { n: ms3.length, first: ms3[0] && ms3[0].text, mined: p3 && p3.mined });
      const r4 = await tgUpdate(startUpdate(900012, F, '/start bio'), SECRET);
      const ms4 = msgsTo(700002006);
      const p4 = await dbGet('players/700002006');
      check('second /start bio answers already-verified, still one credit',
        r4.status === 200 && ms4.length === 2 && /already verified/.test(ms4[1].text || '') && Number(p4.mined) === 50,
        { n: ms4.length, last: ms4[1] && ms4[1].text, mined: p4 && p4.mined });
    }

    /* ---------------- T8: getChat failure -> retry, then recovery ---------------- */
    console.log('\n[T8: getChat failure -> try-again reply, no credit; recovery grants]');
    {
      const G = FROM(700002007, 'Bio Gil', 'biogil');
      bios['700002007'] = '@TestVikingBot';
      getChatFail.add('700002007');
      const r = await tgUpdate(startUpdate(900008, G, '/start bio'), SECRET);
      check('handler answers 200', r.status === 200, r);
      const ms = msgsTo(700002007);
      check('try-again reply sent', ms.length === 1 && /try again in a minute/.test(ms[0].text || ''), ms.map((x) => x.text));
      const p = await dbGet('players/700002007');
      check('no credit while getChat fails', !!p && Number(p.mined || 0) === 0 && p.bioTaskDone !== true, p);
      getChatFail.delete('700002007');
      const r2 = await tgUpdate(startUpdate(900009, G, '/start bio'), SECRET);
      const p2 = await dbGet('players/700002007');
      check('after recovery the same flow grants', r2.status === 200 && !!p2 && Number(p2.mined) === 50 && p2.bioTaskDone === true, p2 && p2.mined);
    }

    /* ---------------- T9: premium emoji rejected -> stripped photo retry ---------------- */
    console.log('\n[T9: EMOJI_ID_INVALID on the welcome sendPhoto -> one stripped retry, still ONE photo message]');
    {
      const H = FROM(700002008, 'Bio Hal', 'biohal');
      failNextPhotoEmoji = true; // the stub rejects Hal's welcome photo (first send) once
      const r = await tgUpdate(startUpdate(900010, H, '/start'), SECRET);
      check('handler answers 200', r.status === 200, r);
      const attempts = photoAttempts.filter((m) => String(m.chat_id) === '700002008');
      check('photo attempted exactly twice (rejected + retry)', attempts.length === 2, attempts.length);
      check('the rejected first attempt carried premium tg-emoji tags in the caption',
        attempts.length === 2 && /<tg-emoji emoji-id="/.test(attempts[0].caption || ''), attempts[0] && attempts[0].caption);
      const phs = sentPhotos.filter((p) => String(p.chat_id) === '700002008');
      check('welcome still delivered exactly once, as the photo (no text fallback)',
        phs.length === 1 && msgsTo(700002008).length === 0, { photos: phs.length, msgs: msgsTo(700002008).length });
      check('delivered caption has no tg-emoji tags left', !!phs[0] && !/<tg-emoji/.test(phs[0].caption || ''), phs[0] && phs[0].caption);
      check('delivered caption still carries the welcome copy (and no user name)', !!phs[0] && (phs[0].caption || '').includes('Welcome to VIKING MINER') && !(phs[0].caption || '').includes('Bio Hal'), phs[0] && phs[0].caption);
      const kb = phs[0] && phs[0].reply_markup && phs[0].reply_markup.inline_keyboard;
      check('delivered keyboard has no premium icons left',
        !!kb && !kb.flat().some((b) => b && b.icon_custom_emoji_id), kb);
    }

    /* ---------------- T10: ONE welcome message (photo + caption + keyboard) ---------------- */
    console.log('\n[T10: plain /start is ONE sendPhoto with the AdVOLT-mirrored caption (exact text, no name) + keyboard; premium wraps in caption; length; fixed English]');
    {
      const logBase = callLog.length;
      const P1 = FROM(700002010, 'Photo Pam', 'photopam');
      bios['700002010'] = 'no bot mention here';
      const r = await tgUpdate(startUpdate(900020, P1, '/start'), SECRET);
      check('handler answers 200', r.status === 200, r);
      const log = callLog.slice(logBase).filter((e) => e.chat_id === '700002010');
      check('exactly ONE successful send: the photo (no separate welcome message)',
        log.length === 1 && log[0].method === 'sendPhoto' && msgsTo(700002010).length === 0,
        { log, msgs: msgsTo(700002010).length });
      const ph = sentPhotos.find((p) => String(p.chat_id) === '700002010');
      check('photo is WELCOME_IMAGE_URL', !!ph && ph.photo === WELCOME_IMAGE_URL_EXPECTED, ph && ph.photo);
      const cap = (ph || {}).caption || '';
      // Exact copy check: pz() wraps glyphs in <tg-emoji> tags but keeps
      // the wrapped char itself for every glyph in this copy (🪙/🚀 are
      // direct-id maps; ⚔/⛏/😀 unmapped pre-hunt), so stripping the tags
      // restores the plain text byte-for-byte. FE0F is normalized out on
      // both sides — variation selectors are a presentation detail.
      const EXPECTED_WELCOME = '⚔️ Welcome to VIKING MINER! ⚔️\n\nJump in and start your Viking saga:\n⛏ Mine VIKING daily and climb from level 1 to 100.\n🪙 Crush tasks & seize loot to fill your vaults.\n😀 Invite friends, earn 5% of their mining!\n\nTap the button below and start mining now! 🚀';
      const visText = (s) => s.replace(/<[^>]+>/g, '').replace(/️/g, '');
      check('caption is EXACTLY the AdVOLT-mirrored welcome, no user name in it',
        visText(cap) === visText(EXPECTED_WELCOME) && !cap.includes('Photo Pam'), cap.slice(0, 300));
      const kb = ph && ph.reply_markup && ph.reply_markup.inline_keyboard;
      check('keyboard attached to the photo: row 1 Open App (URL button to t.me/<bot>/app, no web_app), row 2 news + payouts',
        !!kb && kb.length === 2 && kb[0].length === 1 && kb[0][0].url === APP_LINK_EXPECTED && !kb[0][0].web_app && kb[1].length === 2 && kb[1][0].url === 'https://t.me/YGRAM1' && kb[1][1].url === 'https://t.me/telegram',
        kb);
      check('caption wraps the coin glyph premium (🪙 map id)',
        cap.includes('<tg-emoji emoji-id="5382164415019768638">🪙</tg-emoji>'), cap.slice(0, 300));
      check('welcome button labels mirror AdVOLT word counts (Open VIKING / News / Payouts, no "Channel")',
        !!kb && (kb[0][0].text || '').includes('Open VIKING') && (kb[1][0].text || '').includes('News') && !(kb[1][0].text || '').includes('Channel') && (kb[1][1].text || '').includes('Payouts') && !(kb[1][1].text || '').includes('Channel'),
        kb);
      // Caption limit: the visible caption text (HTML tags stripped)
      // must fit Telegram's 1024-char limit. The copy no longer embeds
      // the first name, so the length is the same for every user; the
      // long-name user is still exercised end-to-end.
      const LONG = FROM(700002017, 'Abo Rabie The Great Viking Conqueror Of The Frozen North', 'longname');
      const rl = await tgUpdate(startUpdate(900023, LONG, '/start'), SECRET);
      const lph = sentPhotos.find((p) => String(p.chat_id) === '700002017');
      const lvis = ((lph || {}).caption || '').replace(/<[^>]+>/g, '').length;
      check('caption visible length ≤ 1024 (name-free copy)',
        rl.status === 200 && !!lph && lvis <= 1024, { len: lvis });
      // Bot language fixed to English (owner order 2026-11-14): users
      // whose Telegram language is ar/ru still get the ENGLISH caption.
      const ARU = FROM(700002018, 'Lang Layla', 'langlayla', 'ar');
      await tgUpdate(startUpdate(900024, ARU, '/start'), SECRET);
      const acap = (sentPhotos.find((p) => String(p.chat_id) === '700002018') || {}).caption || '';
      check("language_code 'ar' still gets the ENGLISH welcome caption",
        acap.includes('Welcome to VIKING MINER') && acap.includes('Jump in and start your Viking saga:') && !acap.includes('أيها المحارب') && !acap.includes('Lang Layla'), acap.slice(0, 200));
      const RUU = FROM(700002019, 'Lang Lev', 'langlev', 'ru');
      await tgUpdate(startUpdate(900025, RUU, '/start'), SECRET);
      const rcap = (sentPhotos.find((p) => String(p.chat_id) === '700002019') || {}).caption || '';
      check("language_code 'ru' still gets the ENGLISH welcome caption",
        rcap.includes('Welcome to VIKING MINER') && rcap.includes('Jump in and start your Viking saga:') && !rcap.includes('СТОЙ') && !rcap.includes('Lang Lev'), rcap.slice(0, 200));
      const P2 = FROM(700002011, 'Photo Pia', 'photopia');
      const r2 = await tgUpdate(startUpdate(900021, P2, '/start bio'), SECRET);
      check('bio /start answers 200 and sends NO photo',
        r2.status === 200 && !sentPhotos.some((p) => String(p.chat_id) === '700002011') && msgsTo(700002011).length === 1,
        { photos: sentPhotos.length, msgs: msgsTo(700002011).length });
    }

    /* ---------------- T11: photo failure -> text fallback ---------------- */
    console.log('\n[T11: sendPhoto fails (non-emoji error) -> ONE fallback sendMessage with the same welcome copy + keyboard]');
    {
      const P3 = FROM(700002012, 'Photo Rex', 'photorex');
      failNextPhoto = true;
      const r = await tgUpdate(startUpdate(900022, P3, '/start'), SECRET);
      check('handler answers 200', r.status === 200, r);
      check('photo was attempted once for Rex',
        photoAttempts.filter((p) => String(p.chat_id) === '700002012').length === 1, photoAttempts.length);
      check('no photo recorded as sent for Rex',
        !sentPhotos.some((p) => String(p.chat_id) === '700002012'), sentPhotos.length);
      const ms = msgsTo(700002012);
      check('fallback text delivered once: same welcome copy + keyboard',
        ms.length === 1 && (ms[0].text || '').includes('Welcome to VIKING MINER') && (ms[0].text || '').includes('Tap the button below and start mining now!') && !!(ms[0].reply_markup && ms[0].reply_markup.inline_keyboard),
        ms.map((x) => x.text));
    }

    /* ---------------- T12: /emojipack (owner only) + auto-save ---------------- */
    console.log('\n[T12: /emojipack lists sticker IDs for the owner, silent for others, auto-saves WANTED]');
    {
      const ownerBase = msgsTo(700000001).length;
      const callsBase = stickerSetCalls.length;
      const r = await tgUpdate(startUpdate(900030, OWNER_USER, '/emojipack TestPack'), SECRET);
      check('handler answers 200', r.status === 200, r);
      const reply = msgsTo(700000001).slice(ownerBase)[0] || {};
      check('reply lists both sticker IDs', /111222333/.test(reply.text || '') && /444555666/.test(reply.text || ''), reply.text);
      check('getStickerSet called once, for TestPack',
        stickerSetCalls.length === callsBase + 1 && stickerSetCalls[stickerSetCalls.length - 1] === 'TestPack', stickerSetCalls);
      const node = await dbGet('premiumEmoji');
      check('WANTED fire glyph auto-saved (bare + FE0F key forms)',
        !!node && node['🔥'] === '111222333' && node['🔥️'] === '111222333', node);
      const Q = FROM(700002013, 'Sneaky Sam', 'sneakysam');
      await tgUpdate(startUpdate(900031, Q, '/emojipack TestPack'), SECRET);
      check('non-owner /emojipack: no reply', msgsTo(700002013).length === 0, msgsTo(700002013).length);
      check('non-owner /emojipack: no getStickerSet call', stickerSetCalls.length === callsBase + 1, stickerSetCalls.length);
      const ownerBase2 = msgsTo(700000001).length;
      await tgUpdate(startUpdate(900032, OWNER_USER, '/emojipack NoSuchPack'), SECRET);
      const errReply = msgsTo(700000001).slice(ownerBase2)[0] || {};
      check('unknown pack -> the Telegram error description is replied',
        /STICKERSET_INVALID/.test(errReply.text || ''), errReply.text);
    }

    /* ---------------- T13: entity extractor (owner only) + auto-save ---------------- */
    console.log('\n[T13: owner message with a custom-emoji entity -> ID reply + auto-save; non-owner -> silence]');
    {
      const mkEnt = (updateId, user, gid) => ({
        update_id: updateId,
        message: {
          message_id: updateId, from: user, chat: { id: user.id, type: 'private' },
          date: Math.floor(Date.now() / 1000),
          text: 'check 🔥 this',
          entities: [{ type: 'custom_emoji', offset: 6, length: 2, custom_emoji_id: gid }]
        }
      });
      const ownerBase = msgsTo(700000001).length;
      const r = await tgUpdate(mkEnt(900040, OWNER_USER, '999888777'), SECRET);
      check('handler answers 200', r.status === 200, r);
      const reply = msgsTo(700000001).slice(ownerBase)[0] || {};
      check('reply lists the custom emoji ID next to its glyph',
        /999888777/.test(reply.text || '') && (reply.text || '').includes('🔥'), reply.text);
      const node = await dbGet('premiumEmoji');
      check('extractor auto-saved the fire glyph (both key forms)',
        !!node && node['🔥'] === '999888777' && node['🔥️'] === '999888777', node);
      const Q2 = FROM(700002015, 'Quiet Quinn', 'quietquinn');
      await tgUpdate(mkEnt(900041, Q2, '999888777'), SECRET);
      check('non-owner entity message: silence', msgsTo(700002015).length === 0, msgsTo(700002015).length);
    }

    /* ---------------- T14: /emojihunt sweeps, persists, feeds pz ---------------- */
    console.log('\n[T14: /emojihunt finds + saves wanted glyphs; the next welcome caption renders the swords glyph premium]');
    {
      const ownerBase = msgsTo(700000001).length;
      const callsBase = stickerSetCalls.length;
      const r = await tgUpdate(startUpdate(900050, OWNER_USER, '/emojihunt'), SECRET);
      check('handler answers 200', r.status === 200, r);
      check('getStickerSet called for RestrictedEmoji',
        stickerSetCalls.length === callsBase + 1 && stickerSetCalls[stickerSetCalls.length - 1] === 'RestrictedEmoji', stickerSetCalls);
      const reply = msgsTo(700000001).slice(ownerBase)[0] || {};
      check('reply lists the found fire and swords IDs', /777000111/.test(reply.text || '') && /777000222/.test(reply.text || ''), reply.text);
      const missLine = (reply.text || '').split('\n').find((l) => l.includes('Still missing')) || '';
      check('missing line excludes the found glyphs (but still lists the shield)',
        !!missLine && !missLine.includes('🔥') && !missLine.includes('⚔') && missLine.includes('🛡'), missLine);
      const node = await dbGet('premiumEmoji');
      check('hunt saved the fire glyph under both key forms',
        !!node && node['🔥'] === '777000111' && node['🔥️'] === '777000111', node);
      check('hunt saved the swords glyph under both key forms',
        !!node && node['⚔'] === '777000222' && node['⚔️'] === '777000222', node);
      const P4 = FROM(700002014, 'Hunt Hana', 'hunthana');
      await tgUpdate(startUpdate(900051, P4, '/start'), SECRET);
      const wcap = (sentPhotos.find((p) => String(p.chat_id) === '700002014') || {}).caption || '';
      check('subsequent welcome caption wraps the swords glyph with the harvested ID via pz',
        /<tg-emoji emoji-id="777000222">⚔️?<\/tg-emoji>/.test(wcap), wcap.slice(0, 200));
      const Q3 = FROM(700002016, 'Hunt Igor', 'huntigor');
      await tgUpdate(startUpdate(900052, Q3, '/emojihunt'), SECRET);
      check('non-owner /emojihunt: silence, no getStickerSet call',
        msgsTo(700002016).length === 0 && stickerSetCalls.length === callsBase + 1,
        { msgs: msgsTo(700002016).length, calls: stickerSetCalls.length });
    }

    /* ---------------- T15: write_access_allowed first contact ---------------- */
    console.log('\n[T15: write_access_allowed (direct app link, no /start) -> welcome ONLY for a genuinely new player]');
    {
      const waUpdate = (updateId, user) => ({
        update_id: updateId,
        message: {
          message_id: updateId,
          from: user,
          chat: { id: user.id, type: 'private' },
          date: Math.floor(Date.now() / 1000),
          write_access_allowed: { web_app_name: 'VIKING MINER' }
        }
      });
      // (a) Fresh user, never seen before -> exactly one welcome photo,
      // the same message plain /start sends.
      const W1 = FROM(700002020, 'Link Lia', 'linklia');
      const r1 = await tgUpdate(waUpdate(900060, W1), SECRET);
      check('handler answers 200', r1.status === 200, r1);
      const phs1 = sentPhotos.filter((p) => String(p.chat_id) === '700002020');
      check('fresh user gets exactly ONE welcome photo, no text message',
        phs1.length === 1 && msgsTo(700002020).length === 0,
        { photos: phs1.length, msgs: msgsTo(700002020).length });
      const cap1 = (phs1[0] || {}).caption || '';
      check('welcome caption is the AdVOLT-mirrored copy',
        cap1.includes('Welcome to VIKING MINER') && cap1.includes('Jump in and start your Viking saga:') && cap1.includes('Tap the button below and start mining now!'),
        cap1.slice(0, 200));
      const kb1 = phs1[0] && phs1[0].reply_markup && phs1[0].reply_markup.inline_keyboard;
      check('welcome keyboard: row 1 is the /app URL button, row 2 news + payouts',
        !!kb1 && kb1.length === 2 && kb1[0].length === 1 && kb1[0][0].url === APP_LINK_EXPECTED && !kb1[0][0].web_app && kb1[1].length === 2 && kb1[1][0].url === 'https://t.me/YGRAM1' && kb1[1][1].url === 'https://t.me/telegram',
        kb1);
      const pw1 = await dbGet('players/700002020');
      check('the player was created by the trigger', !!pw1, pw1);
      // (b) The SAME user again — now an existing player: total silence.
      const r2 = await tgUpdate(waUpdate(900061, W1), SECRET);
      check('existing player (created by an earlier write_access_allowed): no photo, no message',
        r2.status === 200 && sentPhotos.filter((p) => String(p.chat_id) === '700002020').length === 1 && msgsTo(700002020).length === 0,
        { photos: sentPhotos.filter((p) => String(p.chat_id) === '700002020').length, msgs: msgsTo(700002020).length });
      // (b2) A player created earlier via /start (Bio Eve in T6) also
      // hears nothing when the service message arrives.
      const E2 = FROM(700002005, 'Bio Eve', 'bioeve');
      const photosBefore = sentPhotos.filter((p) => String(p.chat_id) === '700002005').length;
      const msgsBefore = msgsTo(700002005).length;
      const r3 = await tgUpdate(waUpdate(900062, E2), SECRET);
      check('player created via /start earlier: write_access_allowed sends nothing',
        r3.status === 200 && sentPhotos.filter((p) => String(p.chat_id) === '700002005').length === photosBefore && msgsTo(700002005).length === msgsBefore,
        { photos: sentPhotos.filter((p) => String(p.chat_id) === '700002005').length, msgs: msgsTo(700002005).length });
    }
  } finally {
    stub.close();
    for (const ch of children) { try { ch.kill('SIGKILL'); } catch (e) { /* already dead */ } }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
