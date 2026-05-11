# Bronson Agent Skills Catalog

This file is read by the meta-agent to understand what agents can do when generating workflow YAML files.
It defines the available models, tools, guard types, and example patterns.

---

## Models (via CLōD)

| Model ID | Tier | Best for |
|---|---|---|
| `deepseek-v3` | cheap | Summarization, formatting, classification, routing |
| `gpt-4o` | frontier | Reasoning, code generation, complex analysis |
| `claude-3-5-sonnet-20241022` | frontier | Long-context analysis, nuanced judgment |
| `claude-3-haiku-20240307` | cheap | Fast structured extraction, simple Q&A |

---

## Guard Types

| Guard | Behavior |
|---|---|
| `gate: auto` | Job completes automatically without human review |
| `gate: human` | Execution pauses and waits for human Approve/Reject via the API or UI |

---

## Budget Control (AllScale integration)

```yaml
budget_usd: 0.50   # Job halts if LLM spend exceeds this. AllScale checkout link is created.
```

When a job's LLM cost exceeds `budget_usd`:
1. The job suspends and emits a `BUDGET_EXCEEDED` event with a USDC checkout URL
2. An AllScale checkout intent is created for the same amount (top-up)
3. Once payment is confirmed on-chain, a webhook resumes the job automatically

---

## Failure Handling

```yaml
on_failure: halt    # (default) Stop the whole run on failure
on_failure: retry   # Retry the job up to max_retries times
max_retries: 3      # Max retry attempts (0–5)
```

---

## Context Budgets

```yaml
context_budget: 2000   # Max tokens of upstream output passed as context to this job
```

Upstream outputs from `depends_on` jobs are injected as context. Longer chains should increase this.

---

## Available Tools (declare in YAML; orchestrator injects data pre-prompt)

### Finance Tools
- `polymarket_search` — Searches active Polymarket prediction markets by keyword. Returns: question, yes/no odds, 24h volume, liquidity.
- `alpaca_quote` — Fetches live stock/crypto quote from Alpaca paper trading API. Returns: symbol, price, change %.
- `propose_trade` — Structured trade proposal agent. Produces: side (YES/NO/BUY/SELL), size, cost, rationale.

### DevOps / Infrastructure Tools
- `aws_ec2_list` — Lists EC2 instances with CPU utilization and tags (uses LocalStack in dev).
- `aws_s3_list` — Lists S3 buckets with size, last-modified, and tags.
- `aws_cost_explorer` — Pulls monthly AWS cost breakdown by service.
- `cloudflare_rules` — Reads active Cloudflare firewall rules for a zone.

### Code / Research Tools
- `greptile_search` — Semantic code search over a connected GitHub repository. Pass a natural-language query.
- `web_search` — General web search for research tasks.

---

## YAML Schema

```yaml
name: string                  # Workflow name (shown in UI)
jobs:
  <job-id>:                   # Unique job identifier (snake_case recommended)
    prompt: string            # The agent's instruction
    model: string             # Model ID from the table above
    depends_on: [job-id, ...]  # List of job IDs that must complete first
    gate: auto | human        # Human-in-the-loop guard
    context_budget: number    # Max tokens of upstream context (default 2000)
    tools: [tool-name, ...]   # Tools available to this job
    on_failure: halt | retry
    max_retries: 0–5
    budget_usd: number        # Optional spend cap (triggers AllScale top-up)
```

---

## Kill Switch (Emergency Stop)

Any running job or full run can be killed immediately:

```bash
# Kill an entire run (all jobs stop, run marked failed)
POST /runs/:runId/stop

# Kill a single job's LLM request (abort HTTP call)
POST /runs/:runId/jobs/:jobId/stop
```

UI buttons:
- **Stop listening** — Closes the SSE stream (local only, run continues)
- **Kill Run** — Sends stop signal to orchestrator, run fails immediately

---

## Example Patterns

### Linear pipeline (A → B → C)
```yaml
name: sequential-analysis
jobs:
  collect:
    prompt: "Collect and summarize the input data."
    model: deepseek-v3
  analyze:
    depends_on: [collect]
    prompt: "Analyze the summary and identify key findings."
    model: gpt-4o
  report:
    depends_on: [analyze]
    gate: human
    prompt: "Draft a final report from the analysis. Await human review."
    model: gpt-4o
```

### Fan-out then merge (A → [B, C] → D)
```yaml
name: parallel-research
jobs:
  setup:
    prompt: "Define the research question."
    model: deepseek-v3
  research_a:
    depends_on: [setup]
    prompt: "Research angle A."
    model: gpt-4o
  research_b:
    depends_on: [setup]
    prompt: "Research angle B."
    model: gpt-4o
  synthesize:
    depends_on: [research_a, research_b]
    prompt: "Synthesize findings from both research tracks."
    model: gpt-4o
    gate: human
```

### Finance pipeline (Polymarket bet with human gate)
```yaml
name: polymarket-trade
jobs:
  research_market:
    prompt: "Find the most relevant active Polymarket market for the given topic and summarize odds."
    model: deepseek-v3
    tools: [polymarket_search]
  propose_trade:
    depends_on: [research_market]
    prompt: "Based on the market data, propose a YES or NO bet. Include: side, contracts, total cost in USDC, rationale."
    model: gpt-4o
    tools: [propose_trade]
    budget_usd: 0.10
  execute_trade:
    depends_on: [propose_trade]
    gate: human
    prompt: "Review and approve the proposed trade. If approved, log it as executed."
    model: deepseek-v3
```

### DevOps pipeline (infra scan with destructive gate)
```yaml
name: infra-cleanup
jobs:
  scan:
    prompt: "Scan for idle/orphaned AWS resources and estimate monthly waste."
    model: deepseek-v3
    tools: [aws_ec2_list, aws_s3_list, aws_cost_explorer]
  plan:
    depends_on: [scan]
    prompt: "Propose specific termination/deletion actions for each wasted resource. Flag anything tagged 'production' or 'database'."
    model: gpt-4o
  execute:
    depends_on: [plan]
    gate: human
    prompt: "Apply the approved remediation actions. Log all changes to audit trail."
    model: gpt-4o
    on_failure: retry
    max_retries: 2
```
