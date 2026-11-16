'use strict';
/* Adapter battery for sb_adapter.js against a local PostgREST
   (Supabase-compatible) stack. Run:
     SB_KEY_FILE=~/workspace/tools/postgrest/local_service_key.txt node test_sb_adapter.js
   Exits non-zero on the first failed check category. */
const fs = require('fs');
const { createSbDb } = require('./sb_adapter');

const REST = process.env.SB_REST || 'http://127.0.0.1:3000';
const KEY = fs.readFileSync((process.env.SB_KEY_FILE || '').replace(/^~/, process.env.HOME), 'utf8').trim();
const db = createSbDb(REST, KEY);
const getVal = async (ref) => (await ref.once('value')).val();

let pass = 0, fail = 0;
function chk(name, cond, extra) {
  if (cond) { pass++; console.log('  ok', name); }
  else { fail++; console.log('  FAIL', name, extra === undefined ? '' : JSON.stringify(extra)); }
}
const canon = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
};
const eq = (a, b) => canon(a) === canon(b);

const A = '900000101', B = '900000102', C = '900000103';

(async () => {
  // clean slate (incl. the '111' row left by the stack smoke test)
  for (const id of [A, B, C, '111']) await db.ref('players/' + id).remove();
  await db.ref('withdrawals/wd_900001').remove();
  await db.ref('refRepairQueue/' + A).remove();

  console.log('— doc CRUD + subpaths —');
  await db.ref('players/' + A).set({ name: 'Alpha', mined: 10, sigs: { dev1: true } });
  chk('set/get whole doc', eq(await getVal(db.ref('players/' + A)), { name: 'Alpha', mined: 10, sigs: { dev1: true } }));
  chk('subpath read', eq(await getVal(db.ref('players/' + A + '/sigs')), { dev1: true }));
  chk('missing doc reads null', (await getVal(db.ref('players/' + B))) === null);
  await db.ref('players/' + A).update({ mined: 20, extra: 'x' });
  let v = await getVal(db.ref('players/' + A));
  chk('update merges', v.mined === 20 && v.extra === 'x' && v.name === 'Alpha', v);
  await db.ref('players/' + A).update({ extra: null });
  v = await getVal(db.ref('players/' + A));
  chk('update null deletes key', !('extra' in v), v);
  await db.ref('players/' + A + '/sigs').set({ dev2: true });
  chk('subpath set replaces', eq(await getVal(db.ref('players/' + A + '/sigs')), { dev2: true }));
  await db.ref('players/' + A + '/sigs/dev2').remove();
  chk('subpath remove', eq(await getVal(db.ref('players/' + A + '/sigs')), {}));

  console.log('— ServerValue.increment translation —');
  await db.ref('players/' + A).update({ mined: { '.sv': { increment: 50 } } });
  await db.ref('players/' + A).update({ mined: { '.sv': { increment: 50 } } });
  v = await getVal(db.ref('players/' + A));
  chk('increment accumulates 20+50+50=120', v.mined === 120, v);
  await db.ref('players/' + B).set({ name: 'Beta' });
  await db.ref('players/' + B).update({ mined: { '.sv': { increment: 7 } } });
  chk('increment on missing field starts at 0', (await getVal(db.ref('players/' + B))).mined === 7);

  console.log('— transactions —');
  let res = await db.ref('players/' + C).transaction((cur) => (cur === null ? { made: true, n: 1 } : undefined));
  chk('tx create commits', res.committed === true && eq(await getVal(db.ref('players/' + C)), { made: true, n: 1 }));
  res = await db.ref('players/' + C).transaction(() => undefined);
  chk('tx abort leaves value', res.committed === false && (await getVal(db.ref('players/' + C))).n === 1);
  res = await db.ref('players/' + C).transaction((cur) => cur);
  chk('tx identity commits as no-op', res.committed === true && (await getVal(db.ref('players/' + C))).n === 1);
  await Promise.all(Array.from({ length: 20 }, () =>
    db.ref('players/' + C).transaction((cur) => ({ ...(cur || {}), n: ((cur && cur.n) || 0) + 1 }))));
  chk('20 concurrent tx increments land exactly', (await getVal(db.ref('players/' + C))).n === 21,
    await getVal(db.ref('players/' + C)));

  console.log('— counters via transaction (bumpCounter shape) —');
  await db.ref('meta/counters').remove();
  const bump = () => db.ref('meta/counters').transaction((cur) => {
    const base = (cur && typeof cur === 'object') ? cur : {};
    return { ...base, wd: (Number(base.wd) || 0) + 1 };
  });
  await bump(); await bump(); await bump();
  chk('meta/counters wd=3', (await getVal(db.ref('meta/counters'))).wd === 3);

  console.log('— queries —');
  await db.ref('players/' + A).update({ verifyPendingAt: 5000, walletVerified: false, lastSeen: 100 });
  await db.ref('players/' + B).update({ walletVerified: true, lastSeen: 300 });
  await db.ref('players/' + C).update({ walletVerified: true, lastSeen: 200 });
  let q = await getVal(db.ref('players').orderByChild('verifyPendingAt').startAt(1));
  chk('startAt(verifyPendingAt) finds only pending', q && Object.keys(q).length === 1 && !!q[A], q && Object.keys(q));
  q = await getVal(db.ref('players').orderByChild('walletVerified').equalTo(true));
  chk('equalTo(walletVerified,true) finds B,C', q && eq(Object.keys(q).sort(), [B, C]), q && Object.keys(q));
  q = await getVal(db.ref('players').orderByChild('lastSeen').limitToLast(2));
  chk('limitToLast(lastSeen,2) = B,C', q && eq(Object.keys(q).sort(), [B, C]), q && Object.keys(q));
  q = await getVal(db.ref('players').orderByChild('lastSeen').limitToFirst(1));
  chk('limitToFirst(lastSeen,1) = A', q && eq(Object.keys(q), [A]), q && Object.keys(q));

  console.log('— collections + docs maps —');
  const all = await getVal(db.ref('players'));
  chk('players collection assembles', all && all[A] && all[B] && all[C]);
  await db.ref('wallets/0_abc').set({ uid: A });
  chk('wallets map doc', eq(await getVal(db.ref('wallets/0_abc')), { uid: A }));
  await db.ref('settings/global').set({ ownerOnly: false, taskReward: 50 });
  chk('settings/global leaf read', (await getVal(db.ref('settings/global/ownerOnly'))) === false);
  await db.ref('refRepairQueue/' + A).set({ inv: B, at: 1 });
  const queue = await getVal(db.ref('refRepairQueue'));
  chk('refRepairQueue collection assembles', queue && queue[A] && queue[A].inv === B, queue);
  await db.ref('refRepairQueue/' + A).remove();
  chk('queue entry removed', (await getVal(db.ref('refRepairQueue'))) === null);

  console.log('— withdrawals queries —');
  await db.ref('withdrawals/wd_900001').set({ userId: A, wdNum: 900001, amt: 5000 });
  q = await getVal(db.ref('withdrawals').orderByChild('userId').equalTo(String(A)).limitToFirst(50));
  chk('withdrawals by userId', q && !!q.wd_900001, q && Object.keys(q));
  q = await getVal(db.ref('withdrawals').orderByChild('wdNum').limitToLast(1));
  chk('withdrawals limitToLast(wdNum)', q && !!q.wd_900001, q && Object.keys(q));

  console.log('— root multi-path update —');
  await db.ref().update({
    ['players/' + A + '/flagX']: 'yes',
    ['sigs/devK/users/' + A]: true,
    ['players/' + B + '/name']: null,
  });
  chk('multi set subpath', (await getVal(db.ref('players/' + A))).flagX === 'yes');
  chk('multi set sigs doc', eq(await getVal(db.ref('sigs/devK/users')), { [A]: true }));
  const bNow = await getVal(db.ref('players/' + B));
  chk('multi null deletes the path', bNow && !('name' in bNow) && bNow.walletVerified === true, bNow);

  console.log('— child() refs —');
  await db.ref('players/' + A).child('referrals').set([{ id: B }]);
  chk('child subpath set/get', eq(await getVal(db.ref('players/' + A + '/referrals')), [{ id: B }]));

  // cleanup
  for (const id of [A, B, C]) await db.ref('players/' + id).remove();
  await db.ref('withdrawals/wd_900001').remove();
  await db.ref('sigs/devK').remove();
  await db.ref('wallets/0_abc').remove();

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('BATTERY ERROR', e); process.exit(2); });
