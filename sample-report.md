# Fail-open WAL Runtime Handling Allows Post-Crash Equivocation

## Severity

Critical

## Summary

Malachite’s runtime WAL path is fail-open. `wal_append` and `wal_flush` log errors but still return success, so consensus continues to publish signed messages and process decisions without durable persistence.

If the node crashes after publishing a vote/proposal that was not durably written, restart replay can rebuild an incomplete state and the validator can sign a conflicting vote at the same `height/round` (equivocation).

## Primary Vulnerability (Exploitable)

1. Runtime WAL operations swallow errors and return `Ok(())`.
   - `malachite/code/crates/engine/src/consensus.rs:973` (`wal_append`)
   - `malachite/code/crates/engine/src/consensus.rs:1000` (`wal_flush`)
2. Broadcast/finalization still proceeds after those best-effort calls.
   - `malachite/code/crates/engine/src/consensus.rs:1182` (`Effect::PublishConsensusMsg`)
   - `malachite/code/crates/engine/src/consensus.rs:1271` (`Effect::Decide`)
3. The codebase already has a fail-closed safety mechanism for WAL failures, but only on startup paths.
   - `malachite/code/crates/engine/src/consensus.rs:1543` (`hang_on_failure`)
   - `malachite/code/crates/engine/src/consensus.rs:398` (`wal_fetch` guarded)
   - `malachite/code/crates/engine/src/consensus.rs:436` (`wal_replay` guarded)
4. Runtime append/flush are the inconsistency: same safety domain, weaker policy.

## Why Replay Does Not Help Comprehensively

1. Lock state is not persisted directly; it is reconstructed from replayed events.
   - `malachite/code/crates/core-state-machine/src/state.rs:66`
   - `malachite/code/crates/core-state-machine/src/state.rs:69`
2. WAL entries contain messages/timeouts/proposed values, not lock snapshots.
   - `malachite/code/crates/core-consensus/src/types.rs:93`
3. If polka-forming votes were not durably appended, replay cannot re-establish prior lock constraints.
4. Driver-side in-memory duplicate-vote guards are also volatile across crash/restart.
   - `malachite/code/crates/core-driver/src/driver.rs:65`

## Secondary Control Gap (Amplifies Impact)

`SigningProvider` does not mandate persistent anti-equivocation watermark semantics (`height/round/step` monotonicity and conflict rejection). This means the engine cannot assume signer-layer protection if WAL durability is lost.

- `malachite/code/crates/signing/src/lib.rs:58`

This is not the root cause, but it removes a defense layer that CometBFT default deployments have (`privval/FilePV`).

## Fault-Injection PoC

1. From the repository root (the directory that contains `code/`), apply this exact PoC patch:

```bash
git apply <<'PATCH'
diff --git a/code/crates/engine/src/wal/thread.rs b/code/crates/engine/src/wal/thread.rs
index 1157dbf7..73b742b6 100644
--- a/code/crates/engine/src/wal/thread.rs
+++ b/code/crates/engine/src/wal/thread.rs
@@ -113,17 +113,24 @@ where
             let entry_type = wal_entry_type(&entry);
 
             let mut buf = Vec::new();
+            let fail_append = std::env::var_os("MALACHITE_TEST_FAIL_WAL_APPEND").is_some();
 
             // Capture encoding result and always send a reply to prevent deadlock
-            let result = encode_entry(&entry, codec, &mut buf)
-                .and_then(|_| {
-                    if !buf.is_empty() {
-                        log.append(&buf)
-                    } else {
-                        Ok(())
-                    }
-                })
-                .map_err(Into::into);
+            let result = if fail_append {
+                Err(eyre!(
+                    "Injected WAL append failure (MALACHITE_TEST_FAIL_WAL_APPEND)"
+                ))
+            } else {
+                encode_entry(&entry, codec, &mut buf)
+                    .and_then(|_| {
+                        if !buf.is_empty() {
+                            log.append(&buf)
+                        } else {
+                            Ok(())
+                        }
+                    })
+                    .map_err(Into::into)
+            };
 
             if let Err(e) = &result {
                 error!("ATTENTION: Failed to append entry to WAL: {e}");
diff --git a/code/crates/test/tests/it/wal.rs b/code/crates/test/tests/it/wal.rs
index 7d1d362b..ca5b94b5 100644
--- a/code/crates/test/tests/it/wal.rs
+++ b/code/crates/test/tests/it/wal.rs
@@ -1,4 +1,10 @@
 use std::time::Duration;
+use std::{
+    sync::{
+        atomic::{AtomicBool, Ordering},
+        Arc,
+    },
+};
 
 use eyre::bail;
 use tracing::info;
@@ -7,9 +13,10 @@ use informalsystems_malachitebft_test::{self as malachitebft_test};
 
 use malachitebft_config::ValuePayload;
 use malachitebft_core_consensus::LocallyProposedValue;
-use malachitebft_core_types::SignedVote;
+use malachitebft_core_types::{NilOrVal, Round, SignedVote, Vote as _, VoteType};
 use malachitebft_engine::util::events::Event;
 use malachitebft_test::TestContext;
+use malachitebft_test::{middleware::Middleware, Address, Height, ValueId, Vote};
 
 use crate::middlewares::{ByzantineProposer, PrevoteNil};
 use crate::{HandlerResult, TestBuilder, TestParams};
@@ -445,3 +452,124 @@ async fn multi_rounds_1() {
 async fn multi_rounds_2() {
     test_multi_rounds(3, Duration::from_secs(10)).await
 }
+
+#[derive(Clone, Debug)]
+struct PrevoteNilUntilCrash {
+    target_height: Height,
+    emit_nil: Arc<AtomicBool>,
+}
+
+impl PrevoteNilUntilCrash {
+    fn new(target_height: Height) -> Self {
+        Self {
+            target_height,
+            emit_nil: Arc::new(AtomicBool::new(true)),
+        }
+    }
+
+    fn disable_nil_mode(&self) {
+        self.emit_nil.store(false, Ordering::SeqCst);
+    }
+}
+
+impl Middleware for PrevoteNilUntilCrash {
+    fn new_prevote(
+        &self,
+        _ctx: &TestContext,
+        height: Height,
+        round: Round,
+        value_id: NilOrVal<ValueId>,
+        address: Address,
+    ) -> Vote {
+        if height == self.target_height
+            && round.as_u32() == Some(0)
+            && self.emit_nil.load(Ordering::SeqCst)
+        {
+            Vote::new_prevote(height, round, NilOrVal::Nil, address)
+        } else {
+            Vote::new_prevote(height, round, value_id, address)
+        }
+    }
+}
+
+/// Fault-injection PoC:
+/// 1) Make WAL append fail (MALACHITE_TEST_FAIL_WAL_APPEND=1),
+/// 2) crash after first prevote(nil),
+/// 3) restart with middleware switched to regular prevote(value),
+/// 4) observe conflicting prevote for the same height/round.
+#[tokio::test]
+#[ignore]
+async fn wal_append_failure_can_cause_vote_equivocation_on_restart() {
+    if std::env::var_os("MALACHITE_TEST_FAIL_WAL_APPEND").is_none() {
+        panic!("Set MALACHITE_TEST_FAIL_WAL_APPEND=1 for this PoC test");
+    }
+
+    #[derive(Clone, Debug, Default)]
+    struct State {
+        first_prevote: Option<SignedVote<TestContext>>,
+    }
+
+    const CRASH_HEIGHT: u64 = 1;
+    let middleware = PrevoteNilUntilCrash::new(Height::new(CRASH_HEIGHT));
+    let middleware_after_first_vote = middleware.clone();
+
+    let mut test = TestBuilder::<State>::new();
+
+    // Single-validator setup to remove network timing noise.
+    test.add_node()
+        .with_voting_power(100)
+        .with_middleware(middleware)
+        .start()
+        .wait_until(CRASH_HEIGHT)
+        .on_vote(move |vote, state| {
+            // Capture the first prevote(nil) at the crash height.
+            if vote.height().as_u64() != CRASH_HEIGHT
+                || vote.vote_type() != VoteType::Prevote
+                || !matches!(vote.value(), NilOrVal::Nil)
+            {
+                return Ok(HandlerResult::WaitForNextEvent);
+            }
+
+            state.first_prevote = Some(vote);
+            middleware_after_first_vote.disable_nil_mode();
+            Ok(HandlerResult::ContinueTest)
+        })
+        .crash()
+        .restart_after(Duration::from_secs(1))
+        .on_vote(|vote, state| {
+            let Some(first) = state.first_prevote.as_ref() else {
+                bail!("Missing first prevote before restart");
+            };
+
+            // We are only interested in a second prevote for the same H/R.
+            if vote.height() != first.height()
+                || vote.round() != first.round()
+                || vote.vote_type() != first.vote_type()
+            {
+                return Ok(HandlerResult::WaitForNextEvent);
+            }
+
+            if vote.value() == first.value() {
+                return Ok(HandlerResult::WaitForNextEvent);
+            }
+
+            info!(
+                "Observed conflicting prevotes at same height/round: first={:?}, second={:?}",
+                first.value(),
+                vote.value()
+            );
+
+            Ok(HandlerResult::ContinueTest)
+        })
+        .success();
+
+    test.build()
+        .run_with_params(
+            Duration::from_secs(45),
+            TestParams {
+                enable_value_sync: false,
+                ..TestParams::default()
+            },
+        )
+        .await
+}
PATCH
```

2. Execute the PoC and capture logs:

```bash
set -o pipefail
cd code
MALACHITE_TEST_FAIL_WAL_APPEND=1 cargo test -p informalsystems-malachitebft-test --test it wal::wal_append_failure_can_cause_vote_equivocation_on_restart -- --ignored --nocapture | tee /tmp/malachite-wal-poc.log
```

3. Verify that all required proof signals are present:

```bash
rg -n "Voting vote_type=Prevote value=Nil round=0|ATTENTION: Failed to append entry to WAL: Injected WAL append failure \\(MALACHITE_TEST_FAIL_WAL_APPEND\\)|Node will crash at height 1|Starting new height height=1|Observed conflicting prevotes at same height/round: first=Nil, second=Val|test wal::wal_append_failure_can_cause_vote_equivocation_on_restart \\.\\.\\. ok" /tmp/malachite-wal-poc.log
```

4. Pass criteria:
   - The first run signs and logs a `Prevote ... Nil` at `height=1, round=0`.
   - WAL append failures are logged and not fatal.
   - The node crashes and restarts at the same height.
   - A second `Prevote` at the same `height/round` is signed for a non-`Nil` value.
   - The test logs `Observed conflicting prevotes at same height/round: first=Nil, second=Val(...)`.
   - The test terminates with `... wal_append_failure_can_cause_vote_equivocation_on_restart ... ok`.

Representative proof trace from a successful run:

```text
Voting vote_type=Prevote value=Nil round=0
ATTENTION: Failed to append entry to WAL: Injected WAL append failure (MALACHITE_TEST_FAIL_WAL_APPEND)
Node will crash at height 1
Starting new height height=1
Voting vote_type=Prevote value=5830 round=0
Observed conflicting prevotes at same height/round: first=Nil, second=Val(ValueId(22576))
test wal::wal_append_failure_can_cause_vote_equivocation_on_restart ... ok
```

Result: same validator signs two different prevotes at identical `(H=1, R=0)`.

## Why This Is Unlikely to be “Expected Behavior”

`RestartHeight` explicitly warns that resetting WAL may cause equivocation and marks the action as “extreme caution.”

- `malachite/code/crates/engine/src/consensus.rs:124`

That warning describes an intentional, operator-triggered risk gate. This report is a different issue: an unintentional runtime path where WAL durability fails, the node logs the failure, and still continues signing/publishing.

## CometBFT Differential (Security-Relevant)

CometBFT breaks this chain in two independent places:

1. Own internal consensus messages are fail-closed on WAL write failure (`panic`).
   - `CometBFT consensus/state.go:846`
2. Signer (`FilePV`) enforces H/R/S anti-equivocation watermark with durable state and rejects conflicting data.
   - `CometBFT privval/file.go:312`
   - `CometBFT privval/file.go:335`
   - `CometBFT privval/file.go:349`

Malachite currently has neither defense as a mandatory invariant.

## Impact

1. Slashable validator equivocation (double-sign).
2. Consensus safety budget degradation (fewer additional Byzantine validators needed to break safety).
3. Silent latent risk: node continues operation after durability failure; hazard materializes on crash/restart.
4. Conditional durability risk on `Decide` path: decision processing proceeds after swallowed `wal_flush`. If the host has not independently persisted the decision and a crash occurs, the node can restart at the decided height with incomplete WAL state, leading to vote equivocation during re-participation. Escalation to a conflicting decision at the same height would additionally require sufficient Byzantine voting power to form an alternative quorum.

## Remediation

1. Make runtime `wal_append`/`wal_flush` fail-closed by propagating errors and halting before publish/decide.
2. Apply `hang_on_failure` (or equivalent) consistently to runtime WAL operations.
3. Add signer-level persistent anti-equivocation watermarking as defense-in-depth.
4. Add regression tests asserting: WAL append/flush failure must prevent consensus message publication and decision progression.
