# Web CLI — Third Review Fix Plan

> **Target repository:** `nguyenduchoan/web-cli`  
> **Baseline commit:** `4c8801b83ef8a003f1611f5f0cc534586e51d954`  
> **Baseline message:** `fix: implement second review fix plan (phases 1-8)`  
> **Purpose:** fix the remaining correctness/lifecycle issues found after the second-review implementation.
>
> **Implementation status:** Completed locally; validation evidence and limitations are recorded in [`docs/agile/changes/third-review-fix-validation.md`](agile/changes/third-review-fix-validation.md). No deployment or remote CI run is claimed.
>
> **Review amendments (2026-09-21):** Baseline matches the expected SHA. Use the existing `tsx` runner for TypeScript tests. Add real production-hook polling coverage; static source assertions alone are insufficient. Cover re-login while an earlier poll is pending, preserving one request at a time. Push cancellation must begin synchronously at logout/auth expiry, guard every async boundary, attach the foreground listener only after backend success, and clean up FID timeout/listeners on success, failure, and cancellation. Keep these changes within the three lifecycle fixes.
>
> **Implementation guidance:** Follow the phase gates in order, preserve the existing architecture outside these lifecycle fixes, and keep regression assertions tied to real behavior.

---

## 0. EXECUTION RULES — MUST FOLLOW

### 0.1 Scope

Fix exactly these three issues:

1. **P1 — xterm reconnect race**
   - Auto-reconnect of the same session can reset the terminal before a write from the previous socket attempt has drained.
   - A late old `terminal.write()` can therefore complete after the new snapshot reset and contaminate the new terminal state.

2. **P1 — stale polling closures**
   - `SessionPollingScheduler` is created once in `useSessions()`.
   - It captures the first render's `isAuthenticated` and `fetchSessions`.
   - Normal app flow mounts `useSessions()` while unauthenticated, then logs in later.
   - The scheduler can therefore continue using stale unauthenticated behavior and fail to schedule polling after login.

3. **P2 — FCM reload/auth lifecycle**
   - `NotificationSettings` currently treats `localStorage` consent + browser permission as proof that push is registered.
   - Reload/login does not actually refresh backend registration or restore the foreground listener.
   - Two `NotificationSettings` instances can exist at the same time because desktop and mobile session UI are both mounted.
   - Push side effects must have one owner or a shared single-flight lifecycle.

Do **not** expand scope into unrelated refactoring.

---

### 0.2 Baseline validation

Before editing code:

```bash
git status --short
git rev-parse HEAD
npm ci
npm run check
npm test
npm run build
```

Expected baseline SHA:

```text
4c8801b83ef8a003f1611f5f0cc534586e51d954
```

Also inspect the existing CI workflow:

```text
.github/workflows/ci.yml
```

The baseline CI for this SHA previously passed both:

- `Build, Check & Test`
- `Browser Smoke Tests`

Therefore a green existing suite is **not** proof these remaining bugs are fixed. New regression coverage is required.

---

### 0.3 Test evidence rule

For every confirmed baseline bug:

1. Add a regression test that represents the real failure.
2. Demonstrate that the new test fails on the baseline behavior.
3. Apply the fix.
4. Demonstrate the same test passes after the fix.
5. Keep the test in the final suite.

Do not create a fake failing test by importing a helper that does not exist on baseline.

Do not change the assertion merely because implementation is difficult.

---

### 0.4 Ordering rule

Complete phases in this order:

```text
Phase 1: xterm reconnect ordering
Phase 2: polling stale closure
Phase 3: push/FCM lifecycle
Phase 4: final integration validation
```

Do not start Phase 2 until Phase 1 tests pass.

Do not start Phase 3 until Phase 2 tests pass.

---

### 0.5 Required validation log

Create:

```text
docs/agile/changes/third-review-fix-validation.md
```

Record for each phase:

- files changed,
- regression test added,
- baseline failure evidence,
- post-fix pass evidence,
- exact commands executed,
- any limitation that remains.

Do not write `PASS` for a command that was not actually executed.

---

# 1. PHASE 1 — FIX SAME-SESSION RECONNECT XTERM RACE

## 1.1 Problem

Relevant files:

```text
web/src/lib/terminalConnection.ts
web/src/lib/terminalSync.ts
web/src/lib/xtermOperationQueue.ts
server/test/reconnectPolicy.test.ts
server/test/terminalSync.test.ts
```

Current reconnect attempt creation in `terminalConnection.ts` does approximately:

```ts
const attemptQueueGen = this.queue.invalidate();
```

This correctly invalidates queued operations from the old generation.

However, `TerminalSyncController.handleSyncStart()` currently performs:

```ts
this.resetTerminal();
this.resizeTerminal(msg.cols, msg.rows);
```

directly.

These mutations are **outside the shared xterm operation queue**.

`XtermOperationQueue.invalidate()` cannot cancel an operation that already started.

Therefore this ordering is possible:

```text
old socket attempt:
  old terminal.write starts
  old write callback is still pending

old socket closes
new socket attempt starts
queue generation is invalidated

new sync_start arrives
new terminal.reset() runs immediately
new terminal.resize() runs immediately

old terminal.write callback completes later
old terminal content appears after reset

new snapshot continues
```

This violates snapshot isolation.

---

## 1.2 Required behavior

All terminal mutations that can conflict across socket attempts must observe one global order.

For the beginning of a new sync, required order is:

```text
old operation already running
    ↓
old operation drains
    ↓
new reset
    ↓
new resize to snapshot geometry
    ↓
new snapshot chunks
    ↓
sync-complete marker
    ↓
new live output/resize
```

Queued operations from an invalid old generation that have **not started** may be skipped.

An old operation that already started is allowed to finish, but the new snapshot reset must wait behind it.

---

## 1.3 Approved implementation approach

Use the existing shared `XtermOperationQueue`.

Do not introduce sleeps, arbitrary delays, `setTimeout`, or polling.

### Step 1 — change `handleSyncStart()`

File:

```text
web/src/lib/terminalSync.ts
```

Keep synchronous protocol-state initialization:

```text
syncId
baseSeq
expectedChunkIndex
syncEndReceived
syncComplete
isSyncing
role
expectedSeq
liveBacklogBytes
lastGrid
```

But do **not** call `resetTerminal()` / `resizeTerminal()` directly.

Instead:

1. Capture:
   - current generation,
   - current session id,
   - current sync id.

2. Enqueue one operation into `this.queue`.

3. Inside that queued operation:
   - call `isInvalid(...)`;
   - if stale, return without touching xterm;
   - call `resetTerminal()`;
   - call `resizeTerminal(cols, rows)`.

Pseudocode:

```ts
public handleSyncStart(msg: SyncStartMessage): void {
  // existing synchronous state setup

  const currentGen = this.generation;
  const currentSession = this.sessionId;
  const currentSyncId = this.syncId;
  const cols = msg.cols;
  const rows = msg.rows;

  void this.queue.enqueue(currentGen, async () => {
    if (this.isInvalid(currentGen, currentSession, currentSyncId)) {
      return;
    }

    this.resetTerminal();
    this.resizeTerminal(cols, rows);
  });
}
```

Do not call `queue.reset()`.

Do not replace the global queue with a per-attempt queue.

---

### Step 2 — preserve message enqueue order

`handleSnapshotChunk()` already enqueues snapshot writes.

Because WebSocket message callbacks execute in arrival order, the sequence:

```text
handleSyncStart()
handleSnapshotChunk(0)
handleSnapshotChunk(1)
handleSyncEnd()
```

must enqueue operations in the same sequence:

```text
reset+resize
chunk0
chunk1
sync-complete marker
```

Do not await each WebSocket message handler individually.

Do not move snapshot chunks outside the queue.

---

### Step 3 — verify reconnect attempt invalidation remains correct

File:

```text
web/src/lib/terminalConnection.ts
```

Keep per-attempt invalidation.

The new attempt still needs a fresh generation:

```ts
const attemptQueueGen = this.queue.invalidate();
```

Do not remove this.

The purpose is:

- old queued work that never started becomes stale;
- old work already running drains;
- new generation operations wait behind the existing queue chain.

---

## 1.4 Mandatory regression test: RP6 must reproduce the real race

The current `RP6` test is insufficient because it resolves the old write **before** sending attempt 2 `sync_start`.

That ordering hides the bug.

Modify:

```text
server/test/reconnectPolicy.test.ts
```

Test name may remain:

```text
RP6: gap invalidates old attempt, late callbacks cannot affect new socket
```

or add a dedicated test:

```text
RP7: same-session reconnect waits for old xterm write before new reset
```

Dedicated `RP7` is preferred because the assertion is easier to understand.

### Required test sequence

Use a controlled promise. No sleep.

#### Attempt 1

```text
connect socket1
open socket1
send sync_start sync-1
send snapshot_chunk "chunk-old"
old write starts and stays pending
send sync_end
trigger gap / close
schedule reconnect
```

Track xterm operations in an array, for example:

```ts
const events: string[] = [];
```

Callbacks should record:

```text
reset
resize
old-write-start
old-write-end
new-write
```

#### Attempt 2

Run retry timer:

```text
create socket2
open socket2
```

**While the old write is still pending**, send:

```text
sync_start sync-2
```

At this point assert:

```text
the reset for sync-2 has NOT executed yet
```

The exact assertion can use reset count or an event marker.

Example concept:

```ts
const resetCountBeforeNewSync = events.filter((x) => x === "reset").length;

socket2.emit("message", syncStart2);

assert.equal(
  events.filter((x) => x === "reset").length,
  resetCountBeforeNewSync
);
```

Then resolve the old write:

```text
resolve old write
await queue.barrier()
```

Now assert order:

```text
old-write-end
appears before
second reset
```

Then continue attempt 2:

```text
snapshot chunk if desired
sync_end
await queue.barrier()
```

Assert:

```text
new attempt connects normally
reconnect counter resets only after valid sync completion
old socket events cannot affect socket2
```

---

## 1.5 Additional `terminalSync` test

File:

```text
server/test/terminalSync.test.ts
```

Add a direct controller-level ordering test.

Required sequence:

```text
enqueue an artificial old operation into global queue
hold it pending

invalidate queue -> obtain new generation
construct new TerminalSyncController using same queue/new generation

call handleSyncStart()
call handleSnapshotChunk()

assert reset and snapshot write have not executed while old operation is pending

release old operation
await queue.barrier()

assert exact order:
old-end
reset
resize
snapshot
```

This test protects the queue contract independently of `TerminalConnectionSession`.

---

## 1.6 Phase 1 prohibited shortcuts

Do not:

- add `setTimeout`,
- add `sleep`,
- increase reconnect delay,
- immediately call `terminal.reset()` outside the queue,
- call `queue.reset()` because it discards the barrier chain,
- create a separate queue for every reconnect attempt,
- make the RP6/RP7 test resolve the old write before new `sync_start`.

---

## 1.7 Phase 1 gate

Run:

```bash
npm run check
npx tsx --test server/test/terminalSync.test.ts
npx tsx --test server/test/reconnectPolicy.test.ts
npm test
```

Record results before starting Phase 2.

---

# 2. PHASE 2 — FIX STALE POLLING CLOSURES AFTER LOGIN

## 2.1 Problem

Relevant file:

```text
web/src/features/sessions/useSessions.ts
```

Current structure creates the scheduler once:

```ts
const schedulerRef = useRef<SessionPollingScheduler | null>(null);

if (!schedulerRef.current) {
  schedulerRef.current = new SessionPollingScheduler({
    fetchSessions: async () => {
      await fetchSessions();
    },
    hasActiveSession: () => Boolean(stateRef.current.activeSessionId),
    isAuthenticated: () => isAuthenticated
  });
}
```

The object is intentionally persistent.

The callbacks passed into the constructor are also persistent.

`stateRef.current` is safe because the callback reads a mutable ref.

But these values are unsafe:

```text
fetchSessions
isAuthenticated
```

They come from the render in which the scheduler was first constructed.

Normal application flow in `App.tsx` is:

```text
App mounts
auth is undefined
useSessions({ isAuthenticated: false })

later authStatus/login succeeds
App rerenders
useSessions({ isAuthenticated: true })
```

The scheduler object still contains callbacks from the first render.

Consequences can include:

```text
scheduler.start()
scheduler.executeFetch()
old fetchSessions sees unauthenticated state and performs no useful request
scheduleNext() checks old isAuthenticated=false
no 5-second polling timer is scheduled
```

---

## 2.2 Required behavior

The scheduler object may remain stable, but its callbacks must always observe current runtime state.

Required after login:

```text
authenticated false -> true
scheduler starts
immediate session fetch uses current callback/auth state
active session exists
one 5-second poll is scheduled
```

Required after logout:

```text
authenticated true -> false
scheduler stops
timer is cleared
old async completion cannot schedule a new timer
```

Required after re-login:

```text
new auth generation
scheduler uses current auth state and current fetch callback
polling resumes normally
```

---

## 2.3 Approved implementation approach: mutable refs

Do not recreate the scheduler on every render.

Do not add `fetchSessions` directly to the polling effect dependency list in a way that continuously stops/restarts the scheduler.

Use mutable refs.

### Step 1 — add auth ref

Near the existing refs:

```ts
const isAuthenticatedRef = useRef(isAuthenticated);
isAuthenticatedRef.current = isAuthenticated;
```

The scheduler must use:

```ts
isAuthenticated: () => isAuthenticatedRef.current
```

Never:

```ts
isAuthenticated: () => isAuthenticated
```

---

### Step 2 — add latest fetch callback ref

Create a ref with a safe initial function:

```ts
const fetchSessionsRef = useRef<() => Promise<void>>(async () => {});
```

After `fetchSessions` is defined with `useCallback`, update:

```ts
fetchSessionsRef.current = fetchSessions;
```

The scheduler must call:

```ts
fetchSessions: () => fetchSessionsRef.current()
```

Do not let the constructor capture a render-specific `fetchSessions`.

---

### Step 3 — scheduler construction location

It is acceptable to keep:

```ts
const schedulerRef = useRef<SessionPollingScheduler | null>(null);
```

near the top.

However, instantiate the scheduler only after the mutable refs it needs exist.

Recommended wiring:

```ts
const schedulerRef = useRef<SessionPollingScheduler | null>(null);
const isAuthenticatedRef = useRef(isAuthenticated);
const fetchSessionsRef = useRef<() => Promise<void>>(async () => {});

isAuthenticatedRef.current = isAuthenticated;

// define fetchSessions useCallback here

fetchSessionsRef.current = fetchSessions;

if (!schedulerRef.current) {
  schedulerRef.current = new SessionPollingScheduler({
    fetchSessions: () => fetchSessionsRef.current(),
    hasActiveSession: () => Boolean(stateRef.current.activeSessionId),
    isAuthenticated: () => isAuthenticatedRef.current
  });
}
```

The exact position may differ as long as hook ordering remains valid.

Do not put React hooks inside conditional blocks.

Object construction is allowed conditionally; hook calls are not.

---

## 2.4 Verify initial fetch and reactive active-session scheduling

Keep the existing responsibilities:

Authenticated effect:

```text
scheduler.start()
scheduler.executeFetch()
install focus/visibility/online listeners
```

Reactive active-session effect:

```text
scheduler.reconcileActiveSession(hasActiveSession)
```

Expected contracts:

### No active session

```text
successful fetch
activeSession=false
no periodic 5-second timer
```

### Active session appears later

```text
false -> true
reconcileActiveSession(true)
one 5-second timer
```

### Active session disappears

```text
true -> false
periodic timer cancelled immediately unless scheduler is in error-backoff mode
```

### Request fails

```text
1s, 2s, 4s, 8s, 15s backoff + existing jitter behavior
```

Do not break existing explicit fetch behavior.

---

## 2.5 Mandatory regression coverage

Existing scheduler unit tests are not sufficient by themselves because the bug is React wiring.

Add two layers of coverage.

### Test A — scheduler uses mutable runtime getters

File:

```text
server/test/pollingPolicy.test.ts
```

Create variables:

```ts
let authenticated = false;
let fetchVersion = "old";
const calls: string[] = [];
```

Construct scheduler with callbacks that read mutable variables.

Then mutate:

```text
authenticated = true
fetchVersion = "new"
```

Start scheduler and execute fetch.

Assert:

```text
current "new" fetch behavior was used
timer scheduling sees authenticated=true
```

This protects the intended design contract.

---

### Test B — production wiring for `useSessions`

Extend `scripts/smoke-multi-session.cjs`, which CI already runs. Start logged out, log in, create an active session, wait for the UI/network to settle, then assert a sessions GET arrives within the next polling window without any explicit refresh or focus event. Match the actual `/api/web-cli/api/sessions` pathname. Run this assertion before the fix to capture a real baseline failure, then retain it for post-fix validation.

A source-string assertion is optional diagnostic coverage only. It cannot replace the browser test.

### Test C — re-login while an earlier fetch is pending

Use a controlled promise to hold the old fetch. Stop the scheduler, start a new auth generation, and request the initial fetch again. Assert there is still at most one request in flight. After the old request drains, current-generation fetching and the 5-second timer must resume. Logout without re-login must still leave zero timers. Do not reset `isFetching` at `start()` in a way that permits overlapping requests. In `useSessions`, coalesce explicit and scheduled fetches by auth generation and a shared in-flight promise; a stale external fetch must not make the current scheduler return a false success. Cover this with the real-hook `scripts/smoke-polling-lifecycle.cjs` browser fixture.

---

## 2.6 Manual scenario to verify

Run application locally if practical.

Scenario:

```text
1. Open app while logged out.
2. Log in normally.
3. Open/create a running session.
4. Observe network requests for sessions.
5. Confirm periodic refresh continues.
6. Log out.
7. Confirm polling stops.
8. Log in again.
9. Confirm polling resumes.
```

Do not call manual verification a replacement for automated tests.

---

## 2.7 Phase 2 prohibited shortcuts

Do not:

- recreate `SessionPollingScheduler` on every render,
- add an interval in parallel with the scheduler,
- add a second polling owner,
- remove active-session gating,
- make polling run every 5 seconds while logged out,
- suppress the bug by forcing a manual `fetchSessions()` elsewhere.

---

## 2.8 Phase 2 gate

Run:

```bash
npm run check
npx tsx --test server/test/pollingPolicy.test.ts
npm test
npm run build
```

Also run `node scripts/smoke-multi-session.cjs` for the real-hook regression and record results before starting Phase 3.

---

# 3. PHASE 3 — FIX FCM RELOAD / AUTH / MULTI-COMPONENT LIFECYCLE

## 3.1 Problem A — false `registered` state

Relevant file:

```text
web/src/components/NotificationSettings.tsx
```

Current logic effectively does:

```ts
if (hasPushConsent() && Notification.permission === "granted") {
  setPushState("registered");
}
```

This is not sufficient proof of registration.

After page reload:

```text
localStorage consent may still be true
Notification.permission may still be granted
frontend Firebase listener no longer exists
backend/device registration may need refresh
```

The UI can therefore display:

```text
Đã bật
```

while foreground push handling is not restored.

---

## 3.2 Problem B — two `NotificationSettings` instances can be mounted

Relevant file:

```text
web/src/components/SessionManager.tsx
```

`sessionContent` includes:

```tsx
<NotificationSettings ... />
```

The same `sessionContent` is rendered into:

```text
desktop sidebar
mobile dialog
```

The mobile dialog may be hidden by CSS on desktop, but hidden is not the same as unmounted.

Therefore two components can exist at the same time.

Push registration and global Firebase listeners must not be owned independently by each `NotificationSettings`.

---

## 3.3 Required architecture

Use **one authenticated push lifecycle owner**.

Recommended owner:

```text
App
```

`NotificationSettings` must become a view/controller surface, not the owner of mount-time registration lifecycle.

Do not let each settings instance independently:

- fetch registration state,
- refresh backend registration,
- replace the global foreground listener,
- increment a global registration generation.

---

## 3.4 Required files

Expected files to modify:

```text
web/src/App.tsx
web/src/components/SessionManager.tsx
web/src/components/NotificationSettings.tsx
web/src/lib/push.ts
```

It is acceptable to add one focused file:

```text
web/src/features/push/usePushLifecycle.ts
```

or:

```text
web/src/lib/pushLifecycle.ts
```

Do not spread lifecycle logic across many unrelated components.

---

## 3.5 Separate two operations: explicit enable vs silent refresh

This distinction is mandatory.

### Explicit enable

User clicked:

```text
Bật thông báo
```

This operation may call:

```ts
Notification.requestPermission()
```

because the user initiated it.

### Silent authenticated refresh

Executed after reload/login when:

```text
stored consent === true
browser permission === "granted"
FCM config enabled
```

This operation must **not** call:

```ts
Notification.requestPermission()
```

It should restore/refresh existing registration.

---

# 3.6 Implement a refresh function in `push.ts`

Add a function with behavior equivalent to:

```ts
refreshPushRegistration(
  config,
  onForegroundAttention
): Promise<{ state: PushState; error?: string }>
```

Required behavior:

```text
config disabled
  -> unconfigured

environment unsupported
  -> unsupported

permission denied
  -> permission_denied

stored consent false
  -> unregistered

stored consent true + permission not granted
  -> unregistered or permission_denied as appropriate
  -> DO NOT request permission

stored consent true + permission granted
  -> register/refresh Firebase
  -> obtain valid FID
  -> refresh backend device registration
  -> attach exactly one foreground listener
  -> registered only after all required steps succeed
```

Do not set `registered` before backend refresh completes.

---

## 3.7 Async generation guard

The current `push.ts` has global registration generation behavior.

Strengthen it.

Clear the FID timeout and unsubscribe the registration listener on success, failure, timeout, and cancellation. Observe Firebase registration and FID promises together so a delayed/rejected SDK call cannot cause an unhandled rejection. Only attach the foreground listener after backend success, and guard queued foreground callbacks after invalidation.

For every registration/refresh operation:

1. Capture current generation before the first async step.
2. After every significant `await`, check that generation is still current.
3. Before:
   - attaching global listeners,
   - calling backend registration,
   - writing consent,
   - publishing `registered`,
   check generation again.

If logout/unregister invalidates the generation while refresh is pending:

```text
late completion must not restore UI state
late completion must not restore consent
late completion must not attach a foreground listener
```

If a backend request was already sent before logout, it cannot be unsent. Preserve existing server-side revoke/delete behavior; do not claim this client fix resolves every server-side register-versus-revoke race. Cancel the client operation immediately at logout start/auth expiry, before waiting for the logout response. On logout failure restore the authenticated owner appropriately. Ordinary unmount/StrictMode cleanup must not clear consent.

---

## 3.8 Single owner / single-flight requirement

Choose one of these designs:

### Preferred design — App owner

`App` owns push lifecycle state.

It passes the following down to `SessionManager`, then to all `NotificationSettings` instances:

```text
config
pushState
errorMessage
isBusy
enable()
disable()
test()
```

Both desktop and mobile settings render the same state/actions.

Mounting two `NotificationSettings` produces zero duplicate registration side effects.

### Acceptable alternative — shared singleton service

Only use this if keeping the App owner is impractical.

Requirements:

```text
one in-flight registration promise per auth generation
one shared foreground listener
shared state for every consumer
reference-safe subscriptions
one consumer unmount must not cancel another consumer's registration
```

Do not allow two simultaneous component calls to cancel each other by incrementing generation.

---

## 3.9 App owner lifecycle

When authenticated state becomes true:

```text
fetch notification config

if config.enabled is false
  state = unconfigured

else if stored consent false
  state according to browser support/permission
  do not request permission

else if stored consent true and permission granted
  state = registering
  silently refresh registration
  state = registered only after success
```

When authenticated state becomes false:

```text
invalidate pending registration generation
cleanup global foreground listener
cleanup Firebase registered listener
clear shared transient state
do not allow late promise completion to publish registered
```

Be careful:

Current logout behavior intentionally clears push consent.

Preserve the product's existing intended consent semantics unless a test or existing requirement says otherwise.

Do not accidentally request permission during login/reload.

---

## 3.10 Refactor `NotificationSettings`

`NotificationSettings` should no longer decide:

```text
stored consent + granted permission == registered
```

It should receive current lifecycle state from the owner.

It may still render:

```text
unconfigured
unsupported
unregistered
registering
unregistering
registered
permission_denied
register_error
unregister_error
```

Its buttons should call owner actions.

Two mounted components should show the same status.

---

## 3.11 Mandatory FCM lifecycle tests

Do not require live Firebase network access for unit tests.

Create testable lifecycle seams / dependency injection where needed.

Suggested file:

```text
server/test/pushLifecycle.test.ts
```

### F3.1 — reload with existing consent

Initial:

```text
consent=true
permission=granted
config enabled
```

Owner starts.

Assert:

```text
silent refresh called
Notification.requestPermission NOT called
backend registration refresh called once
foreground listener attached once
state becomes registered only after success
```

This test must fail against the old production behavior because old code only sets local UI state. A test that imports a new helper absent from baseline is not baseline evidence: use the existing App/NotificationSettings path with mocked Firebase/browser/backend dependencies, or execute the same regression against an isolated baseline fixture. No live Firebase credentials are required.

---

### F3.2 — two settings consumers

Simulate two consumers mounted while registration is pending.

Assert:

```text
one registration operation
one backend request
one foreground listener
both consumers see registering
both consumers see registered after success
```

Unmount one consumer while pending.

Assert:

```text
registration continues for remaining owner/consumer
global listener is not removed
```

---

### F3.3 — logout during pending refresh

Use a controlled promise.

Sequence:

```text
start silent refresh
pause during async registration
logout / invalidate auth generation
resolve old promise
```

Assert:

```text
state does not become registered
consent is not restored by stale completion
foreground listener is not attached by stale completion
no stale UI callback is emitted
```

---

### F3.4 — refresh failure

Sequence:

```text
consent=true
permission=granted
backend refresh fails
```

Assert:

```text
state = register_error
state is NOT registered
existing stored consent alone is not treated as proof of active registration
```

---

### F3.5 — explicit enable

Sequence:

```text
consent=false
permission=default
user clicks enable
```

Assert:

```text
requestPermission may be called
on granted -> registration runs
backend request succeeds
consent stored only after successful registration
state = registered
```

---

## 3.12 Phase 3 prohibited shortcuts

Do not:

- set `registered` from localStorage alone,
- request notification permission automatically on reload,
- give each `NotificationSettings` its own Firebase listener,
- add arbitrary registration delays,
- hide one settings component with CSS and assume it is unmounted,
- clear/re-add global listeners from independent consumers,
- treat a Firebase SDK call starting as registration success,
- publish `registered` before backend registration succeeds.

---

## 3.13 Phase 3 gate

Run:

```bash
npm run check
npx tsx --test server/test/pushLifecycle.test.ts
npm test
npm run build
```

If browser smoke can exercise push-independent UI paths, also run:

```bash
node scripts/smoke-multi-session.cjs
node scripts/smoke-mobile.cjs
node scripts/smoke-push-lifecycle.cjs
node scripts/smoke-polling-lifecycle.cjs
```

Do not require real FCM credentials in CI. Run `scripts/smoke-push-lifecycle.cjs` against the actual App/React settings with mocked Firebase SDK and browser/backend services. Include the smoke in CI; test pending registration, two settings sharing state, consumer unmount, explicit concurrent clicks, logout during registration, backend failure, and recovery from failed logout.

---

# 4. PHASE 4 — FINAL INTEGRATION VALIDATION

## 4.1 Full commands

Run exactly:

```bash
npm run check
npm test
npm run build
git diff --check
node scripts/smoke-multi-session.cjs
node scripts/smoke-mobile.cjs
node scripts/smoke-push-lifecycle.cjs
node scripts/smoke-polling-lifecycle.cjs
```

If any command fails:

```text
do not mark the phase complete
do not delete the failing test
do not weaken the assertion
diagnose the real cause
```

---

## 4.2 Review final diff

Run:

```bash
git status --short
git diff --stat
git diff
```

Check specifically that there is no accidental change to:

```text
authentication policy
session API protocol
WebSocket server protocol
working directory security checks
unrelated UI styling
package versions unless required
```

---

## 4.3 Final regression checklist

### Xterm / reconnect

- [x] old started write drains before new snapshot reset
- [x] stale queued old writes are skipped
- [x] new reset/resize/snapshot order is deterministic
- [x] same-session reconnect uses the same global queue
- [x] late old socket events cannot affect new socket
- [x] successful new sync resets reconnect attempts
- [x] no sleeps/timeouts added to hide ordering bugs

### Polling

- [x] scheduler sees current authenticated state
- [x] scheduler calls current `fetchSessions`
- [x] login from an initially logged-out mount starts polling correctly
- [x] no active session means no periodic 5s polling
- [x] active session false -> true restarts periodic polling
- [x] logout cancels scheduler
- [x] old async completion cannot schedule after logout
- [x] error backoff behavior remains intact

### Push / FCM

- [x] stored consent does not directly imply `registered`
- [x] authenticated reload silently refreshes registration
- [x] silent refresh never requests permission
- [x] explicit enable may request permission
- [x] one global foreground listener
- [x] two settings instances do not duplicate registration
- [x] logout invalidates pending refresh
- [x] stale completion cannot restore state/consent/listener
- [x] backend registration failure produces `register_error`
- [x] both settings surfaces show the same shared state

### CI

- [x] typecheck passes
- [x] unit/integration tests pass
- [x] build passes
- [x] `git diff --check` passes
- [x] multi-session browser smoke passes
- [x] mobile browser smoke passes

---

# 5. SUGGESTED COMMIT STRUCTURE

Use small commits so regressions are easy to bisect.

Recommended:

```text
fix: serialize reconnect snapshot reset behind xterm barrier
test: cover same-session reconnect xterm ordering

fix: make session polling use current auth and fetch callbacks
test: cover polling login transition wiring

fix: centralize push registration lifecycle
test: cover push reload logout and multi-consumer lifecycle
```

If implementation and tests are naturally inseparable, combining each fix + its tests into one commit is acceptable.

Do not mix all three fixes into one large unstructured commit unless repository workflow requires it.

---

# 6. REQUIRED FINAL REPORT FROM THE CODING AGENT

At completion, output a concise report with this exact structure:

```markdown
## Files changed
- ...

## Phase 1 — xterm reconnect
- Root cause:
- Fix:
- Regression test:
- Commands run:
- Result:

## Phase 2 — polling
- Root cause:
- Fix:
- Regression test:
- Commands run:
- Result:

## Phase 3 — push lifecycle
- Root cause:
- Fix:
- Regression test:
- Commands run:
- Result:

## Full validation
- npm run check:
- npm test:
- npm run build:
- git diff --check:
- smoke-multi-session:
- smoke-mobile:

## Remaining limitations
- ...
```

Do not say there are no limitations unless all requested tests and validation commands actually completed successfully.

---

# 7. DEFINITION OF DONE

This work is complete only when all of the following are true:

1. A same-session reconnect cannot reset xterm before an already-running old write drains.
2. A regression test reproduces that ordering hazard using a controlled promise.
3. The session polling scheduler uses current auth and fetch behavior after login/re-login.
4. The polling fix has coverage for mutable runtime state plus production wiring.
5. Reload/login with existing push consent performs a real silent registration refresh.
6. Reload does not request notification permission.
7. Multiple `NotificationSettings` instances do not create duplicate registration/listener ownership.
8. Logout invalidates pending push work and stale completions cannot restore `registered`.
9. Existing tests still pass.
10. Browser smoke tests still pass.
11. Validation evidence is written to:
   `docs/agile/changes/third-review-fix-validation.md`.
12. No unrelated refactor is included.

If one item is not satisfied, do not mark the work complete.
