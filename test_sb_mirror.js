/* Unit tests for DualDb mirror retry + idempotency + dual_sb direction.
   No infra: fake in-memory primary/shadow databases.
   Run: node test_sb_mirror.js */
'use strict';
const assert = require('assert');
const { DualDb } = require('./sb_adapter');

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
function getPath(store, path) {
  if (!path) return store.root;
  let cur = store.root;
  for (const s of path.split('/')) { if (cur == null || typeof cur !== 'object') return undefined; cur = cur[s]; }
  return cur;
}
function setPath(store, path, value) {
  if (!path) { store.root = clone(value); return; }
  const segs = path.split('/');
  let cur = store.root;
  for (let i = 0; i < segs.length - 1; i++) { if (cur[segs[i]] == null || typeof cur[segs[i]] !== 'object') cur[segs[i]] = {}; cur = cur[segs[i]]; }
  if (value === undefined) delete cur[segs[segs.length - 1]]; else cur[segs[segs.length - 1]] = clone(value);
}
class FakeRef {
  constructor(db, path) { this._db = db; this._path = path || ''; }
  async set(v) { this._db._mutate(() => setPath(this._db._store, this._path, v)); }
  async update(obj) {
    this._db._mutate(() => {
      for (const k of Object.keys(obj)) {
        const p = this._path ? this._path + '/' + k : k;
        if (obj[k] === null) setPath(this._db._store, p, undefined); else setPath(this._db._store, p, obj[k]);
      }
    });
  }
  async remove() { this._db._mutate(() => setPath(this._db._store, this._path, undefined)); }
  async transaction(fn) {
    let out;
    this._db._mutate(() => {
      const cur = clone(getPath(this._db._store, this._path));
      const next = fn(cur);
      if (next === undefined) { out = { committed: false }; return; }
      setPath(this._db._store, this._path, next);
      out = { committed: true };
    });
    return out;
  }
  async once() { const v = clone(getPath(this._db._store, this._path)); return { val: () => (v === undefined ? null : v), exists: () => v !== undefined }; }
}
class FakeDb {
  constructor() { this._store = { root: {} }; this.failFirst = 0; this.calls = 0; }
  ref(path) { return new FakeRef(this, path); }
  _mutate(fn) { this.calls++; if (this.calls <= this.failFirst) throw new Error('shadow boom'); fn(); }
  get(path) { return clone(getPath(this._store, path)); }
}

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('ok -', name); }
  catch (e) { failed++; console.error('FAIL -', name, '-', e.message); }
}

(async () => {
  await t('flaky shadow (2 fails) is retried and lands, shadowFails stays 0', async () => {
    const primary = new FakeDb(); const shadow = new FakeDb(); shadow.failFirst = 2;
    const dual = new DualDb(primary, shadow);
    await dual.ref('players/1').set({ mined: 10 });
    assert.deepStrictEqual(shadow.get('players/1'), { mined: 10 });
    assert.strictEqual(dual.shadowFails, 0);
    assert.strictEqual(shadow.calls, 3);
  });

  await t('dead shadow never blocks the primary write; failure counted once', async () => {
    const primary = new FakeDb(); const shadow = new FakeDb(); shadow.failFirst = Infinity;
    const dual = new DualDb(primary, shadow);
    await dual.ref('players/2').set({ mined: 5 });
    assert.deepStrictEqual(primary.get('players/2'), { mined: 5 });
    assert.strictEqual(dual.shadowFails, 1);
    assert.strictEqual(shadow.calls, 4); // 1 try + 3 retries
  });

  await t('transaction mirrors are final-value sets: re-applying never duplicates', async () => {
    const primary = new FakeDb(); const shadow = new FakeDb();
    const dual = new DualDb(primary, shadow);
    await dual.ref('players/3').set({ mined: 0 });
    /* The codebase convention (txUpdate identity-abort): the update fn
       returns a NEW object; returning the same reference means abort. */
    const inc = (cur) => { const v = Object.assign({}, cur || { mined: 0 }); v.mined += 50; return v; };
    await dual.ref('players/3').transaction(inc);
    await dual.ref('players/3').transaction(inc);
    assert.strictEqual(primary.get('players/3').mined, 100);
    assert.strictEqual(shadow.get('players/3').mined, 100);
    await shadow.ref('players/3').set({ mined: 100 }); // replay of the same mirror
    assert.strictEqual(shadow.get('players/3').mined, 100);
  });

  await t('update and remove mirror to the shadow', async () => {
    const primary = new FakeDb(); const shadow = new FakeDb();
    const dual = new DualDb(primary, shadow);
    await dual.ref('players/4').set({ a: 1, b: 2 });
    await dual.ref('players/4').update({ b: 3, c: 4 });
    assert.deepStrictEqual(shadow.get('players/4'), { a: 1, b: 3, c: 4 });
    await dual.ref('players/4').remove();
    assert.strictEqual(shadow.get('players/4'), undefined);
  });

  await t('dual_sb direction: reads come from the Supabase-side primary, writes mirror to RTDB-side', async () => {
    const sbSide = new FakeDb(); const rtdbSide = new FakeDb();
    sbSide.ref('players/5').set({ mined: 777 });
    rtdbSide.ref('players/5').set({ mined: 1 });
    const dual = new DualDb(sbSide, rtdbSide);
    const snap = await dual.ref('players/5').once('value');
    assert.strictEqual(snap.val().mined, 777);
    await dual.ref('players/5').update({ mined: 800 });
    assert.strictEqual(rtdbSide.get('players/5').mined, 800);
    assert.strictEqual(dual.shadowFails, 0);
  });

  console.log(`\nTOTAL ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
