# Alpaca Paper Trading + Evaluation — Design

Date: 2026-09-30 · Status: approved in brainstorming, pending spec review

> Educational use only. Paper trading only — no code path in this design can
> reach a live-money Alpaca endpoint.

## Goal

Run the existing fund (all four library strategies) forward on an Alpaca
**paper** account, on a schedule, with execution semantics identical to the
backtester, and measure — against pre-committed rules — whether it adds value
after costs.

## Scope

In this build:

- **A. Paper execution:** Alpaca paper client, live rebalance planner,
  submit/reconcile runner, ledger, `aihf-paper` CLI, launchd schedule.
- **B. Evaluation:** transaction and borrow costs in the backtester, baseline
  backtests (fund, each strategy alone, SPY, equal-weight universe), paper-vs-backtest report.
- **C1. PEAD holding-window fix** (the Earnings Drift sleeve is nearly inert
  at weekly cadence without it).

Out of scope (backlog, section 7): momentum, vol-scaled sizing, beta
neutralization, regime filter, dynamic allocator, leverage, live money.

## Decisions

| Decision | Choice |
|---|---|
| Data / LLM | Financial Datasets + an LLM provider key + Alpaca paper keys; all strategies enabled |
| Universe | Fixed list of ~30 liquid large caps across sectors (`hedge_fund/fund/paper_universe.txt`) |
| Operation | Scheduled, auto-execute on the paper account |
| Risk | Long/short, unlevered: `max_position_pct: 0.10`, `max_gross_exposure: 1.0`; 15% drawdown halt |
| Execution | Market-on-close (MOC) orders — parity with the backtest's next-close fills |

## 1. Timing (backtest parity)

The backtester assesses on the last session of each ISO week and executes at
the next session's close, re-assessing with cutoff `previous_day(session)`.
Live mirrors this:

- **Rebalance day** = a trading session whose previous trading session falls
  in an earlier ISO week (normally Monday; Tuesday after a Monday holiday).
  Determined from Alpaca's `/v2/calendar`.
- **Submit** at ~10:00 ET on the rebalance day: assess with data through the
  previous session (`completed_through()` already caps at yesterday), then
  submit MOC orders (`type=market, time_in_force=cls`).
- **Fill** at the rebalance day's official close, same as the backtest.
- **Reconcile** at ~09:00 ET every trading day, for the **previous**
  session: by then that session is "completed" (`completed_through()`), its
  MOC fills are final, Alpaca's `last_equity` is the prior-close equity, and
  Financial Datasets has the SPY close. Reconcile runs before submit, so the
  drawdown check always sees fresh NAV.

## 2. Components

### 2.1 `hedge_fund/brokers/alpaca.py` — `AlpacaPaperClient`

Thin REST client on `requests` (same style as `FDClient`; no SDK dependency).

- Base URL constant `https://paper-api.alpaca.markets`. The constructor raises
  if an override URL is not exactly that host. There is no live-URL constant
  anywhere in the codebase.
- Credentials from `APCA_API_KEY_ID` / `APCA_API_SECRET_KEY` (Alpaca's
  standard names), loaded through the existing `apply_credentials()` `.env`
  mechanism. Added to `.env.example`.
- Methods: `account()` (cash, equity, status), `positions() -> dict[str, int]`
  (signed shares), `clock()`, `calendar(start, end) -> list[str]` (session
  dates), `list_orders(after, status)`, `submit_moc(ticker, side, qty,
  client_order_id)`, `get_order_by_client_id(id)`.
- Errors raise `AlpacaError(message, status_code)`; HTTP 422 on submit
  (e.g. not shortable) is returned as a rejection, not raised.

It does **not** implement the synchronous `Broker` protocol: MOC orders fill
hours after submission, and the protocol's contract is "fill completely or
raise". The live path is submit-then-reconcile instead.

### 2.2 `hedge_fund/live/plan.py` — `plan_rebalance()`

```
plan_rebalance(fund, universe, positions, cash, data_client, session) -> LivePlan
```

1. `decision = assess_fund(fund, previous_day(session), data_client, universe)`
   — the existing assessment, blend, risk clamp and `validate_targets`.
2. Reference marks = the latest completed close on or before the cutoff
   (`decision.marks`) for every target and held name; held names missing from
   `decision.marks` are priced the same way via the data client.
3. `equity = cash + Σ shares × reference mark` (consistent with the marks; not
   Alpaca's intraday equity).
4. `orders = build_orders(targets, positions, marks, equity)` — existing
   function: floor-toward-zero whole shares, sells before buys.
5. Same projected-weight checks as `execute_decision` (per-name cap, gross
   cap) before returning.

`LivePlan` (pydantic): `session`, `decision: DecisionRecord`, `marks`,
`equity`, `cash`, `positions`, `orders: list[Order]`.

Positions and cash are arguments, not fetched here, so the function is pure
given a data client and is unit-testable without Alpaca.

### 2.3 `hedge_fund/live/runner.py` — `submit()` / `reconcile()`

`submit(fund, universe, client, data_client, ledger, *, now, dry_run)`:

Guards, in order — each returns a logged `SubmitResult(status=...)` without
sending anything:

1. `KILL` file exists in `~/.hedge-fund/` → `killed`.
2. Today is not a trading session (calendar) → `not_trading_day`.
3. `now` is after 15:45 ET → `too_late`.
4. Orders with this session's client-order-id prefix already exist →
   `already_submitted`.
5. Drawdown breaker (checked on **every** trading day, not just rebalance
   days): if latest ledger equity ≤ 0.85 × peak ledger equity, write
   `HALTED`. While `HALTED` exists: if Alpaca still holds positions, plan
   against **empty targets** (flatten, no LLM calls) → `flattening`; if flat
   → `halted`. A partially failed flatten therefore retries the next day.
6. Today is not a rebalance day (section 1) → `not_rebalance_day`.

Then: plan (any data/LLM infrastructure error aborts here, before any order),
write `plans/<session>.json`, and unless `dry_run`, submit each order with
`client_order_id = f"{fund}-{session}-{ticker}"` (sells first). Each result
(accepted / rejected + reason) is appended to the plan file.

`reconcile(fund, client, data_client, ledger, *, session)`:

- Fetch that session's orders by client-id prefix; write
  `fills/<session>.json` (filled qty, avg fill price, status, and slippage
  = fill price vs reference mark, in bps).
- Equity = account `last_equity` (prior-close equity); positions from
  Alpaca valued at that session's Financial Datasets closes for the
  exposure columns; SPY close from Financial Datasets. Append a `nav.csv`
  row for the session.
- Log a warning (never correct) if ledger-expected positions differ from
  Alpaca's — Alpaca is the source of truth; next plan starts from Alpaca.
- Idempotent: re-running for the same session rewrites the same row.

### 2.4 `hedge_fund/live/ledger.py` — `Ledger`

Root `~/.hedge-fund/paper/<fund-name>/`:

- `plans/<session>.json` — `LivePlan` + submission results.
- `fills/<session>.json` — reconciled fills.
- `nav.csv` — `date,equity,cash,long_exposure,short_exposure,gross,spy_close`.
- `logs/<date>-<step>.log` — per-run log.
- `HALTED` — drawdown-breaker flag.

Helpers: `peak_equity()`, `latest_equity()`, `nav_rows()`.

### 2.5 `hedge_fund/live/report.py`

From `nav.csv`: total and annualized return, SPY return over the same dates,
excess return, Sharpe, max drawdown, turnover (from fills), average MOC
slippage (bps), fill rate, and per-strategy contribution (from each plan's
`StrategyRecord.final_contribution` × realized per-name returns). Also prints
the backtest over the same date range when one is supplied, for the
paper-vs-backtest check.

### 2.6 `aihf-paper` CLI — `hedge_fund/live/cli.py`

New Poetry script; `aihf` is unchanged.

```
aihf-paper submit    [--mandate M] [--universe U] [--dry-run] [--model ID]
aihf-paper reconcile [--mandate M] [--date YYYY-MM-DD]
aihf-paper report    [--mandate M] [--backtest result.json]
aihf-paper baseline  [--mandate M] [--start] [--end] [--model ID]   # section 4
aihf-paper status    # account, positions, halts, last run, next rebalance day
aihf-paper flatten   --yes   # MOC-close every position (manual)
aihf-paper install-schedule / uninstall-schedule
```

Defaults: `--mandate hedge_fund/fund/paper.yaml`, `--universe
hedge_fund/fund/paper_universe.txt`.

### 2.7 Mandate and universe

`hedge_fund/fund/paper.yaml`:

```yaml
schema_version: 2
name: paper-fund
strategies:
  - {name: fundamental-ls, weight: 0.35, blend: {mode: dollar_neutral},
     models: [{name: buffett}, {name: munger}, {name: graham}, {name: lynch}, {name: druckenmiller}]}
  - {name: deep-value, weight: 0.20, blend: {mode: long_only},
     models: [{name: graham, weight: 2.0}, {name: buffett}, {name: munger}]}
  - {name: inflections, weight: 0.20, blend: {mode: long_short},
     models: [{name: druckenmiller}, {name: lynch}]}
  - {name: earnings-drift, weight: 0.25, blend: {mode: long_short},
     models: [{name: pead, params: {signal_window_days: 45, decay: true}}]}
risk: {max_position_pct: 0.10, max_gross_exposure: 1.0}
costs: {commission_bps: 5, borrow_bps_annual: 50}
capital: 100000
rebalance: weekly
benchmark: SPY
```

`hedge_fund/fund/paper_universe.txt` (32 names, one per line):
AAPL MSFT NVDA GOOGL META AVGO ORCL · AMZN TSLA HD MCD · WMT PG KO COST ·
LLY UNH JNJ MRK ABBV · JPM BAC V GS · XOM CVX · CAT GE · NFLX DIS · NEE · BRK.B

(Tickers Alpaca or Financial Datasets cannot price are skipped by the
existing skip logic and logged.)

### 2.8 Schedule — launchd

`install-schedule` writes two LaunchAgents to `~/Library/LaunchAgents/`:

- `ai.hedgefund.paper.submit` — weekdays 10:00 America/New_York (converted
  to local time at install; reinstall after DST/timezone change is noted in
  `status`).
- `ai.hedgefund.paper.reconcile` — weekdays 09:00 ET (for the previous
  session; runs before submit).

Each invokes the Poetry venv's `aihf-paper`. On non-zero exit the runner
posts a macOS notification via `osascript`. The Mac must be awake at those
times (documented in `status` output; `pmset repeat wake` suggested, not
applied automatically).

## 3. Backtester costs (B)

- `FundSpec` gains optional `costs: CostModel` with `commission_bps: float = 0`
  and `borrow_bps_annual: float = 0` (both ≥ 0). Existing mandates and tests
  are unchanged by default.
- `SimBroker(cash, commission_bps=0.0)`: each fill deducts
  `qty × price × commission_bps / 1e4` from cash. Fill price is unchanged.
- `SimBroker.accrue_borrow(marks, days, borrow_bps_annual)`: deducts
  `Σ short notional × borrow_bps_annual / 1e4 × days / 365`. Called by
  `backtest_fund` once per valuation session with calendar days since the
  previous one.
- `FundBacktestMetrics` gains `total_costs` (commission + borrow, dollars).

## 4. Baseline evaluation (B)

`aihf-paper baseline [--start] [--end] [--model]` runs, over the paper
universe, and writes `~/.hedge-fund/paper/<fund>/baseline/<date>.json` plus a
printed table:

1. Full paper mandate (blinded, costs on).
2. Each strategy alone (same risk and costs, weight 1.0).
3. SPY buy-and-hold (from the backtest's `benchmark_nav`).
4. Equal-weight universe, rebalanced weekly, same costs — implemented as a
   trivial `equal_weight` quant model (`value = 1.0` for every ticker) in a
   long-only strategy, so it runs through the identical engine.

Two windows: **post-cutoff** (default start 2026-07-01, after the default
model's stated June 2026 training cutoff, through the latest completed
session; override with `--start` when using another model — this is the one
that counts) and **78-week** (labelled "possibly memorized").

The `equal_weight` model is registered in `ALPHA_MODEL_REGISTRY` with
`investment_approach = "long_only"`.

## 5. Verdict rules (pre-committed)

- No verdict before 12 executed paper rebalances.
- A strategy "works" if, after costs, its Sharpe and excess return beat
  **both** SPY and the equal-weight universe in the post-cutoff backtest, and
  its paper results stay within a tracking band of its same-period backtest
  (divergence is investigated as a bug/slippage before being believed).
- A strategy losing to equal-weight after costs gets its slice cut or removed
  at the next mandate revision; slice changes are made in the mandate by the
  user, never automatically.

## 6. PEAD holding window (C1)

`PEADModel` gains `decay: bool = False`. Existing default behavior
(`signal_window_days=4`, no decay) is unchanged. With the paper mandate's
`signal_window_days=45, decay=True`, the signal is
`±1 × (1 − age_days / signal_window_days)` for events within the window, so
a weekly rebalance sees each surprise for ~6 weeks at fading conviction
instead of missing most of them.

## 7. Backlog (evidence-gated; not in this build)

Each becomes an opt-in config, is backtested against the section 4 baseline,
and is adopted only if it improves post-cost risk-adjusted results:

2. Momentum model (12-1 month).
3. Inverse-volatility position sizing.
4. Beta-neutral long/short sleeves (hedge residual beta with SPY).
5. Regime filter (SPY < 200-day MA or volatility spike → cut gross).
6. Dynamic strategy allocator (after ≥ 6 months of paper history).

## 8. Error handling summary

| Failure | Behavior |
|---|---|
| Non-paper URL configured | `AlpacaPaperClient` raises at construction |
| FD / LLM infrastructure error during planning | Abort submit before any order; notify |
| Ticker lacks a close | Skipped via existing skip logic; logged |
| Order rejected (not shortable, etc.) | Recorded as rejected; other orders proceed; next rebalance re-plans from actual positions |
| Partial fill / unfilled MOC | Recorded at reconcile; next rebalance corrects |
| Ledger vs Alpaca position mismatch | Warning; Alpaca wins |
| Re-run same day | `already_submitted`; reconcile rewrites same row |
| Drawdown ≥ 15% from peak | `HALTED` written; flatten; manual resume by deleting file |

## 9. Testing

- `plan_rebalance`: sizing vs reference marks, sells-before-buys, implicit
  close of held names, projected-cap violations raise — with a fake data
  client and stub fund (existing test-double pattern).
- `runner.submit`: every guard (kill, non-trading day, too late, already
  submitted, drawdown breach → flatten, halted-and-flat, halted-with-positions
  → re-flatten, non-rebalance day), dry-run sends nothing,
  client-order-id format — with a fake Alpaca client.
- `AlpacaPaperClient`: URL guard; request/response mapping against recorded
  JSON fixtures (no network in tests).
- `reconcile`: fills/slippage math, idempotent `nav.csv` row.
- Costs: commission and borrow arithmetic in `SimBroker`; zero-cost default
  leaves existing backtest tests unchanged.
- PEAD decay values and unchanged default behavior.
- Manual acceptance: `aihf-paper submit --dry-run` against the user's paper
  account prints a sane plan before the schedule is installed.
