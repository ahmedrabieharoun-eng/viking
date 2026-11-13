# VIKING MINER server — Firestore → Realtime Database port notes

Same API contract, same game logic, same defaults, same rate limiting, same
Telegram initData verification, same 14 actions. **Only the persistence layer
changed.** Hosting is unchanged: `functions.http('collectMining', ...)` with
start command `functions-framework --target=collectMining`.

## Environment

| Var | Purpose |
|---|---|
| `BOT_TOKEN`, `OWNER_ID`, `ALLOWED_ORIGIN`, `TONAPI_KEY`, `SIG_SECRET` | unchanged from the Firestore version |
| `FIREBASE_DATABASE_URL` | **new** — the RTDB URL, e.g. `https://<project>-default-rtdb.firebaseio.com` |
| `GOOGLE_APPLICATION_CREDENTIALS` | path to the service-account JSON file (same as before) |

The Admin SDK is initialised **lazily** on the first DB access
(`admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL })`).
If `FIREBASE_DATABASE_URL` is missing or init fails, the first DB access throws
`500 {"error":"Server not configured"}` — but boot, CORS, the rate limiter and
initData verification run without the DB, exactly like the original: a POST
with an invalid `initData` still returns `401 {"error":"Unauthorized"}` without
touching the database.

## Node mapping (same names as the Firestore collections)

| Firestore | RTDB |
|---|---|
| `players/{uid}` doc | `players/{uid}` node |
| `wallets/{raw with ':'→'_'}` doc | `wallets/{key}` node |
| `sigs/{key with '/'→'_'}` doc (`users` array) | `sigs/{key}` node (`users` array) |
| `settings/global` doc | `settings/global` node |
| `meta/counters` doc (`withdrawals` count) | `meta/counters` node |
| `withdrawals/{wd_N}` doc | `withdrawals/{wd_N}` node |

Reads: `.get()` + `.data()`/`.exists` → `ref.once('value')` + `.val()`
(`null` = missing), via the `getVal()` helper.

Writes: `FieldValue.increment(n)` inside a transaction → computed in the
transaction function as `(Number(cur.field) || 0) + n`; where no read is needed
(`adminAdjust`, the `adminWd` reject refund) →
`admin.database.ServerValue.increment(n)` in an `update()`.
`FieldValue.delete()` (`adminSettings` botToken) → `botToken: null` in an
`update()` (null deletes the child in RTDB).
`FieldValue.arrayUnion(x)` → see per-action notes below.

## Transaction strategy

Firestore's `db.runTransaction` spans multiple documents. RTDB transactions
span exactly one node, so every action was restructured as:

1. pre-read any *other* nodes the logic needs,
2. run the balance-critical mutation as a `ref.transaction()` on the node that
   owns it — all the original in-transaction guards live in the transaction
   function and abort with the same `Fail` status/message (via the `txUpdate`
   helper: `{value}` commits, `{skip}` aborts silently, `{error}` aborts and
   throws that Fail),
3. apply secondary writes afterwards (plain writes / further transactions /
   one atomic multi-path `update()` where possible).

### Per action

- **state** — Exists path: plain read + throttled `update()` (same fields).
  Create path: player create-if-absent is a transaction on `players/{uid}`;
  the inviter's referral append is a *second* transaction on the inviter node,
  deduplicated by referral `id` (the Firestore `arrayUnion` only deduplicated
  an exactly-equal object — including its `at` timestamp — so in practice it
  almost never deduplicated; the RTDB version deduplicates by user id, which
  is stricter and prevents double entries if the two steps race/retries).
  Tail reads: player `once('value')`; withdrawals via
  `orderByChild('userId').equalTo(uid).limitToFirst(50)`.
- **collect** — Player credit (guards: 404/403/10 s wait) is one transaction.
  The inviter commission (pendingRefComm + that referral's `profit`) was in
  the same Firestore transaction; here it is a second transaction immediately
  after, skipped if the inviter is missing/banned — identical outcomes except
  atomicity (below).
- **daily / ad / task / refCollect** — Single-node (player) in both versions;
  one transaction each, all guards and return values unchanged. `task`'s
  channel-membership check still happens before the transaction, as before.
- **wallet** — Pre-reads and the TON API calls are unchanged. The ownership
  check moved to a transaction on the wallet node itself (claim-if-free;
  aborts 400 if owned by someone else) *before* the player transaction,
  mirroring the original "check inside the tx before any write" effect. The
  player update (walletAddr/hold/lastSyncAt/refBonusPaid) is a transaction;
  the old wallet node's delete and the inviter's "Verified ✅" referral update
  follow as separate writes. The inviter update keeps the original condition
  verbatim (`inviter.deviceHash !== player.deviceHash`, raw values).
- **unlink** — Player transaction captures the old wallet address; the wallet
  node is deleted right after.
- **withdraw** — Three steps instead of one transaction: (1) player
  transaction with *all* guards (banned 403, wallet-changed 409, 24 h limit
  429, insufficient balance 400) that deducts the amount; (2) `meta/counters`
  transaction increment — this is still the single serialisation point for
  `wdNum`, so numbers cannot collide; (3) `set()` of `withdrawals/wd_{num}`.
  The on-chain hold re-check, fee math, admin message and risk report are
  unchanged. (A player doc vanishing between the pre-check and step 1 yields
  the original's generic 500, as the Firestore code dereferenced the missing
  doc's data.)
- **adminState** — `players`: `orderByChild('lastSeen').limitToLast(300)`;
  `withdrawals`: `orderByChild('wdNum').limitToLast(200)`; both sorted desc
  in code to match Firestore's `orderBy(..., 'desc')`. Withdrawals keep their
  `docId` (the node key). Pending-withdrawal risk enrichment unchanged.
- **adminBan / adminAdjust** — Firestore `.update()` *fails* on a missing doc
  (→ 500 via the handler); RTDB `update()` would silently create a stub node.
  Both actions therefore pre-read and reproduce the original 500 on a missing
  player. `adminAdjust` then uses `ServerValue.increment`.
- **adminWd** — The status flip (Pending guard included) is one transaction
  on the withdrawal node, so double-processing is still impossible. On reject,
  the refund (`ServerValue.increment(amt)` on the player) is applied
  immediately after the flip (the original did both atomically). The payout
  channel message is unchanged.
- **adminSettings** — Same key validation; `update()` on `settings/global`
  with `botToken: null` deleting any stored token. Config cache invalidation
  unchanged.
- **getConfig** — `settings/global` read; `{...DEFAULTS, ...stored}`, with
  `botToken` stripped, 20 s cache — unchanged.
- **noteSignals** — The Firestore write batch (player `sigs` arrayUnion +
  per-signal `users` arrayUnion) becomes: read the current arrays, merge in
  code, write all of them in **one atomic multi-path update** at the root.
- **riskOf** — Same reads (player, up to 40 `sigs` nodes, up to 8 linked
  players), same scoring/reasons; only `.get()` → `.val()` changed.

## Where RTDB semantics genuinely differ (honest caveats)

1. **Multi-node atomicity is lost.** Firestore transactions made
   create+referral-append (state), collect+commission (collect),
   deduct+number+record (withdraw), and status-flip+refund (adminWd) atomic.
   In RTDB these are sequential steps. A crash or DB error mid-action can
   leave a partial result the original could not produce, e.g. a withdrawal
   whose balance was deducted but whose `wd_N` record was never written, or a
   rejected withdrawal marked Rejected without the refund landing. Each step
   is individually atomic and the guards make *concurrent* duplicates safe in
   the common cases (player transactions serialise balance changes, the
   counters transaction serialises numbers, the status flip is one
   transaction), but cross-node atomicity does not exist in RTDB.
2. **Transactions are per-node and optimistic.** The `txUpdate` transaction
   function re-runs under contention with the freshest value, so balance
   math is always computed on current data — same guarantee as Firestore for
   the node itself.
3. **nulls and empty arrays are pruned by RTDB.** Firestore stored
   `invitedBy: null` and `referrals: []` explicitly; RTDB deletes
   null/empty children on write, so a freshly created player node simply has
   no `invitedBy`/`referrals` keys until set. All code paths read them with
   `|| []`/truthiness guards, and `publicPlayer()` still emits
   `referrals: []`, so the only observable difference is the *absence* of
   `invitedBy: null` in the `state` response JSON for uninvited players.
4. **Arrays are stored as arrays only while dense.** `referrals` and `sigs`
   are always written back as complete JS arrays, so the Admin SDK returns
   them as arrays. Never edit these nodes by hand in the console into a
   sparse/object form, or `.map`/`.some` call sites would break.
5. **noteSignals merge is read-merge-write.** The multi-path update is atomic
   once sent, but two *concurrent* noteSignals calls for the same signal can
   race (last writer wins on that array). The per-instance `seenSig` cache
   makes this rare in practice (each key is only "fresh" once per instance).
   The Firestore `arrayUnion` was atomic per document.
6. **Query ordering.** Firestore's `where('userId','==',…)` returned docs in
   document-id order; the RTDB equivalent returns them ordered by `userId`
   then key. For a single user's withdrawals the sets are identical; the
   order can differ cosmetically. `adminState` lists are re-sorted in code,
   so they match exactly.
7. **Indexes required.** `database.rules.json` ships locked rules
   (`.read`/`.write` false at the root — the Admin SDK bypasses rules) with
   `.indexOn: ["userId","wdNum"]` on `withdrawals` and `["lastSeen"]` on
   `players`; without those indexes the `orderByChild` queries still work but
   log warnings and scan the whole node.
