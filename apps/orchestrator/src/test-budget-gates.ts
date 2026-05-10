/**
 * Integration test for budget gates, settled-flag lifecycle, parallel-wave
 * run.status, and human-gate-after-funding. Run with:
 *
 *   npx tsx src/test-budget-gates.ts
 *
 * No API keys needed — mocks CLōD and AllScale at the module level.
 */

import assert from "node:assert";
import { budgetTracker, BudgetExceededError } from "./orchestrator/budget-tracker.js";
import { gateManager } from "./gates/gate-manager.js";
import { eventLog } from "./event-log/event-log.js";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    })
    .catch((err) => {
      failed++;
      console.error(`  ✗ ${name}`);
      console.error(`    ${err}`);
    });
}

async function main() {

// ─── BudgetTracker unit tests ─────────────────────────────────

await test("register + deduct within limit does not throw", async () => {
  budgetTracker.register("r1", "j1", 1.0);
  await budgetTracker.deduct("r1", "j1", 0.5);
  await budgetTracker.deduct("r1", "j1", 0.4);
});

await test("deduct over limit throws BudgetExceededError", async () => {
  budgetTracker.register("r2", "j1", 0.10);
  await budgetTracker.deduct("r2", "j1", 0.05);
  try {
    await budgetTracker.deduct("r2", "j1", 0.10);
    assert.fail("Should have thrown");
  } catch (e) {
    assert.ok(e instanceof BudgetExceededError);
    assert.strictEqual(e.runId, "r2");
    assert.strictEqual(e.jobId, "j1");
  }
});

await test("topUp before waitForFunding resolves immediately (race-safe)", async () => {
  budgetTracker.register("r3", "j1", 0.01);
  try {
    await budgetTracker.deduct("r3", "j1", 0.02);
  } catch {}

  // Simulate webhook arriving before waitForFunding is called
  budgetTracker.topUp("r3", "j1", 0.05);

  // Should resolve immediately, not deadlock
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("DEADLOCK: waitForFunding did not resolve")), 500),
  );
  await Promise.race([budgetTracker.waitForFunding("r3", "j1"), timeout]);
});

await test("settled flag resets after fast-path — second cycle blocks", async () => {
  budgetTracker.register("r4", "j1", 0.01);

  // First cycle: exceed, topUp early, waitForFunding resolves via fast-path
  try { await budgetTracker.deduct("r4", "j1", 0.02); } catch {}
  budgetTracker.topUp("r4", "j1", 0.05);
  await budgetTracker.waitForFunding("r4", "j1");

  // Second cycle: exceed again — waitForFunding should NOT resolve instantly
  try { await budgetTracker.deduct("r4", "j1", 0.50); } catch {}

  let resolvedInstantly = false;
  const p = budgetTracker.waitForFunding("r4", "j1", 200).then(() => {
    resolvedInstantly = true;
  }).catch(() => {});

  // Give it a tick — if settled wasn't cleared, it resolves immediately
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(resolvedInstantly, false, "Should NOT have resolved instantly — settled flag should be cleared");

  // Clean up: fund it so the timeout doesn't leak
  budgetTracker.topUp("r4", "j1", 1.0);
  await p;
});

await test("waitForFunding times out and rejects", async () => {
  budgetTracker.register("r5", "j1", 0.01);
  try { await budgetTracker.deduct("r5", "j1", 0.02); } catch {}

  try {
    await budgetTracker.waitForFunding("r5", "j1", 100);
    assert.fail("Should have timed out");
  } catch (e: any) {
    assert.ok(e.message.includes("timed out"), `Expected timeout error, got: ${e.message}`);
  }
});

await test("cancelFunding rejects the waiting promise", async () => {
  budgetTracker.register("r6", "j1", 0.01);
  try { await budgetTracker.deduct("r6", "j1", 0.02); } catch {}

  const p = budgetTracker.waitForFunding("r6", "j1", 60_000);

  // Cancel after a tick
  setTimeout(() => budgetTracker.cancelFunding("r6", "j1", "user cancelled"), 20);

  try {
    await p;
    assert.fail("Should have been cancelled");
  } catch (e: any) {
    assert.ok(e.message.includes("user cancelled"));
  }
});

await test("listAwaiting returns clean DTOs without internal state", async () => {
  budgetTracker.register("r7", "j1", 0.01);
  budgetTracker.register("r7", "j2", 0.01);
  try { await budgetTracker.deduct("r7", "j1", 0.02); } catch {}
  try { await budgetTracker.deduct("r7", "j2", 0.02); } catch {}

  // Start waiting (don't await)
  const p1 = budgetTracker.waitForFunding("r7", "j1", 500);
  const p2 = budgetTracker.waitForFunding("r7", "j2", 500);

  const awaiting = budgetTracker.listAwaiting("r7");
  assert.strictEqual(awaiting.length, 2);

  for (const item of awaiting) {
    assert.ok("jobId" in item);
    assert.ok("limitUsd" in item);
    assert.ok("spentUsd" in item);
    // Must NOT have internal state leaked
    assert.ok(!("resolve" in item), `resolve leaked for ${item.jobId}`);
    assert.ok(!("reject" in item), `reject leaked for ${item.jobId}`);
    assert.ok(!("timeoutHandle" in item), `timeoutHandle leaked for ${item.jobId}`);
  }

  // Clean up
  budgetTracker.topUp("r7", "j1", 1, "cleanup-r7-j1");
  budgetTracker.topUp("r7", "j2", 1, "cleanup-r7-j2");
  await Promise.all([p1, p2]);
});

await test("duplicate topUp with same intentId is idempotent", async () => {
  budgetTracker.register("r8", "j1", 0.01);
  try { await budgetTracker.deduct("r8", "j1", 0.02); } catch {}

  budgetTracker.topUp("r8", "j1", 0.05, "intent-abc-123");
  // Duplicate webhook delivery — same intentId should be a no-op
  budgetTracker.topUp("r8", "j1", 0.05, "intent-abc-123");

  const state = budgetTracker.getState("r8", "j1");
  // spentUsd should only be decremented once
  assert.ok(state!.spentUsd >= -0.04, `spentUsd should reflect single topUp, got ${state!.spentUsd}`);
});

await test("duplicate webhook retry minutes later still rejected by intentId", async () => {
  budgetTracker.register("r9", "j1", 0.10);
  try { await budgetTracker.deduct("r9", "j1", 0.20); } catch {}

  const p = budgetTracker.waitForFunding("r9", "j1", 5000);
  budgetTracker.topUp("r9", "j1", 0.10, "intent-retry-test");
  await p;

  // Job continues, exceeds budget again in a second cycle
  try { await budgetTracker.deduct("r9", "j1", 0.50); } catch {}
  const p2 = budgetTracker.waitForFunding("r9", "j1", 500);

  // Late retry of the FIRST webhook — same intent ID
  budgetTracker.topUp("r9", "j1", 0.10, "intent-retry-test");

  // Should NOT have resolved — the duplicate was rejected
  let resolved = false;
  p2.then(() => { resolved = true; }).catch(() => {});
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(resolved, false, "Late duplicate webhook should not resolve second funding gate");

  // Fund with a fresh intent to clean up
  budgetTracker.topUp("r9", "j1", 1.0, "intent-fresh");
  await p2;
});

// ─── Additional edge case tests ───────────────────────────────

await test("normal path: waitForFunding called first, then topUp resolves it, second cycle blocks", async () => {
  budgetTracker.register("r10", "j1", 0.01);
  try { await budgetTracker.deduct("r10", "j1", 0.02); } catch {}

  // Normal path: wait first, then fund
  const p = budgetTracker.waitForFunding("r10", "j1", 5000);
  setTimeout(() => budgetTracker.topUp("r10", "j1", 0.05, "intent-r10-1"), 20);
  await p;

  // Second cycle: exceed again — should block
  try { await budgetTracker.deduct("r10", "j1", 0.50); } catch {}

  let resolved = false;
  const p2 = budgetTracker.waitForFunding("r10", "j1", 300).then(() => {
    resolved = true;
  }).catch(() => {});

  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(resolved, false, "Second cycle should block after normal-path resolve");

  budgetTracker.topUp("r10", "j1", 1.0, "intent-r10-2");
  await p2;
});

await test("empty string intentId is treated as no intentId (no dedup)", async () => {
  budgetTracker.register("r11", "j1", 0.01);
  try { await budgetTracker.deduct("r11", "j1", 0.02); } catch {}

  // First topUp with empty string — should work
  const result1 = budgetTracker.topUp("r11", "j1", 0.05, "");
  assert.strictEqual(result1, true, "Empty string intentId should be treated as no intentId");

  await budgetTracker.waitForFunding("r11", "j1");
});

await test("topUp returns false for duplicate intentId", async () => {
  budgetTracker.register("r12", "j1", 0.01);
  try { await budgetTracker.deduct("r12", "j1", 0.02); } catch {}

  const first = budgetTracker.topUp("r12", "j1", 0.05, "intent-r12");
  assert.strictEqual(first, true, "First topUp should return true");

  const second = budgetTracker.topUp("r12", "j1", 0.05, "intent-r12");
  assert.strictEqual(second, false, "Duplicate topUp should return false");

  await budgetTracker.waitForFunding("r12", "j1");
});

await test("topUp without intentId allows multiple calls (by design)", async () => {
  budgetTracker.register("r13", "j1", 0.01);
  try { await budgetTracker.deduct("r13", "j1", 0.02); } catch {}

  // First topUp without intentId — works
  const first = budgetTracker.topUp("r13", "j1", 0.01);
  assert.strictEqual(first, true);

  await budgetTracker.waitForFunding("r13", "j1");

  // Second cycle
  try { await budgetTracker.deduct("r13", "j1", 0.50); } catch {}

  // Second topUp without intentId — also works (no dedup without intentId)
  const p = budgetTracker.waitForFunding("r13", "j1", 5000);
  setTimeout(() => {
    const second = budgetTracker.topUp("r13", "j1", 1.0);
    assert.strictEqual(second, true, "Second topUp without intentId should work");
  }, 20);
  await p;
});

await test("cancelFunding after topUp race — cancel is a no-op", async () => {
  budgetTracker.register("r14", "j1", 0.01);
  try { await budgetTracker.deduct("r14", "j1", 0.02); } catch {}

  // topUp arrives first (race)
  budgetTracker.topUp("r14", "j1", 0.05, "intent-r14");

  // Cancel arrives after — should be a no-op since topUp already cleared resolve/reject
  budgetTracker.cancelFunding("r14", "j1", "too late");

  // waitForFunding should still resolve via fast-path
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("DEADLOCK after cancel")), 500),
  );
  await Promise.race([budgetTracker.waitForFunding("r14", "j1"), timeout]);
});

await test("deduct with zero cost does not throw", async () => {
  budgetTracker.register("r15", "j1", 1.0);
  await budgetTracker.deduct("r15", "j1", 0);
  await budgetTracker.deduct("r15", "j1", 0);
  const state = budgetTracker.getState("r15", "j1");
  assert.strictEqual(state!.spentUsd, 0);
});

await test("deduct on unregistered job is a silent no-op", async () => {
  await budgetTracker.deduct("nonexistent", "nope", 100);
});

// ─── Summary ──────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

} // end main

main().catch(err => { console.error(err); process.exit(1); });
