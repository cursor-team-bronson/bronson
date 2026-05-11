/**
 * HACKATHON DEMO — Finance Vertical: Budget Gates + Human Gates + AllScale
 *
 * Run with:   npx tsx src/demo.ts
 *
 * This drives the orchestrator internals directly (no HTTP server needed,
 * no CLōD quota required). It simulates the full agent pipeline with
 * realistic delays and output, showing:
 *
 *   1. DAG resolution and parallel-wave execution
 *   2. Agent producing output (simulated LLM)
 *   3. Budget cap hit → job suspends → checkout URL shown
 *   4. AllScale payment simulation → job resumes
 *   5. Human gate → judge approves/rejects
 *   6. Cost + token tracking across the pipeline
 */

import { budgetTracker, BudgetExceededError } from "./orchestrator/budget-tracker.js";
import { gateManager } from "./gates/gate-manager.js";
import { eventLog } from "./event-log/event-log.js";

const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function banner(text: string) {
  console.log(`\n${BOLD}${"═".repeat(60)}${RESET}`);
  console.log(`${BOLD}  ${text}${RESET}`);
  console.log(`${BOLD}${"═".repeat(60)}${RESET}\n`);
}

function step(text: string) {
  console.log(`${CYAN}▸${RESET} ${text}`);
}

function ok(text: string) {
  console.log(`  ${GREEN}✓${RESET} ${text}`);
}

function warn(text: string) {
  console.log(`  ${YELLOW}⚠${RESET} ${text}`);
}

function danger(text: string) {
  console.log(`  ${RED}✗${RESET} ${text}`);
}

function info(text: string) {
  console.log(`  ${DIM}${text}${RESET}`);
}

function money(label: string, amount: number) {
  console.log(`  ${GREEN}$${amount.toFixed(4)}${RESET} ${label}`);
}

async function sleep(ms: number) {
  await new Promise(r => setTimeout(r, ms));
}

// ─── Simulated agent outputs ──────────────────────────────────

const RESEARCH_OUTPUT = JSON.stringify({
  markets: [
    {
      question: "Will the Fed cut rates in June 2026?",
      yes_price: 0.67,
      no_price: 0.33,
      volume_24h: 2_140_000,
      liquidity: 890_000,
    },
    {
      question: "Will Bitcoin exceed $120k by July 2026?",
      yes_price: 0.42,
      no_price: 0.58,
      volume_24h: 1_800_000,
      liquidity: 620_000,
    },
  ],
  recommendation: "Fed rate cut market shows strong signal — 67% YES with $2.1M 24h volume",
}, null, 2);

const TRADE_PROPOSAL = JSON.stringify({
  market_question: "Will the Fed cut rates in June 2026?",
  side: "YES",
  contracts: 50,
  price_per_contract: 0.67,
  total_cost_usdc: 33.50,
  max_payout_usdc: 50.00,
  potential_profit_usdc: 16.50,
  rationale: "High volume ($2.1M 24h), price moved from 58% to 67% this week following CPI data. Strong buy signal.",
}, null, 2);

const EXECUTION_RECEIPT = JSON.stringify({
  status: "SIMULATED_FILL",
  market: "Will the Fed cut rates in June 2026?",
  side: "YES",
  contracts: 50,
  fill_price: 0.67,
  total_cost_usdc: 33.50,
  tx_hash: "0xdemo...a1b2c3",
  timestamp: new Date().toISOString(),
  allscale_tx: "sim_allscale_" + Date.now(),
}, null, 2);

// ─── Demo flow ────────────────────────────────────────────────

async function main() {
  const RUN_ID = "demo-run-001";
  let totalCost = 0;
  let totalTokens = 0;
  let gatesTriggered = 0;
  let gatesApproved = 0;
  let gatesRejected = 0;
  let disastersAverted = 0;

  banner("BRONSON — Finance Vertical Demo");
  console.log("  Pipeline: Research → Propose Trade → Execute Trade");
  console.log("  Features: Budget caps, AllScale payments, Human gates");
  console.log("");

  // ──────────────────────────────────────────────────────────
  // STEP 1: Show the YAML
  // ──────────────────────────────────────────────────────────
  banner("STEP 1: Parse YAML → Build DAG");

  step("Workflow: Finance Polymarket Trade Pipeline");
  info("Jobs: research_market → propose_trade (human gate) → execute_trade (human gate)");
  info("Budget caps: $0.05, $0.05, $0.02");
  await sleep(500);

  step("DAG resolved — 3 execution waves:");
  info("  Wave 1: [research_market]        (no dependencies)");
  info("  Wave 2: [propose_trade]          (depends on research)");
  info("  Wave 3: [execute_trade]          (depends on proposal)");
  await sleep(500);

  // ──────────────────────────────────────────────────────────
  // STEP 2: Research agent
  // ──────────────────────────────────────────────────────────
  banner("STEP 2: Agent 'research_market' — Scanning Polymarket");

  budgetTracker.register(RUN_ID, "research_market", 0.05);

  step("Agent calling LLM (DeepSeek V3 via CLōD)...");
  await sleep(1500);

  const researchCost = 0.018;
  const researchTokens = 1240;
  totalCost += researchCost;
  totalTokens += researchTokens;

  ok("LLM response received");
  money("cost this call", researchCost);
  info(`Tokens: ${researchTokens}`);
  await sleep(300);

  console.log(`\n  ${DIM}─── Agent Output (research_market) ───${RESET}`);
  for (const line of RESEARCH_OUTPUT.split("\n")) {
    console.log(`  ${DIM}${line}${RESET}`);
  }
  console.log("");

  ok("Job 'research_market' completed");
  await sleep(500);

  // ──────────────────────────────────────────────────────────
  // STEP 3: Trade proposal — hits budget cap
  // ──────────────────────────────────────────────────────────
  banner("STEP 3: Agent 'propose_trade' — Budget Cap Demo");

  budgetTracker.register(RUN_ID, "propose_trade", 0.03);

  step("Agent calling LLM with research context...");
  await sleep(1000);

  const proposalCost = 0.035;
  totalCost += proposalCost;
  totalTokens += 1890;

  warn("LLM call cost $0.035 — exceeds budget cap of $0.03!");
  await sleep(500);

  step("BudgetExceededError thrown → job suspended");
  info("Status: awaiting_funding");
  info("AllScale checkout intent created...");
  await sleep(300);

  console.log("");
  console.log(`  ┌──────────────────────────────────────────────────┐`);
  console.log(`  │  ${YELLOW}${BOLD}BUDGET EXCEEDED${RESET}                                 │`);
  console.log(`  │                                                  │`);
  console.log(`  │  Job:     propose_trade                          │`);
  console.log(`  │  Spent:   ${RED}$0.0350${RESET}                                │`);
  console.log(`  │  Budget:  $0.0300                                │`);
  console.log(`  │                                                  │`);
  console.log(`  │  ${CYAN}AllScale Checkout:${RESET}                              │`);
  console.log(`  │  ${DIM}https://pay.allscale.io/checkout/intent_abc123${RESET} │`);
  console.log(`  │                                                  │`);
  console.log(`  │  Waiting for USDC payment on-chain...            │`);
  console.log(`  └──────────────────────────────────────────────────┘`);
  console.log("");

  await sleep(2000);

  // Simulate AllScale payment
  step("AllScale webhook received — payment confirmed on-chain!");
  info("Intent ID: intent_abc123");
  info("Amount: $0.03 USDC");
  info("TX hash: 0x7f3a...b9c2");
  await sleep(500);

  // Actually fund via the budget tracker
  try { await budgetTracker.deduct(RUN_ID, "propose_trade", proposalCost); } catch {}
  budgetTracker.topUp(RUN_ID, "propose_trade", 0.03, "intent_abc123");

  ok("Job 'propose_trade' resumed");
  await sleep(500);

  // ──────────────────────────────────────────────────────────
  // STEP 4: Human gate on trade proposal
  // ──────────────────────────────────────────────────────────
  banner("STEP 4: Human Gate — Trade Approval Required");

  gatesTriggered++;

  console.log(`  ┌──────────────────────────────────────────────────┐`);
  console.log(`  │  ${YELLOW}${BOLD}⚠  HUMAN APPROVAL REQUIRED${RESET}                       │`);
  console.log(`  │                                                  │`);
  console.log(`  │  "Will the Fed cut rates in June 2026?"          │`);
  console.log(`  │                                                  │`);
  console.log(`  │  Agent wants to bet:  ${BOLD}YES${RESET}                        │`);
  console.log(`  │  Current odds:        ${BOLD}67%${RESET} chance YES             │`);
  console.log(`  │  Contracts:           50                         │`);
  console.log(`  │  Cost:                ${GREEN}$33.50 USDC${RESET}  ← escrowed    │`);
  console.log(`  │  Max payout:          $50.00 USDC                │`);
  console.log(`  │  Potential profit:    ${GREEN}$16.50 USDC${RESET}                │`);
  console.log(`  │                                                  │`);
  console.log(`  │  Rationale: "High volume ($2.1M 24h), price     │`);
  console.log(`  │  moved from 58% to 67% this week following      │`);
  console.log(`  │  CPI data. Strong signal."                       │`);
  console.log(`  │                                                  │`);
  console.log(`  │  ${GREEN}[  ✓ Approve — Place Bet  ]${RESET}  ${RED}[  ✗ Reject  ]${RESET}   │`);
  console.log(`  └──────────────────────────────────────────────────┘`);
  console.log("");

  await sleep(2000);
  step("Judge clicks: ✓ Approve");
  gatesApproved++;
  ok("Gate approved — proceeding to execution");
  await sleep(500);

  // ──────────────────────────────────────────────────────────
  // STEP 5: Execute trade — second human gate
  // ──────────────────────────────────────────────────────────
  banner("STEP 5: Agent 'execute_trade' — Final Execution");

  budgetTracker.register(RUN_ID, "execute_trade", 0.02);

  step("Agent calling LLM to execute trade...");
  await sleep(1000);

  const execCost = 0.012;
  totalCost += execCost;
  totalTokens += 890;
  ok("LLM response received (within budget)");
  money("cost this call", execCost);
  await sleep(300);

  gatesTriggered++;

  console.log("");
  console.log(`  ┌──────────────────────────────────────────────────┐`);
  console.log(`  │  ${YELLOW}${BOLD}⚠  CONFIRM TRADE EXECUTION${RESET}                       │`);
  console.log(`  │                                                  │`);
  console.log(`  │  Market:   "Fed rate cut June 2026?"             │`);
  console.log(`  │  Action:   BUY 50 YES contracts @ $0.67          │`);
  console.log(`  │  Total:    $33.50 USDC                           │`);
  console.log(`  │                                                  │`);
  console.log(`  │  ${BOLD}This is a DESTRUCTIVE financial operation.${RESET}       │`);
  console.log(`  │                                                  │`);
  console.log(`  │  ${GREEN}[  ✓ Execute  ]${RESET}  ${RED}[  ✗ Abort  ]${RESET}                │`);
  console.log(`  └──────────────────────────────────────────────────┘`);
  console.log("");

  await sleep(2000);
  step("Judge clicks: ✓ Execute");
  gatesApproved++;
  ok("Trade executed (simulated)");
  await sleep(300);

  console.log(`\n  ${DIM}─── Execution Receipt ───${RESET}`);
  for (const line of EXECUTION_RECEIPT.split("\n")) {
    console.log(`  ${DIM}${line}${RESET}`);
  }
  await sleep(500);

  // ──────────────────────────────────────────────────────────
  // FINAL: AllScale dashboard
  // ──────────────────────────────────────────────────────────
  banner("ALLSCALE OVERVIEW — The Dashboard");

  console.log(`  ┌─────────────────────────────────────────────┐`);
  console.log(`  │  ${BOLD}ALLSCALE OVERVIEW${RESET}                            │`);
  console.log(`  │                                             │`);
  console.log(`  │  Agent Spend Today        ${GREEN}$${totalCost.toFixed(4)}${RESET}          │`);
  console.log(`  │  Tokens Consumed          ${totalTokens.toLocaleString()}            │`);
  console.log(`  │  Escrowed (pending)       $0.00             │`);
  console.log(`  │  Trades Executed          1                 │`);
  console.log(`  │  Trade Value              $33.50 USDC       │`);
  console.log(`  │                                             │`);
  console.log(`  │  Gates Triggered          ${gatesTriggered}                 │`);
  console.log(`  │  Gates Approved           ${GREEN}${gatesApproved}${RESET}                 │`);
  console.log(`  │  Gates Rejected           ${gatesRejected}                 │`);
  console.log(`  │  Budget Caps Hit          1                 │`);
  console.log(`  │  Disasters Averted        ${disastersAverted}  🛡️             │`);
  console.log(`  └─────────────────────────────────────────────┘`);

  console.log("");

  // ──────────────────────────────────────────────────────────
  // BONUS: Show what a rejection looks like
  // ──────────────────────────────────────────────────────────
  banner("BONUS: What a Rejection Looks Like");

  console.log(`  ${DIM}If the judge had clicked "Reject" on the trade proposal:${RESET}`);
  console.log("");
  console.log(`  ┌──────────────────────────────────────────────────┐`);
  console.log(`  │  ${RED}${BOLD}✗  TRADE REJECTED${RESET}                                 │`);
  console.log(`  │                                                  │`);
  console.log(`  │  Agent wanted to BUY 50 YES @ $33.50 USDC        │`);
  console.log(`  │  Judge reason: "Insufficient conviction — wait   │`);
  console.log(`  │  for next week's FOMC minutes."                  │`);
  console.log(`  │                                                  │`);
  console.log(`  │  AllScale: Escrow unlocked → $33.50 returned     │`);
  console.log(`  │  ${GREEN}Disasters Averted: +1  🛡️${RESET}                       │`);
  console.log(`  └──────────────────────────────────────────────────┘`);

  console.log("");
  banner("DEMO COMPLETE");
  console.log(`  ${BOLD}The pitch:${RESET} "Everyone is building agents.`);
  console.log(`  We are building the ${BOLD}brakes${RESET} and the ${BOLD}dashboard${RESET} for them."`);
  console.log("");
  console.log(`  Run tests:  ${DIM}npm test --workspace=apps/orchestrator${RESET}`);
  console.log(`  16 passing tests covering budget gates, idempotency,`);
  console.log(`  race conditions, and edge cases.`);
  console.log("");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
