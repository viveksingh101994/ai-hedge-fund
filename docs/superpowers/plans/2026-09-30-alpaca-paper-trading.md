# Alpaca Paper Trading + Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the existing fund forward on an Alpaca **paper** account with backtest-identical (next-close) execution, and measure honestly — with costs and pre-committed baselines — whether it adds value.

**Architecture:** A new `hedge_fund/live/` package reuses the engine's `assess_fund` → risk → `build_orders` path but sizes against Alpaca's real book and submits market-on-close orders; a reconcile step records fills and daily NAV into a file ledger under `~/.hedge-fund/paper/<fund>/`. The backtester gains commission/borrow costs, a trivial equal-weight model gives a same-engine benchmark, and PEAD gains a decaying holding window so it works at weekly cadence.

**Tech Stack:** Python 3.12, pydantic v2, requests (Alpaca REST), pytest, macOS launchd.

**Spec:** `docs/superpowers/specs/2026-09-30-alpaca-paper-trading-design.md`

**Test command:** `.venv/bin/python -m pytest <path> -q` (a uv venv with `pip install -e . pytest` exists at `.venv/`; `poetry run pytest` is equivalent).

**Deviations from spec (decided while planning):**
- Reconcile targets the most recent completed session only (no `--date`): equity is computed as Alpaca cash + positions × that session's close, which is only true before the next MOC fills land. `session_to_reconcile` refuses after 15:50 ET on a trading day.
- `nav.csv` column is `benchmark_close` (the mandate's benchmark), not `spy_close`.
- `reconcile` takes a `FundSpec`, not a `Fund` (it needs no models).
- `--dry-run` bypasses the calendar/time/rebalance-day guards (it never sends anything), so the plan can be inspected any day. It never writes `HALTED`.
- `flatten` works by writing `HALTED` then running `submit`; `resume` deletes `HALTED`.
- Alpaca `/v2/clock` is not used; the calendar endpoint answers everything.

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `hedge_fund/fund/spec.py` | modify | `CostModel`; `FundSpec.costs` |
| `hedge_fund/brokers/sim.py` | modify | commission on fills, `accrue_borrow`, `costs()` |
| `hedge_fund/backtesting/fund.py` | modify | wire costs into `backtest_fund`; `total_costs` metric |
| `hedge_fund/signals/pead.py` | modify | `decay` option |
| `hedge_fund/signals/equal_weight.py` | create | equal-weight benchmark model |
| `hedge_fund/signals/__init__.py` | modify | register `equal_weight` |
| `hedge_fund/pipeline/run_cycle.py` | modify | extract `check_projected_book` |
| `hedge_fund/paths.py` | modify | `PAPER_DIR`, `KILL_PATH` |
| `hedge_fund/brokers/alpaca.py` | create | paper-only Alpaca REST client |
| `hedge_fund/live/__init__.py` | create | package exports |
| `hedge_fund/live/calendar.py` | create | rebalance-day rule, MOC cutoff, order-id prefix |
| `hedge_fund/live/ledger.py` | create | plans / fills / nav.csv / HALTED / logs |
| `hedge_fund/live/plan.py` | create | `plan_rebalance` → `LivePlan` |
| `hedge_fund/live/runner.py` | create | `submit`, `reconcile`, `session_to_reconcile` |
| `hedge_fund/live/report.py` | create | paper metrics, backtest comparison, attribution |
| `hedge_fund/live/baseline.py` | create | fund / per-strategy / equal-weight backtests + verdict flags |
| `hedge_fund/live/launchd.py` | create | LaunchAgent plists, install/uninstall, `notify` |
| `hedge_fund/live/cli.py` | create | `aihf-paper` entry point |
| `hedge_fund/fund/paper.yaml` | create | paper mandate |
| `hedge_fund/fund/paper_universe.txt` | create | 32-name universe |
| `pyproject.toml`, `.env.example`, `README.md`, `ROADMAP.md` | modify | script entry, keys, docs |

Tests live beside the code as `test_*.py` (project convention).

---

### Task 1: Transaction and borrow costs in the backtester

**Files:**
- Modify: `hedge_fund/fund/spec.py`
- Modify: `hedge_fund/brokers/sim.py`
- Modify: `hedge_fund/backtesting/fund.py`
- Test: `hedge_fund/brokers/test_sim.py`, `hedge_fund/backtesting/test_fund.py`

- [ ] **Step 1: Write failing SimBroker tests** — append to `hedge_fund/brokers/test_sim.py`:

```python
def test_commission_charged_on_every_fill():
    broker = SimBroker(cash=10_000.0, commission_bps=10)
    broker.place_order(Order(ticker="AAPL", side="buy", quantity=10, price=100.0))
    assert broker.cash() == pytest.approx(10_000.0 - 1_000.0 - 1.0)
    broker.place_order(Order(ticker="AAPL", side="sell", quantity=10, price=100.0))
    assert broker.cash() == pytest.approx(10_000.0 - 2.0)
    assert broker.costs() == pytest.approx(2.0)


def test_default_is_cost_free():
    broker = SimBroker(cash=10_000.0)
    broker.place_order(Order(ticker="AAPL", side="buy", quantity=10, price=100.0))
    assert broker.costs() == 0.0


def test_borrow_accrues_on_shorts_only():
    broker = SimBroker(cash=0.0)
    broker.place_order(Order(ticker="AAPL", side="sell", quantity=10, price=100.0))
    broker.place_order(Order(ticker="MSFT", side="buy", quantity=10, price=100.0))
    fee = broker.accrue_borrow({"AAPL": 100.0, "MSFT": 100.0}, days=365, borrow_bps_annual=100)
    assert fee == pytest.approx(10.0)          # 1% of $1,000 short notional
    assert broker.cash() == pytest.approx(-10.0)
    assert broker.costs() == pytest.approx(10.0)
```

- [ ] **Step 2: Write failing backtest tests** — append to `hedge_fund/backtesting/test_fund.py`:

```python
def test_commission_reduces_nav_from_the_execution_close():
    spec = _spec(costs={"commission_bps": 10})
    fund = Fund(spec, models={"solo": [FakeAnalyst("a", views={"AAPL": 1.0})]})
    result = backtest_fund(fund, "2024-06-03", "2024-06-14", FakeDataClient(SERIES), ["AAPL"])
    # Buy 500 @ 200 on Mon 06-10 costs 10 bps of $100k = $100.
    assert result.nav == [100_000.0] * 5 + [99_900.0] * 4 + [104_900.0]
    assert result.metrics.total_costs == pytest.approx(100.0)


def test_borrow_accrues_daily_on_short_book():
    spec = _spec(costs={"borrow_bps_annual": 365})  # 1 bp per calendar day
    fund = Fund(spec, models={"solo": [FakeAnalyst("a", views={"AAPL": -1.0})]})
    result = backtest_fund(fund, "2024-06-03", "2024-06-14", FakeDataClient(SERIES), ["AAPL"])
    # Short 500 opened at Mon 06-10 close; charged Tue–Thu on $100k (3 × $10)
    # and Fri on $105k ($10.50).
    assert result.metrics.total_costs == pytest.approx(40.5)
    assert result.nav[-1] == pytest.approx(200_000.0 - 40.5 - 105_000.0)


def test_costs_default_to_zero():
    assert _run().metrics.total_costs == 0.0
```

- [ ] **Step 3: Run to verify failures**

Run: `.venv/bin/python -m pytest hedge_fund/brokers/test_sim.py hedge_fund/backtesting/test_fund.py -q`
Expected: FAIL (`unexpected keyword argument 'commission_bps'`, `costs` extra field forbidden, no `total_costs`).

- [ ] **Step 4: Add `CostModel` to `hedge_fund/fund/spec.py`** — insert before `class FundSpec`:

```python
class CostModel(BaseModel):
    """Trading frictions the backtester charges. Zero by default, so existing
    mandates replay exactly as before; the paper mandate sets real numbers."""

    model_config = ConfigDict(extra="forbid")

    commission_bps: float = Field(default=0.0, ge=0, description="per-side cost of every fill, in bps of notional (commission + spread + impact)")
    borrow_bps_annual: float = Field(default=0.0, ge=0, description="annual fee on short notional, in bps")
```

and add to `FundSpec`, after `benchmark`:

```python
    costs: CostModel = Field(default_factory=CostModel, description="frictions charged by the backtester")
```

Also export it: in `hedge_fund/fund/__init__.py` add `CostModel,` to the import list and `"CostModel",` to `__all__`.

- [ ] **Step 5: Update `hedge_fund/brokers/sim.py`** — replace the class body's `__init__` and `place_order`, and add two methods:

```python
    def __init__(self, cash: float, commission_bps: float = 0.0) -> None:
        self._cash = cash
        self._shares: dict[str, int] = {}
        self._commission_rate = commission_bps / 10_000
        self._costs = 0.0

    def positions(self) -> dict[str, Position]:
        return {
            t: Position(ticker=t, shares=s)
            for t, s in self._shares.items()
            if s != 0
        }

    def cash(self) -> float:
        return self._cash

    def costs(self) -> float:
        """Total commission and borrow charged so far, in dollars."""
        return self._costs

    def place_order(self, order: Order) -> Fill:
        if not isfinite(order.price) or order.price <= 0:
            raise ValueError(
                f"cannot fill {order.ticker} at price {order.price} — "
                "the caller must price every order"
            )

        if order.side == "buy":
            self._shares[order.ticker] = self._shares.get(order.ticker, 0) + order.quantity
            self._cash -= order.quantity * order.price
        else:
            self._shares[order.ticker] = self._shares.get(order.ticker, 0) - order.quantity
            self._cash += order.quantity * order.price
        self._charge(order.quantity * order.price * self._commission_rate)

        if self._shares[order.ticker] == 0:
            del self._shares[order.ticker]

        return Fill(
            ticker=order.ticker,
            side=order.side,
            quantity=order.quantity,
            price=order.price,
        )

    def accrue_borrow(self, marks: dict[str, float], days: int, borrow_bps_annual: float) -> float:
        """Charge the borrow fee on every short for `days` calendar days at
        `marks`; returns the fee. `marks` must price every short."""
        short_notional = sum(-s * marks[t] for t, s in self._shares.items() if s < 0)
        fee = short_notional * borrow_bps_annual / 10_000 * days / 365
        self._charge(fee)
        return fee

    def _charge(self, fee: float) -> None:
        self._cash -= fee
        self._costs += fee
```

Update the module docstring sentence "Slippage/costs are a declared future addition inside place_order, where they change fills without touching the pipeline." to: "Costs (a per-fill commission and a short-borrow accrual) come out of cash; fill prices stay exact so replays remain deterministic."

- [ ] **Step 6: Wire costs into `hedge_fund/backtesting/fund.py`**

In `FundBacktestMetrics` add after `n_pending`:

```python
    total_costs: float = 0.0          # commission + borrow charged, dollars
```

Change `performance_metrics` signature and return:

```python
def performance_metrics(
    capital: float,
    dates: list[str],
    nav: list[float],
    benchmark_nav: list[float],
    records: list[CycleRecord],
    n_pending: int = 0,
    total_costs: float = 0.0,
) -> FundBacktestMetrics:
```

and add `total_costs=round(total_costs, 2),` to the `FundBacktestMetrics(...)` call.

In `backtest_fund`, replace `broker = SimBroker(cash=spec.capital)` with:

```python
    broker = SimBroker(cash=spec.capital, commission_bps=spec.costs.commission_bps)
```

and at the top of the `for i, session in enumerate(dates):` body, before `if session in due:`, insert:

```python
        if i > 0 and spec.costs.borrow_bps_annual > 0:
            # Shorts held since the previous close pay borrow for the calendar days in between.
            shorts = [t for t, p in broker.positions().items() if p.shares < 0]
            if shorts:
                days = (_date.fromisoformat(session) - _date.fromisoformat(dates[i - 1])).days
                broker.accrue_borrow(exact_marks(shorts, session, data_client), days, spec.costs.borrow_bps_annual)
```

and in the `return FundBacktestResult(...)` change the metrics line to:

```python
        metrics=performance_metrics(spec.capital, dates, nav, benchmark_nav, records, len(pending), broker.costs()),
```

- [ ] **Step 7: Run tests**

Run: `.venv/bin/python -m pytest hedge_fund -q`
Expected: all pass (previous 571 + 6 new).

- [ ] **Step 8: Commit**

```bash
git add hedge_fund/fund/spec.py hedge_fund/fund/__init__.py hedge_fund/brokers/sim.py hedge_fund/brokers/test_sim.py hedge_fund/backtesting/fund.py hedge_fund/backtesting/test_fund.py
git commit -m "Charge commission and short borrow in backtests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: PEAD decaying holding window

**Files:**
- Modify: `hedge_fund/signals/pead.py`
- Test: `hedge_fund/signals/test_signals.py`

- [ ] **Step 1: Write failing tests** — append inside `class TestPEADPredict` in `hedge_fund/signals/test_signals.py`:

```python
    def test_decay_holds_the_view_and_fades_it(self):
        fd = MockFDClient([_rec("2025-06-30", "2025-08-01", "BEAT")])
        model = PEADModel(signal_window_days=45, decay=True)
        assert model.predict("TEST", "2025-08-01", fd).value == 1.0
        assert model.predict("TEST", "2025-08-10", fd).value == pytest.approx(0.8)
        assert model.predict("TEST", "2025-09-16", fd).value == 0.0   # 46 days: outside the window

    def test_decay_applies_to_misses(self):
        fd = MockFDClient([_rec("2025-06-30", "2025-08-01", "MISS")])
        sig = PEADModel(signal_window_days=45, decay=True).predict("TEST", "2025-08-10", fd)
        assert sig.value == pytest.approx(-0.8)
        assert sig.metadata["age_days"] == 9

    def test_decay_requires_positive_window(self):
        with pytest.raises(ValueError, match="signal_window_days"):
            PEADModel(signal_window_days=0, decay=True)
```

and add `import pytest` to the file's imports.

- [ ] **Step 2: Run to verify failure**

Run: `.venv/bin/python -m pytest hedge_fund/signals/test_signals.py -q`
Expected: FAIL with `unexpected keyword argument 'decay'`.

- [ ] **Step 3: Implement** — in `hedge_fund/signals/pead.py`:

Extend the class docstring with:

```
    With ``decay=True`` the view is held for the whole window and fades
    linearly with the event's age: ``±(1 - age_days / signal_window_days)``.
    Drift plays out over weeks, so a weekly rebalance needs a window that
    long to see most announcements at all.
```

Change `__init__`:

```python
    def __init__(
        self,
        *,
        earnings_limit: int = 8,
        signal_window_days: int = 4,
        announcement_only: bool = True,
        decay: bool = False,
    ) -> None:
        if decay and signal_window_days <= 0:
            raise ValueError("decay needs a positive signal_window_days")
        self._earnings_limit = earnings_limit
        self._signal_window_days = signal_window_days
        self._announcement_only = announcement_only
        self._decay = decay
```

In `predict`, replace from `# Only fire if the event is fresh` through the `return Signal(` block with:

```python
        # Only fire if the event is fresh (we just learned about it)
        age_days = (as_of - filed).days
        if age_days > self._signal_window_days:
            return self._neutral(ticker, date)

        surprise = event["surprise"]
        value = 1.0 if surprise == "BEAT" else -1.0
        if self._decay:
            value *= 1 - age_days / self._signal_window_days
        return Signal(
            model_name=self.name,
            ticker=ticker,
            date=date,
            value=value,
            reasoning=(
                f"{surprise} on {event['report_period']} earnings "
                f"(filed {event['filing_date']}, {event['source_type']})"
            ),
            metadata={
                "eps_surprise": surprise,
                "source_type": event["source_type"],
                "report_period": event["report_period"],
                "filing_date": event["filing_date"],
                "age_days": age_days,
            },
        )
```

- [ ] **Step 4: Run tests**

Run: `.venv/bin/python -m pytest hedge_fund/signals -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hedge_fund/signals/pead.py hedge_fund/signals/test_signals.py
git commit -m "Let PEAD hold a fading view across a weekly rebalance

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Equal-weight benchmark model

**Files:**
- Create: `hedge_fund/signals/equal_weight.py`
- Modify: `hedge_fund/signals/__init__.py`
- Test: `hedge_fund/signals/test_signals.py`

- [ ] **Step 1: Write failing test** — append to `hedge_fund/signals/test_signals.py`:

```python
class TestEqualWeight:
    def test_full_long_view_on_every_name(self):
        from hedge_fund.signals import ALPHA_MODEL_REGISTRY, get_investment_approach
        from hedge_fund.signals.equal_weight import EqualWeightModel
        sig = EqualWeightModel().predict("ANY", "2025-01-02", data_client=None)
        assert (sig.model_name, sig.ticker, sig.value) == ("equal_weight", "ANY", 1.0)
        assert ALPHA_MODEL_REGISTRY["equal_weight"] is EqualWeightModel
        assert get_investment_approach("equal_weight") == "long_only"
```

- [ ] **Step 2: Run to verify failure**

Run: `.venv/bin/python -m pytest hedge_fund/signals/test_signals.py -q -k EqualWeight`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Create `hedge_fund/signals/equal_weight.py`**

```python
"""Equal-weight benchmark — the same full long view on every name.

Not an alpha model anyone should trade for edge: it is the yardstick. Run
through the identical engine (same risk caps, costs and cadence), it answers
"did the analysts beat simply owning the universe?" — a sharper question for
a large-cap book than beating SPY.
"""

from __future__ import annotations

from hedge_fund.data.protocol import DataClient
from hedge_fund.models import Signal
from hedge_fund.signals.base import QuantModel


class EqualWeightModel(QuantModel):
    investment_approach = "long_only"

    @property
    def name(self) -> str:
        return "equal_weight"

    def predict(self, ticker: str, date: str, data_client: DataClient) -> Signal:
        return Signal(model_name=self.name, ticker=ticker, date=date, value=1.0,
                      reasoning="equal-weight benchmark")
```

- [ ] **Step 4: Register it** — in `hedge_fund/signals/__init__.py` add `from hedge_fund.signals.equal_weight import EqualWeightModel`, add `"equal_weight": EqualWeightModel,` under `# Quant models` in `ALPHA_MODEL_REGISTRY`, add below the registry:

```python
# Registered so the engine can run them, but yardsticks, not analysts: the
# fund builder does not offer them as staff.
BENCHMARK_MODELS = frozenset({"equal_weight"})
```

and add `"EqualWeightModel",` and `"BENCHMARK_MODELS",` to `__all__`.

- [ ] **Step 5: Hide it from the TUI's staff picker** — in `hedge_fund/tui/app.py`, change the import on line 61 to `from hedge_fund.signals import ALPHA_MODEL_REGISTRY, BENCHMARK_MODELS, get_investment_approach, LLMAgent`, and in the `step-agents` `SelectionList` (around line 1430) change the generator to:

```python
                            for key, cls in ALPHA_MODEL_REGISTRY.items()
                            if key not in BENCHMARK_MODELS
```

Add to `TestEqualWeight` in `hedge_fund/signals/test_signals.py`:

```python
    def test_marked_as_benchmark(self):
        from hedge_fund.signals import BENCHMARK_MODELS
        assert "equal_weight" in BENCHMARK_MODELS
```

- [ ] **Step 6: Run tests**

Run: `.venv/bin/python -m pytest hedge_fund -q`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add hedge_fund/signals/equal_weight.py hedge_fund/signals/__init__.py hedge_fund/signals/test_signals.py hedge_fund/tui/app.py
git commit -m "Add an equal-weight benchmark model

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Extract `check_projected_book` for reuse

**Files:**
- Modify: `hedge_fund/pipeline/run_cycle.py`
- Test: `hedge_fund/pipeline/test_execution.py`

- [ ] **Step 1: Write failing test** — append to `hedge_fund/pipeline/test_execution.py`:

```python
def test_check_projected_book_enforces_caps():
    import pytest
    from hedge_fund.brokers.models import Order
    from hedge_fund.pipeline.run_cycle import check_projected_book
    from hedge_fund.risk.limits import RiskLimits

    limits = RiskLimits(max_position_pct=0.5, max_gross_exposure=1.0)
    marks = {"A": 100.0, "B": 100.0}
    ok = [Order(ticker="A", side="buy", quantity=500, price=100.0)]
    check_projected_book(ok, {}, marks, 100_000.0, limits)
    too_big = [Order(ticker="A", side="buy", quantity=600, price=100.0)]
    with pytest.raises(ValueError, match="max_position_pct"):
        check_projected_book(too_big, {}, marks, 100_000.0, limits)
    too_gross = [Order(ticker="A", side="buy", quantity=500, price=100.0),
                 Order(ticker="B", side="sell", quantity=500, price=100.0)]
    with pytest.raises(ValueError, match="max_gross_exposure"):
        check_projected_book(too_gross, {"A": 100}, marks, 100_000.0, limits)
```

- [ ] **Step 2: Run to verify failure**

Run: `.venv/bin/python -m pytest hedge_fund/pipeline/test_execution.py -q`
Expected: FAIL with `ImportError: cannot import name 'check_projected_book'`.

- [ ] **Step 3: Implement** — in `hedge_fund/pipeline/run_cycle.py` add `from hedge_fund.risk.limits import RiskLimits` beside the `apply_limits` import, and add this public function after `exact_marks`:

```python
def check_projected_book(
    orders: list[Order], held: dict[str, int], marks: dict[str, float],
    equity: float, limits: RiskLimits,
) -> None:
    """Raise if the book after these orders would breach the fund's hard limits."""
    projected = dict(held)
    for order in orders:
        projected[order.ticker] = projected.get(order.ticker, 0) + (
            order.quantity if order.side == "buy" else -order.quantity
        )
    weights = {t: shares * marks[t] / equity for t, shares in projected.items()}
    for ticker, weight in weights.items():
        if not isfinite(weight) or abs(weight) > limits.max_position_pct + WEIGHT_TOLERANCE:
            raise ValueError(f"{ticker}: projected position violates max_position_pct")
    if sum(abs(w) for w in weights.values()) > limits.max_gross_exposure + WEIGHT_TOLERANCE:
        raise ValueError("projected portfolio violates max_gross_exposure")
```

Import `Order` next to `Fill`: `from hedge_fund.brokers.models import Fill, Order`.

In `execute_decision`, replace the block from `projected = {t: p.shares for t, p in held.items()}` through `raise ValueError("projected portfolio violates max_gross_exposure")` with:

```python
    check_projected_book(orders, {t: p.shares for t, p in held.items()}, marks, equity_before, spec.risk)
```

- [ ] **Step 4: Run tests**

Run: `.venv/bin/python -m pytest hedge_fund -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hedge_fund/pipeline/run_cycle.py hedge_fund/pipeline/test_execution.py
git commit -m "Extract the projected-book risk check for reuse

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Paper-only Alpaca client

**Files:**
- Create: `hedge_fund/brokers/alpaca.py`
- Test: `hedge_fund/brokers/test_alpaca.py`

- [ ] **Step 1: Write failing tests** — create `hedge_fund/brokers/test_alpaca.py`:

```python
"""AlpacaPaperClient tests — a fake requests session, no network."""

import json

import pytest

from hedge_fund.brokers.alpaca import PAPER_BASE_URL, AlpacaError, AlpacaPaperClient


class FakeResponse:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload
        self.text = json.dumps(payload)

    def json(self):
        return self._payload


class FakeSession:
    def __init__(self, *responses):
        self.headers = {}
        self.calls = []
        self._responses = list(responses)

    def request(self, method, url, params=None, json=None, timeout=None):
        self.calls.append({"method": method, "url": url, "params": params, "json": json})
        return self._responses.pop(0)


def _client(*responses):
    session = FakeSession(*responses)
    return AlpacaPaperClient("key", "secret", session=session), session


def test_refuses_any_non_paper_endpoint():
    with pytest.raises(ValueError, match="paper"):
        AlpacaPaperClient("key", "secret", base_url="https://api.alpaca.markets", session=FakeSession())


def test_requires_keys(monkeypatch):
    monkeypatch.delenv("APCA_API_KEY_ID", raising=False)
    monkeypatch.delenv("APCA_API_SECRET_KEY", raising=False)
    with pytest.raises(ValueError, match="APCA_API_KEY_ID"):
        AlpacaPaperClient(session=FakeSession())


def test_sends_auth_headers_to_paper_host():
    client, session = _client(FakeResponse(payload={"cash": "10.5", "equity": "20", "last_equity": "19", "status": "ACTIVE"}))
    account = client.account()
    assert (account.cash, account.equity, account.last_equity, account.status) == (10.5, 20.0, 19.0, "ACTIVE")
    assert session.headers == {"APCA-API-KEY-ID": "key", "APCA-API-SECRET-KEY": "secret"}
    assert session.calls[0]["url"] == f"{PAPER_BASE_URL}/v2/account"


def test_positions_are_signed():
    client, _ = _client(FakeResponse(payload=[
        {"symbol": "AAPL", "qty": "10", "side": "long"},
        {"symbol": "TSLA", "qty": "-4", "side": "short"},
    ]))
    assert client.positions() == {"AAPL": 10, "TSLA": -4}


def test_calendar_returns_sorted_session_dates():
    client, session = _client(FakeResponse(payload=[{"date": "2024-06-10"}, {"date": "2024-06-07"}]))
    assert client.calendar("2024-06-01", "2024-06-10") == ["2024-06-07", "2024-06-10"]
    assert session.calls[0]["params"] == {"start": "2024-06-01", "end": "2024-06-10"}


def test_submit_moc_sends_market_on_close():
    client, session = _client(FakeResponse(payload={
        "id": "o1", "client_order_id": "f-2024-06-10-AAPL", "symbol": "AAPL", "side": "buy",
        "qty": "5", "filled_qty": "0", "filled_avg_price": None, "status": "accepted",
    }))
    result = client.submit_moc("AAPL", "buy", 5, "f-2024-06-10-AAPL")
    assert session.calls[0]["json"] == {
        "symbol": "AAPL", "qty": "5", "side": "buy", "type": "market",
        "time_in_force": "cls", "client_order_id": "f-2024-06-10-AAPL",
    }
    assert (result.status, result.order_id, result.quantity, result.filled_qty) == ("accepted", "o1", 5, 0)


def test_refused_order_is_a_rejection_not_a_crash():
    client, _ = _client(FakeResponse(422, {"message": "asset not shortable"}))
    result = client.submit_moc("XYZ", "sell", 5, "f-2024-06-10-XYZ")
    assert result.status == "rejected"
    assert "not shortable" in result.reason


def test_server_error_raises():
    client, _ = _client(FakeResponse(500, {"message": "boom"}))
    with pytest.raises(AlpacaError) as exc:
        client.positions()
    assert exc.value.status_code == 500


def test_list_orders_maps_fills():
    client, session = _client(FakeResponse(payload=[{
        "id": "o1", "client_order_id": "c1", "symbol": "AAPL", "side": "sell",
        "qty": "5", "filled_qty": "5", "filled_avg_price": "101.25", "status": "filled",
    }]))
    [order] = client.list_orders(after="2024-06-10T00:00:00-04:00")
    assert (order.filled_qty, order.filled_avg_price, order.side) == (5, 101.25, "sell")
    assert session.calls[0]["params"]["status"] == "all"
```

- [ ] **Step 2: Run to verify failure**

Run: `.venv/bin/python -m pytest hedge_fund/brokers/test_alpaca.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'hedge_fund.brokers.alpaca'`.

- [ ] **Step 3: Implement** — create `hedge_fund/brokers/alpaca.py`:

```python
"""Alpaca paper-trading client — the fund's link to a simulated brokerage account.

Paper only, by construction: the one base URL this module knows is Alpaca's
paper endpoint, and the constructor refuses any other. There is no live-money
URL anywhere in the codebase.

Deliberately not a `Broker`: the protocol promises a complete fill or a raise,
and a market-on-close order fills hours after it is submitted. The live path
is submit-then-reconcile instead (hedge_fund/live/runner.py).
"""

from __future__ import annotations

import os
from typing import Any, Literal

import requests
from pydantic import BaseModel

PAPER_BASE_URL = "https://paper-api.alpaca.markets"

# Alpaca answers a refused order with 403 (e.g. buying power) or 422 (e.g.
# not shortable). Those are rejections to record, not crashes.
_REJECTION_CODES = (403, 422)


class AlpacaError(Exception):
    """An Alpaca request failed (auth, network, server error, bad request)."""

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class Account(BaseModel):
    cash: float
    equity: float
    last_equity: float
    status: str


class OrderResult(BaseModel):
    """What Alpaca did with one order: accepted (with its current status) or rejected."""

    client_order_id: str
    ticker: str
    side: Literal["buy", "sell"]
    quantity: int
    status: str                          # Alpaca's order status, or "rejected"
    order_id: str | None = None
    filled_qty: int = 0
    filled_avg_price: float | None = None
    reason: str | None = None


class AlpacaPaperClient:
    """Thin REST client for the handful of paper-account endpoints the fund needs."""

    def __init__(
        self,
        key_id: str | None = None,
        secret_key: str | None = None,
        *,
        base_url: str = PAPER_BASE_URL,
        timeout: float = 30.0,
        session: requests.Session | None = None,
    ) -> None:
        if base_url.rstrip("/") != PAPER_BASE_URL:
            raise ValueError(f"refusing Alpaca endpoint {base_url!r}: only {PAPER_BASE_URL} (paper trading) is allowed")
        key_id = key_id or os.environ.get("APCA_API_KEY_ID", "")
        secret_key = secret_key or os.environ.get("APCA_API_SECRET_KEY", "")
        if not key_id or not secret_key:
            raise ValueError("set APCA_API_KEY_ID and APCA_API_SECRET_KEY (Alpaca paper keys) in ~/.hedge-fund/.env")
        self._timeout = timeout
        self._session = session or requests.Session()
        self._session.headers.update({"APCA-API-KEY-ID": key_id, "APCA-API-SECRET-KEY": secret_key})

    def account(self) -> Account:
        row = self._request("GET", "/v2/account")
        return Account(cash=float(row["cash"]), equity=float(row["equity"]),
                       last_equity=float(row["last_equity"]), status=row["status"])

    def positions(self) -> dict[str, int]:
        """Signed whole shares per ticker. Negative = short."""
        held: dict[str, int] = {}
        for row in self._request("GET", "/v2/positions"):
            shares = abs(int(float(row["qty"])))
            if shares:
                held[row["symbol"]] = -shares if row.get("side") == "short" else shares
        return held

    def calendar(self, start: str, end: str) -> list[str]:
        """Trading-session dates (YYYY-MM-DD) in [start, end]."""
        rows = self._request("GET", "/v2/calendar", params={"start": start, "end": end})
        return sorted(row["date"] for row in rows)

    def list_orders(self, after: str) -> list[OrderResult]:
        """Every order (any status) submitted after the ISO timestamp `after`."""
        rows = self._request("GET", "/v2/orders", params={
            "status": "all", "after": after, "limit": 500, "direction": "asc",
        })
        return [_order_result(row) for row in rows]

    def submit_moc(self, ticker: str, side: Literal["buy", "sell"], quantity: int, client_order_id: str) -> OrderResult:
        """Submit a market-on-close order. A refused order comes back as status "rejected"."""
        body = {
            "symbol": ticker, "qty": str(quantity), "side": side, "type": "market",
            "time_in_force": "cls", "client_order_id": client_order_id,
        }
        try:
            row = self._request("POST", "/v2/orders", json=body)
        except AlpacaError as exc:
            if exc.status_code in _REJECTION_CODES:
                return OrderResult(client_order_id=client_order_id, ticker=ticker, side=side,
                                   quantity=quantity, status="rejected", reason=str(exc))
            raise
        return _order_result(row)

    def _request(self, method: str, path: str, *, params: dict | None = None, json: dict | None = None) -> Any:
        try:
            resp = self._session.request(method, PAPER_BASE_URL + path, params=params, json=json, timeout=self._timeout)
        except requests.RequestException as exc:
            raise AlpacaError(f"{method} {path}: {exc}") from exc
        if resp.status_code >= 400:
            raise AlpacaError(f"{method} {path}: HTTP {resp.status_code}: {resp.text[:300]}", status_code=resp.status_code)
        return resp.json()


def _order_result(row: dict) -> OrderResult:
    avg = row.get("filled_avg_price")
    return OrderResult(
        client_order_id=row["client_order_id"],
        ticker=row["symbol"],
        side=row["side"],
        quantity=int(float(row.get("qty") or 0)),
        status=row["status"],
        order_id=row.get("id"),
        filled_qty=int(float(row.get("filled_qty") or 0)),
        filled_avg_price=float(avg) if avg is not None else None,
    )
```

- [ ] **Step 4: Run tests**

Run: `.venv/bin/python -m pytest hedge_fund/brokers -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hedge_fund/brokers/alpaca.py hedge_fund/brokers/test_alpaca.py
git commit -m "Add a paper-only Alpaca REST client

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Live calendar rules and paths

**Files:**
- Modify: `hedge_fund/paths.py`
- Create: `hedge_fund/live/__init__.py` (empty docstring for now), `hedge_fund/live/calendar.py`
- Test: `hedge_fund/live/test_calendar.py`

- [ ] **Step 1: Add paths** — append to `hedge_fund/paths.py` after `ENV_PATH`:

```python
PAPER_DIR = USER_DIR / "paper"   # one ledger directory per paper fund
KILL_PATH = USER_DIR / "KILL"    # exists → the paper runner sends nothing
```

- [ ] **Step 2: Write failing tests** — create `hedge_fund/live/__init__.py` containing only `"""Live (paper) trading: plan, submit, reconcile, report."""`, then `hedge_fund/live/test_calendar.py`:

```python
import pytest

from hedge_fund.live.calendar import client_order_prefix, is_rebalance_day, ny_midnight


@pytest.mark.parametrize("session, previous, expected", [
    ("2024-06-10", "2024-06-07", True),    # Monday after Friday
    ("2024-06-11", "2024-06-10", False),   # Tuesday after Monday
    ("2024-05-28", "2024-05-24", True),    # Tuesday after Memorial Day weekend
    ("2025-01-02", "2024-12-31", False),   # same ISO week across New Year
])
def test_weekly_rebalances_on_first_session_of_iso_week(session, previous, expected):
    assert is_rebalance_day(session, previous, "weekly") is expected


def test_daily_and_monthly():
    assert is_rebalance_day("2024-06-11", "2024-06-10", "daily") is True
    assert is_rebalance_day("2025-01-02", "2024-12-31", "monthly") is True
    assert is_rebalance_day("2024-06-11", "2024-06-10", "monthly") is False
    with pytest.raises(ValueError, match="cadence"):
        is_rebalance_day("2024-06-11", "2024-06-10", "hourly")


def test_helpers():
    assert ny_midnight("2024-06-10") == "2024-06-10T00:00:00-04:00"
    assert client_order_prefix("paper-fund", "2024-06-10") == "paper-fund-2024-06-10-"
```

- [ ] **Step 3: Run to verify failure**

Run: `.venv/bin/python -m pytest hedge_fund/live/test_calendar.py -q`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 4: Implement** — create `hedge_fund/live/calendar.py`:

```python
"""When the paper fund trades — the backtest's cadence, restated for live sessions.

The backtester assesses on the last session of each period and executes at
the next session's close. Live, the same rule reads: execute on the first
session of a new period, with data through the previous one.
"""

from __future__ import annotations

from datetime import date, datetime, time

from hedge_fund.data.sessions import NEW_YORK

# Alpaca stops accepting market-on-close orders at 15:50 ET; keep a margin.
MOC_CUTOFF = time(15, 45)


def is_rebalance_day(session: str, previous_session: str, cadence: str) -> bool:
    """True when `session` opens a new rebalance period relative to the previous session."""
    today, prev = date.fromisoformat(session), date.fromisoformat(previous_session)
    if cadence == "daily":
        return True
    if cadence == "weekly":
        return today.isocalendar()[:2] != prev.isocalendar()[:2]
    if cadence == "monthly":
        return (today.year, today.month) != (prev.year, prev.month)
    raise ValueError(f"unknown rebalance cadence {cadence!r}")


def ny_midnight(session: str) -> str:
    """Start of `session` in New York, as an ISO timestamp for order queries."""
    return datetime.combine(date.fromisoformat(session), time(0), NEW_YORK).isoformat()


def client_order_prefix(fund_name: str, session: str) -> str:
    """Every order a fund sends on a session starts with this; the ticker completes it."""
    return f"{fund_name}-{session}-"
```

- [ ] **Step 5: Run tests**

Run: `.venv/bin/python -m pytest hedge_fund/live -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add hedge_fund/paths.py hedge_fund/live/__init__.py hedge_fund/live/calendar.py hedge_fund/live/test_calendar.py
git commit -m "Add live rebalance-day rule and paper paths

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Ledger

**Files:**
- Create: `hedge_fund/live/ledger.py`
- Test: `hedge_fund/live/test_ledger.py`

- [ ] **Step 1: Write failing tests** — create `hedge_fund/live/test_ledger.py`:

```python
from hedge_fund.live.ledger import Ledger, NavRow


def nav(day, equity, benchmark=500.0):
    return NavRow(date=day, equity=equity, cash=equity, long_exposure=0.0,
                  short_exposure=0.0, gross=0.0, benchmark_close=benchmark)


def test_nav_upsert_is_idempotent_and_sorted(tmp_path):
    ledger = Ledger(tmp_path)
    ledger.upsert_nav(nav("2024-06-11", 101.0))
    ledger.upsert_nav(nav("2024-06-10", 100.0))
    ledger.upsert_nav(nav("2024-06-11", 99.0))
    assert [(r.date, r.equity) for r in ledger.nav_rows()] == [("2024-06-10", 100.0), ("2024-06-11", 99.0)]
    assert ledger.peak_equity() == 100.0
    assert ledger.latest_equity() == 99.0


def test_empty_ledger(tmp_path):
    ledger = Ledger(tmp_path)
    assert ledger.nav_rows() == []
    assert ledger.peak_equity() is None
    assert ledger.latest_equity() is None
    assert ledger.read_plan("2024-06-10") is None
    assert ledger.plan_sessions() == []


def test_plans_and_dry_runs_are_separate(tmp_path):
    ledger = Ledger(tmp_path)
    ledger.write_plan("2024-06-10", {"a": 1})
    ledger.write_plan("2024-06-11", {"b": 2}, dry_run=True)
    assert ledger.read_plan("2024-06-10") == {"a": 1}
    assert ledger.read_plan("2024-06-11") is None
    assert ledger.plan_sessions() == ["2024-06-10"]


def test_fills_round_trip(tmp_path):
    ledger = Ledger(tmp_path)
    ledger.write_fills("2024-06-10", {"fills": []})
    assert ledger.read_fills("2024-06-10") == {"fills": []}
    assert ledger.fill_sessions() == ["2024-06-10"]


def test_halt_and_resume(tmp_path):
    ledger = Ledger(tmp_path)
    assert not ledger.is_halted()
    ledger.halt("drawdown")
    assert ledger.is_halted()
    assert "drawdown" in ledger.halted_path.read_text()
    assert ledger.resume() is True
    assert ledger.resume() is False


def test_log_path_creates_dir(tmp_path):
    path = Ledger(tmp_path).log_path("2024-06-10", "submit")
    assert path.parent.is_dir()
    assert path.name == "2024-06-10-submit.log"
```

- [ ] **Step 2: Run to verify failure**

Run: `.venv/bin/python -m pytest hedge_fund/live/test_ledger.py -q`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Implement** — create `hedge_fund/live/ledger.py`:

```python
"""The paper fund's books on disk — every plan, fill, and daily NAV.

One directory per fund under ~/.hedge-fund/paper/. Plain JSON and CSV so a
human can read the track record without the app. Alpaca, not this ledger, is
the source of truth for positions and cash; the ledger is the audit trail and
the NAV history the drawdown breaker and the report read.
"""

from __future__ import annotations

import csv
import json
from pathlib import Path

from pydantic import BaseModel

from hedge_fund.paths import PAPER_DIR


class NavRow(BaseModel):
    """The fund at one session's close."""

    date: str
    equity: float
    cash: float
    long_exposure: float
    short_exposure: float
    gross: float                      # (long + short) / equity
    benchmark_close: float


_NAV_FIELDS = list(NavRow.model_fields)


class Ledger:
    def __init__(self, root: Path) -> None:
        self.root = Path(root)

    @classmethod
    def for_fund(cls, fund_name: str) -> "Ledger":
        return cls(PAPER_DIR / fund_name)

    # -- halt flag ---------------------------------------------------------

    @property
    def halted_path(self) -> Path:
        return self.root / "HALTED"

    def is_halted(self) -> bool:
        return self.halted_path.exists()

    def halt(self, reason: str) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        self.halted_path.write_text(reason + "\n")

    def resume(self) -> bool:
        """Clear the halt flag; True if it was set."""
        if not self.is_halted():
            return False
        self.halted_path.unlink()
        return True

    # -- plans and fills -----------------------------------------------------

    def write_plan(self, session: str, payload: dict, *, dry_run: bool = False) -> Path:
        return self._write_json("plans", f"{session}.dryrun.json" if dry_run else f"{session}.json", payload)

    def read_plan(self, session: str) -> dict | None:
        return self._read_json("plans", f"{session}.json")

    def plan_sessions(self) -> list[str]:
        """Sessions with a real (not dry-run) plan, oldest first."""
        return self._sessions("plans")

    def write_fills(self, session: str, payload: dict) -> Path:
        return self._write_json("fills", f"{session}.json", payload)

    def read_fills(self, session: str) -> dict | None:
        return self._read_json("fills", f"{session}.json")

    def fill_sessions(self) -> list[str]:
        return self._sessions("fills")

    # -- NAV -------------------------------------------------------------------

    @property
    def nav_path(self) -> Path:
        return self.root / "nav.csv"

    def upsert_nav(self, row: NavRow) -> None:
        """Insert or replace the row for row.date; the file stays date-sorted."""
        rows = {r.date: r for r in self.nav_rows()}
        rows[row.date] = row
        self.root.mkdir(parents=True, exist_ok=True)
        with self.nav_path.open("w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=_NAV_FIELDS)
            writer.writeheader()
            for day in sorted(rows):
                writer.writerow(rows[day].model_dump())

    def nav_rows(self) -> list[NavRow]:
        if not self.nav_path.exists():
            return []
        with self.nav_path.open(newline="") as f:
            return [NavRow.model_validate(r) for r in csv.DictReader(f)]

    def peak_equity(self) -> float | None:
        rows = self.nav_rows()
        return max(r.equity for r in rows) if rows else None

    def latest_equity(self) -> float | None:
        rows = self.nav_rows()
        return rows[-1].equity if rows else None

    # -- logs ------------------------------------------------------------------

    def log_path(self, day: str, step: str) -> Path:
        logs = self.root / "logs"
        logs.mkdir(parents=True, exist_ok=True)
        return logs / f"{day}-{step}.log"

    # -- helpers ---------------------------------------------------------------

    def _write_json(self, kind: str, name: str, payload: dict) -> Path:
        directory = self.root / kind
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / name
        path.write_text(json.dumps(payload, indent=2))
        return path

    def _read_json(self, kind: str, name: str) -> dict | None:
        path = self.root / kind / name
        return json.loads(path.read_text()) if path.exists() else None

    def _sessions(self, kind: str) -> list[str]:
        return sorted(p.stem for p in (self.root / kind).glob("*.json") if "." not in p.stem)
```

- [ ] **Step 4: Run tests**

Run: `.venv/bin/python -m pytest hedge_fund/live -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hedge_fund/live/ledger.py hedge_fund/live/test_ledger.py
git commit -m "Add the paper fund's file ledger

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `plan_rebalance`

**Files:**
- Create: `hedge_fund/live/plan.py`
- Test: `hedge_fund/live/test_plan.py` (its fakes are reused by later tests)

- [ ] **Step 1: Write failing tests** — create `hedge_fund/live/test_plan.py`:

```python
"""plan_rebalance tests — fake data + fake analyst, real assessment and sizing."""

import pytest

from hedge_fund.brokers.models import Order
from hedge_fund.data.models import Price
from hedge_fund.fund.spec import Fund, FundSpec
from hedge_fund.live.plan import plan_rebalance
from hedge_fund.models import Signal

FRIDAY, MONDAY = "2024-06-07", "2024-06-10"
SERIES = {"AAPL": {FRIDAY: 100.0}, "MSFT": {FRIDAY: 50.0}, "SPY": {FRIDAY: 500.0}}


class FakeDataClient:
    """Closes per ticker per date: {ticker: {date: close}}."""

    def __init__(self, series):
        self._series = series

    def get_prices(self, ticker, start_date, end_date, **kwargs):
        return [
            Price(open=c, close=c, high=c, low=c, volume=1000, time=f"{d}T00:00:00Z")
            for d, c in sorted(self._series.get(ticker, {}).items())
            if start_date <= d <= end_date
        ]


class FakeAnalyst:
    investment_approach = "long_short"

    def __init__(self, name, views=None):
        self._name = name
        self._views = views or {}
        self.calls = []

    @property
    def name(self):
        return self._name

    def predict(self, ticker, date, data_client):
        self.calls.append((ticker, date))
        return Signal(model_name=self._name, ticker=ticker, date=date, value=self._views.get(ticker, 0.0))


@pytest.fixture(autouse=True)
def registered_fakes(monkeypatch):
    from hedge_fund.signals import ALPHA_MODEL_REGISTRY
    monkeypatch.setitem(ALPHA_MODEL_REGISTRY, "a", FakeAnalyst)


def make_fund(views, rebalance="weekly"):
    spec = FundSpec(
        schema_version=2, name="paper-test",
        strategies=[{"name": "solo", "models": [{"name": "a"}], "blend": {"mode": "long_short"}}],
        risk={"max_position_pct": 0.5, "max_gross_exposure": 1.0},
        rebalance=rebalance,
    )
    analyst = FakeAnalyst("a", views)
    return Fund(spec, models={"solo": [analyst]}), analyst


def test_buys_toward_the_capped_target_with_data_through_yesterday():
    fund, analyst = make_fund({"AAPL": 1.0})
    plan = plan_rebalance(fund, ["AAPL"], {}, 100_000.0, FakeDataClient(SERIES), MONDAY)
    assert plan.cutoff == "2024-06-09"
    assert analyst.calls == [("AAPL", "2024-06-09")]
    assert plan.marks == {"AAPL": 100.0}
    assert plan.equity == 100_000.0
    assert plan.orders == [Order(ticker="AAPL", side="buy", quantity=500, price=100.0)]


def test_closes_held_names_outside_the_targets_sells_first():
    fund, _ = make_fund({"AAPL": 1.0})
    plan = plan_rebalance(fund, ["AAPL"], {"MSFT": 10}, 99_500.0, FakeDataClient(SERIES), MONDAY)
    assert plan.equity == 100_000.0
    assert [(o.side, o.ticker, o.quantity) for o in plan.orders] == [("sell", "MSFT", 10), ("buy", "AAPL", 500)]


def test_short_positions_count_against_equity():
    fund, _ = make_fund({"AAPL": 1.0})
    plan = plan_rebalance(fund, ["AAPL"], {"AAPL": -100}, 110_000.0, FakeDataClient(SERIES), MONDAY)
    assert plan.equity == 100_000.0
    assert plan.orders == [Order(ticker="AAPL", side="buy", quantity=600, price=100.0)]


def test_flatten_closes_everything_without_asking_analysts():
    fund, analyst = make_fund({"AAPL": 1.0})
    plan = plan_rebalance(fund, ["AAPL"], {"AAPL": 10, "MSFT": -4}, 1_000.0, FakeDataClient(SERIES), MONDAY, flatten=True)
    assert plan.flatten and plan.decision is None
    assert analyst.calls == []
    assert [(o.side, o.ticker, o.quantity) for o in plan.orders] == [("sell", "AAPL", 10), ("buy", "MSFT", 4)]


def test_held_name_without_a_price_raises():
    fund, _ = make_fund({"AAPL": 1.0})
    with pytest.raises(ValueError, match="ZZZ"):
        plan_rebalance(fund, ["AAPL"], {"ZZZ": 5}, 100_000.0, FakeDataClient(SERIES), MONDAY)


def test_nonpositive_equity_raises():
    fund, _ = make_fund({"AAPL": 1.0})
    with pytest.raises(ValueError, match="equity"):
        plan_rebalance(fund, ["AAPL"], {}, 0.0, FakeDataClient(SERIES), MONDAY)
```

- [ ] **Step 2: Run to verify failure**

Run: `.venv/bin/python -m pytest hedge_fund/live/test_plan.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'hedge_fund.live.plan'`.

- [ ] **Step 3: Implement** — create `hedge_fund/live/plan.py`:

```python
"""Plan one live rebalance: the backtest's decision path, sized against a real book.

Same assessment, blend, risk clamp and order arithmetic as execute_decision;
the differences are only where the book comes from (the broker account, passed
in) and the sizing price (the cutoff close — the execution close is still in
the future when orders go out).
"""

from __future__ import annotations

from math import isfinite

from pydantic import BaseModel

from hedge_fund.brokers.models import Order, Position
from hedge_fund.data.protocol import DataClient
from hedge_fund.data.sessions import previous_day
from hedge_fund.fund import Fund
from hedge_fund.pipeline.execution import build_orders
from hedge_fund.pipeline.models import DecisionRecord
from hedge_fund.pipeline.run_cycle import _mark_prices, assess_fund, check_projected_book


class LivePlan(BaseModel):
    session: str                        # execution session (orders fill at its close)
    cutoff: str                         # data cutoff: the day before the session
    decision: DecisionRecord | None     # None when flattening
    marks: dict[str, float]             # reference closes used for sizing
    equity: float
    cash: float
    positions: dict[str, int]           # the book the plan started from
    targets: dict[str, float]
    orders: list[Order]
    flatten: bool = False


def plan_rebalance(
    fund: Fund, universe: list[str], positions: dict[str, int], cash: float,
    data_client: DataClient, session: str, *, flatten: bool = False,
) -> LivePlan:
    """Orders that move `positions` to the fund's targets (or to flat) at `session`'s close."""
    cutoff = previous_day(session)
    decision = None if flatten else assess_fund(fund, cutoff, data_client, universe)
    targets = {} if decision is None else {t: w for t, w in decision.final_weights.items() if w != 0}

    marks = {t: decision.marks[t] for t in targets} if decision is not None else {}
    missing = sorted(t for t in positions if t not in marks)
    extra, skipped = _mark_prices(missing, cutoff, data_client)
    if skipped:
        raise ValueError(f"cannot price held names {', '.join(s.ticker for s in skipped)} as of {cutoff}")
    marks.update(extra)

    equity = cash + sum(shares * marks[t] for t, shares in positions.items())
    if not isfinite(equity) or equity <= 0:
        raise ValueError(f"{fund.spec.name}: equity {equity} must be finite and positive to size orders")
    held = {t: Position(ticker=t, shares=s) for t, s in positions.items() if s}
    orders = build_orders(targets, held, marks, equity)
    check_projected_book(orders, dict(positions), marks, equity, fund.spec.risk)
    return LivePlan(
        session=session, cutoff=cutoff, decision=decision, marks=marks, equity=equity,
        cash=cash, positions=dict(positions), targets=targets, orders=orders, flatten=flatten,
    )
```

- [ ] **Step 4: Run tests**

Run: `.venv/bin/python -m pytest hedge_fund/live -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hedge_fund/live/plan.py hedge_fund/live/test_plan.py
git commit -m "Plan live rebalances against a real broker book

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: `submit` with every guard

**Files:**
- Create: `hedge_fund/live/runner.py`
- Test: `hedge_fund/live/test_runner.py`

- [ ] **Step 1: Write failing tests** — create `hedge_fund/live/test_runner.py`:

```python
"""submit/reconcile tests — a fake Alpaca account, a tmp ledger, real planning."""

from datetime import datetime

import pytest

from hedge_fund.brokers.alpaca import Account, OrderResult
from hedge_fund.data.sessions import NEW_YORK
from hedge_fund.live.ledger import Ledger, NavRow
from hedge_fund.live.runner import submit
from hedge_fund.live.test_plan import SERIES, FakeDataClient, make_fund, registered_fakes  # noqa: F401

SESSIONS = ["2024-06-06", "2024-06-07", "2024-06-10", "2024-06-11"]
MON_10AM = datetime(2024, 6, 10, 10, 0, tzinfo=NEW_YORK)
TUE_10AM = datetime(2024, 6, 11, 10, 0, tzinfo=NEW_YORK)


class FakeAlpaca:
    def __init__(self, positions=None, cash=100_000.0, orders=None, reject=()):
        self.sessions = SESSIONS
        self._positions = dict(positions or {})
        self.cash = cash
        self.orders = list(orders or [])
        self.reject = set(reject)
        self.submitted = []

    def calendar(self, start, end):
        return [s for s in self.sessions if start <= s <= end]

    def list_orders(self, after):
        return list(self.orders)

    def positions(self):
        return dict(self._positions)

    def account(self):
        return Account(cash=self.cash, equity=self.cash, last_equity=self.cash, status="ACTIVE")

    def submit_moc(self, ticker, side, quantity, client_order_id):
        self.submitted.append((ticker, side, quantity, client_order_id))
        status = "rejected" if ticker in self.reject else "accepted"
        return OrderResult(client_order_id=client_order_id, ticker=ticker, side=side, quantity=quantity, status=status)


def nav(day, equity):
    return NavRow(date=day, equity=equity, cash=equity, long_exposure=0.0,
                  short_exposure=0.0, gross=0.0, benchmark_close=500.0)


@pytest.fixture
def ledger(tmp_path):
    return Ledger(tmp_path / "ledger")


def run_submit(client, ledger, tmp_path, *, now=MON_10AM, dry_run=False):
    fund, analyst = make_fund({"AAPL": 1.0})
    result = submit(fund, ["AAPL"], client, FakeDataClient(SERIES), ledger,
                    now=now, dry_run=dry_run, kill_path=tmp_path / "KILL")
    return result, analyst


def test_submits_moc_orders_on_rebalance_day(ledger, tmp_path):
    client = FakeAlpaca()
    result, _ = run_submit(client, ledger, tmp_path)
    assert result.status == "submitted"
    assert client.submitted == [("AAPL", "buy", 500, "paper-test-2024-06-10-AAPL")]
    saved = ledger.read_plan("2024-06-10")
    assert saved["status"] == "submitted"
    assert saved["orders"][0]["status"] == "accepted"


def test_kill_switch_stops_everything(ledger, tmp_path):
    (tmp_path / "KILL").touch()
    client = FakeAlpaca()
    result, _ = run_submit(client, ledger, tmp_path)
    assert result.status == "killed"
    assert client.submitted == []


def test_not_a_trading_day(ledger, tmp_path):
    result, _ = run_submit(FakeAlpaca(), ledger, tmp_path, now=datetime(2024, 6, 8, 10, 0, tzinfo=NEW_YORK))
    assert result.status == "not_trading_day"


def test_too_late_for_moc(ledger, tmp_path):
    result, _ = run_submit(FakeAlpaca(), ledger, tmp_path, now=datetime(2024, 6, 10, 15, 46, tzinfo=NEW_YORK))
    assert result.status == "too_late"


def test_already_submitted_is_a_no_op(ledger, tmp_path):
    existing = OrderResult(client_order_id="paper-test-2024-06-10-AAPL", ticker="AAPL", side="buy", quantity=500, status="new")
    client = FakeAlpaca(orders=[existing])
    result, _ = run_submit(client, ledger, tmp_path)
    assert result.status == "already_submitted"
    assert client.submitted == []


def test_not_a_rebalance_day_asks_no_analysts(ledger, tmp_path):
    result, analyst = run_submit(FakeAlpaca(), ledger, tmp_path, now=TUE_10AM)
    assert result.status == "not_rebalance_day"
    assert analyst.calls == []


def test_dry_run_plans_any_day_and_sends_nothing(ledger, tmp_path):
    client = FakeAlpaca()
    result, _ = run_submit(client, ledger, tmp_path, now=TUE_10AM, dry_run=True)
    assert result.status == "dry_run"
    assert [(o.side, o.ticker, o.quantity) for o in result.plan.orders] == [("buy", "AAPL", 500)]
    assert client.submitted == []
    assert ledger.read_plan("2024-06-11") is None
    assert (ledger.root / "plans" / "2024-06-11.dryrun.json").exists()


def test_rejections_are_recorded(ledger, tmp_path):
    result, _ = run_submit(FakeAlpaca(reject={"AAPL"}), ledger, tmp_path)
    assert result.orders[0].status == "rejected"
    assert ledger.read_plan("2024-06-10")["orders"][0]["status"] == "rejected"


def test_drawdown_breach_halts_and_flattens_any_trading_day(ledger, tmp_path):
    ledger.upsert_nav(nav("2024-06-05", 100_000.0))
    ledger.upsert_nav(nav("2024-06-07", 84_000.0))
    client = FakeAlpaca(positions={"AAPL": 10}, cash=83_000.0)
    result, analyst = run_submit(client, ledger, tmp_path, now=TUE_10AM)
    assert result.status == "flattening"
    assert ledger.is_halted()
    assert analyst.calls == []
    assert client.submitted == [("AAPL", "sell", 10, "paper-test-2024-06-11-AAPL")]


def test_small_drawdown_does_not_halt(ledger, tmp_path):
    ledger.upsert_nav(nav("2024-06-05", 100_000.0))
    ledger.upsert_nav(nav("2024-06-07", 86_000.0))
    result, _ = run_submit(FakeAlpaca(), ledger, tmp_path)
    assert result.status == "submitted"
    assert not ledger.is_halted()


def test_halted_and_flat_stays_put(ledger, tmp_path):
    ledger.halt("manual")
    client = FakeAlpaca()
    result, _ = run_submit(client, ledger, tmp_path)
    assert result.status == "halted"
    assert client.submitted == []


def test_dry_run_never_writes_halted(ledger, tmp_path):
    ledger.upsert_nav(nav("2024-06-05", 100_000.0))
    ledger.upsert_nav(nav("2024-06-07", 80_000.0))
    result, _ = run_submit(FakeAlpaca(positions={"AAPL": 10}), ledger, tmp_path, dry_run=True)
    assert result.status == "dry_run"
    assert result.plan.flatten
    assert not ledger.is_halted()
```

- [ ] **Step 2: Run to verify failure**

Run: `.venv/bin/python -m pytest hedge_fund/live/test_runner.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'hedge_fund.live.runner'`.

- [ ] **Step 3: Implement** — create `hedge_fund/live/runner.py`:

```python
"""The paper fund's two daily steps: submit (morning) and reconcile (next morning).

submit plans and sends market-on-close orders on rebalance days; every guard
that can stop it runs before any analyst is asked or any order is sent.
reconcile records the previous session's fills and closing NAV. Alpaca is the
source of truth for the book; the ledger is the record.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from pathlib import Path
from typing import Literal, Protocol

from pydantic import BaseModel, Field

from hedge_fund.brokers.alpaca import Account, OrderResult
from hedge_fund.data.protocol import DataClient
from hedge_fund.data.sessions import NEW_YORK
from hedge_fund.fund import Fund
from hedge_fund.live.calendar import MOC_CUTOFF, client_order_prefix, is_rebalance_day, ny_midnight
from hedge_fund.live.ledger import Ledger
from hedge_fund.live.plan import LivePlan, plan_rebalance
from hedge_fund.paths import KILL_PATH

logger = logging.getLogger(__name__)

DRAWDOWN_HALT = 0.15   # halt and flatten at a 15% fall from peak NAV


class PaperAccount(Protocol):
    """What the runner needs from Alpaca — AlpacaPaperClient, or a test fake."""

    def calendar(self, start: str, end: str) -> list[str]: ...
    def list_orders(self, after: str) -> list[OrderResult]: ...
    def positions(self) -> dict[str, int]: ...
    def account(self) -> Account: ...
    def submit_moc(self, ticker: str, side: Literal["buy", "sell"], quantity: int, client_order_id: str) -> OrderResult: ...


SubmitStatus = Literal[
    "killed", "not_trading_day", "too_late", "already_submitted", "halted",
    "not_rebalance_day", "dry_run", "submitted", "flattening",
]


class SubmitResult(BaseModel):
    status: SubmitStatus
    session: str
    detail: str = ""
    plan: LivePlan | None = None
    orders: list[OrderResult] = Field(default_factory=list)


def submit(
    fund: Fund, universe: list[str], client: PaperAccount, data_client: DataClient,
    ledger: Ledger, *, now: datetime, dry_run: bool = False, kill_path: Path = KILL_PATH,
) -> SubmitResult:
    """Plan and send today's market-on-close orders, or say exactly why not.

    A dry run skips the calendar, clock and rebalance-day guards (it never
    sends anything, so the plan can be inspected any day) and never halts.
    """
    now = now.astimezone(NEW_YORK)
    session = now.date().isoformat()

    def done(status: SubmitStatus, detail: str = "", **extra) -> SubmitResult:
        logger.info("submit %s: %s %s", session, status, detail)
        return SubmitResult(status=status, session=session, detail=detail, **extra)

    if kill_path.exists():
        return done("killed", f"{kill_path} exists; delete it to trade again")
    sessions = client.calendar((now.date() - timedelta(days=10)).isoformat(), session)
    prefix = client_order_prefix(fund.spec.name, session)
    if not dry_run:
        if not sessions or sessions[-1] != session:
            return done("not_trading_day")
        if now.time() > MOC_CUTOFF:
            return done("too_late", f"after {MOC_CUTOFF:%H:%M} ET; market-on-close orders are closed")
        if any(o.client_order_id.startswith(prefix) for o in client.list_orders(after=ny_midnight(session))):
            return done("already_submitted")

    breach = _drawdown_breach(ledger)
    if breach and not dry_run and not ledger.is_halted():
        ledger.halt(breach)
    halted = ledger.is_halted() or breach is not None
    positions = client.positions()
    if halted:
        if not positions:
            return done("halted", breach or ledger.halted_path.read_text().strip())
        status: SubmitStatus = "flattening"
    else:
        previous = [s for s in sessions if s < session]
        if not dry_run and (not previous or not is_rebalance_day(session, previous[-1], fund.spec.rebalance)):
            return done("not_rebalance_day")
        status = "submitted"

    # Planning can raise (data or LLM outage) — that aborts before any order exists.
    plan = plan_rebalance(fund, universe, positions, client.account().cash, data_client, session, flatten=halted)
    payload = {"status": status, "plan": plan.model_dump(mode="json"), "orders": []}
    if dry_run:
        ledger.write_plan(session, payload, dry_run=True)
        return done("dry_run", f"would have been {status}: {len(plan.orders)} orders", plan=plan)

    ledger.write_plan(session, payload)   # the plan is on disk before anything is sent
    orders: list[OrderResult] = []
    for order in plan.orders:
        orders.append(client.submit_moc(order.ticker, order.side, order.quantity, prefix + order.ticker))
        payload["orders"] = [o.model_dump(mode="json") for o in orders]
        ledger.write_plan(session, payload)
    rejected = sum(o.status == "rejected" for o in orders)
    return done(status, f"{len(orders)} orders sent, {rejected} rejected", plan=plan, orders=orders)


def _drawdown_breach(ledger: Ledger) -> str | None:
    """A halt reason if the latest NAV is DRAWDOWN_HALT or more below its peak."""
    peak, latest = ledger.peak_equity(), ledger.latest_equity()
    if not peak or latest is None or latest > (1 - DRAWDOWN_HALT) * peak:
        return None
    return (f"drawdown halt: equity {latest:,.2f} is {1 - latest / peak:.1%} below peak {peak:,.2f}. "
            "Run `aihf-paper resume` to trade again.")
```

- [ ] **Step 4: Run tests**

Run: `.venv/bin/python -m pytest hedge_fund/live -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hedge_fund/live/runner.py hedge_fund/live/test_runner.py
git commit -m "Submit market-on-close rebalances behind kill, calendar and drawdown guards

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: `reconcile` and `session_to_reconcile`

**Files:**
- Modify: `hedge_fund/live/runner.py`
- Test: `hedge_fund/live/test_runner.py`

- [ ] **Step 1: Write failing tests** — append to `hedge_fund/live/test_runner.py`:

```python
from hedge_fund.live.runner import reconcile, session_to_reconcile  # noqa: E402

RECON_SERIES = {"AAPL": {"2024-06-10": 102.0}, "SPY": {"2024-06-10": 505.0}}


def filled(side, qty, price, ticker="AAPL"):
    return OrderResult(client_order_id=f"paper-test-2024-06-10-{ticker}", ticker=ticker, side=side,
                       quantity=qty, status="filled", filled_qty=qty, filled_avg_price=price)


def seed_plan(ledger, marks=None, positions=None):
    ledger.write_plan("2024-06-10", {"status": "submitted", "orders": [],
                                     "plan": {"marks": marks or {"AAPL": 100.0}, "positions": positions or {}}})


def test_reconcile_records_fills_slippage_and_nav(ledger):
    seed_plan(ledger)
    client = FakeAlpaca(positions={"AAPL": 500}, cash=49_500.0, orders=[filled("buy", 500, 101.0)])
    spec = make_fund({})[0].spec
    result = reconcile(spec, client, FakeDataClient(RECON_SERIES), ledger, session="2024-06-10")
    assert result.fills[0].slippage_bps == pytest.approx(100.0)
    assert result.nav.equity == pytest.approx(49_500.0 + 500 * 102.0)
    assert result.nav.long_exposure == pytest.approx(51_000.0)
    assert result.nav.gross == pytest.approx(51_000.0 / 100_500.0, abs=1e-6)
    assert result.nav.benchmark_close == 505.0
    assert result.mismatches == []
    assert ledger.read_fills("2024-06-10")["fills"][0]["fill_price"] == 101.0


def test_reconcile_is_idempotent(ledger):
    client = FakeAlpaca(positions={}, cash=100_000.0)
    spec = make_fund({})[0].spec
    for _ in range(2):
        reconcile(spec, client, FakeDataClient(RECON_SERIES), ledger, session="2024-06-10")
    assert [r.date for r in ledger.nav_rows()] == ["2024-06-10"]


def test_sell_slippage_is_positive_when_filled_below_reference(ledger):
    seed_plan(ledger, positions={"AAPL": 100})
    client = FakeAlpaca(positions={"AAPL": 50}, cash=100_000.0, orders=[filled("sell", 50, 99.0)])
    result = reconcile(make_fund({})[0].spec, client, FakeDataClient(RECON_SERIES), ledger, session="2024-06-10")
    assert result.fills[0].slippage_bps == pytest.approx(100.0)
    assert result.mismatches == []


def test_reconcile_flags_book_mismatch_and_trusts_alpaca(ledger):
    seed_plan(ledger)
    client = FakeAlpaca(positions={"AAPL": 400}, cash=59_500.0, orders=[filled("buy", 500, 101.0)])
    result = reconcile(make_fund({})[0].spec, client, FakeDataClient(RECON_SERIES), ledger, session="2024-06-10")
    assert len(result.mismatches) == 1 and "AAPL" in result.mismatches[0]
    assert result.nav.equity == pytest.approx(59_500.0 + 400 * 102.0)


def test_session_to_reconcile():
    client = FakeAlpaca()
    assert session_to_reconcile(client, datetime(2024, 6, 11, 9, 0, tzinfo=NEW_YORK)) == "2024-06-10"
    assert session_to_reconcile(client, datetime(2024, 6, 8, 17, 0, tzinfo=NEW_YORK)) == "2024-06-07"
    with pytest.raises(ValueError, match="15:50"):
        session_to_reconcile(client, datetime(2024, 6, 11, 16, 0, tzinfo=NEW_YORK))
```

- [ ] **Step 2: Run to verify failure**

Run: `.venv/bin/python -m pytest hedge_fund/live/test_runner.py -q`
Expected: FAIL with `ImportError: cannot import name 'reconcile'`.

- [ ] **Step 3: Implement** — in `hedge_fund/live/runner.py` extend imports:

```python
from datetime import datetime, time, timedelta
from hedge_fund.fund import Fund, FundSpec
from hedge_fund.live.ledger import Ledger, NavRow
from hedge_fund.pipeline.run_cycle import exact_marks
```

and append:

```python
# Past this time on a trading day, that day's MOC fills may already be in the
# account, so "current book" would no longer be the previous session's book.
_RECONCILE_DEADLINE = time(15, 50)


class FillRecord(BaseModel):
    client_order_id: str
    ticker: str
    side: Literal["buy", "sell"]
    quantity: int
    filled_qty: int
    status: str
    fill_price: float | None = None
    reference_price: float | None = None
    slippage_bps: float | None = None      # positive = cost vs the sizing close


class ReconcileResult(BaseModel):
    session: str
    nav: NavRow
    fills: list[FillRecord] = Field(default_factory=list)
    mismatches: list[str] = Field(default_factory=list)


def session_to_reconcile(client: PaperAccount, now: datetime) -> str:
    """The most recent completed session — the only one whose closing book is still observable."""
    now = now.astimezone(NEW_YORK)
    today = now.date().isoformat()
    sessions = client.calendar((now.date() - timedelta(days=10)).isoformat(), today)
    if today in sessions and now.time() >= _RECONCILE_DEADLINE:
        raise ValueError("after 15:50 ET today's market-on-close fills may already be booked; "
                         "reconcile the previous session tomorrow before 15:50 ET")
    past = [s for s in sessions if s < today]
    if not past:
        raise ValueError("no completed trading session in the last 10 days")
    return past[-1]


def reconcile(
    spec: FundSpec, client: PaperAccount, data_client: DataClient, ledger: Ledger, *, session: str,
) -> ReconcileResult:
    """Record `session`'s fills and closing NAV. Safe to re-run; the NAV row is replaced."""
    prefix = client_order_prefix(spec.name, session)
    orders = [o for o in client.list_orders(after=ny_midnight(session)) if o.client_order_id.startswith(prefix)]
    plan = ledger.read_plan(session)
    reference = plan["plan"]["marks"] if plan else {}
    fills = [_fill_record(o, reference.get(o.ticker)) for o in orders]
    if fills:
        ledger.write_fills(session, {"session": session, "fills": [f.model_dump(mode="json") for f in fills]})

    positions = client.positions()
    cash = client.account().cash
    closes = exact_marks(sorted(set(positions) | {spec.benchmark}), session, data_client)
    long_ = sum(s * closes[t] for t, s in positions.items() if s > 0)
    short = sum(-s * closes[t] for t, s in positions.items() if s < 0)
    equity = cash + long_ - short
    row = NavRow(
        date=session, equity=round(equity, 2), cash=round(cash, 2),
        long_exposure=round(long_, 2), short_exposure=round(short, 2),
        gross=round((long_ + short) / equity, 6) if equity > 0 else 0.0,
        benchmark_close=closes[spec.benchmark],
    )
    ledger.upsert_nav(row)

    mismatches = _mismatches(plan["plan"]["positions"], fills, positions) if plan and fills else []
    for message in mismatches:
        logger.warning(message)
    logger.info("reconcile %s: equity %.2f, %d fills", session, row.equity, len(fills))
    return ReconcileResult(session=session, nav=row, fills=fills, mismatches=mismatches)


def _fill_record(order: OrderResult, reference: float | None) -> FillRecord:
    slippage = None
    if order.filled_avg_price is not None and reference:
        direction = 1 if order.side == "buy" else -1
        slippage = round(direction * (order.filled_avg_price - reference) / reference * 10_000, 2)
    return FillRecord(
        client_order_id=order.client_order_id, ticker=order.ticker, side=order.side,
        quantity=order.quantity, filled_qty=order.filled_qty, status=order.status,
        fill_price=order.filled_avg_price, reference_price=reference, slippage_bps=slippage,
    )


def _mismatches(start: dict[str, int], fills: list[FillRecord], actual: dict[str, int]) -> list[str]:
    expected = dict(start)
    for f in fills:
        expected[f.ticker] = expected.get(f.ticker, 0) + (f.filled_qty if f.side == "buy" else -f.filled_qty)
    return [
        f"{t}: ledger expects {expected.get(t, 0)} shares, Alpaca holds {actual.get(t, 0)}; trusting Alpaca"
        for t in sorted(set(expected) | set(actual))
        if expected.get(t, 0) != actual.get(t, 0)
    ]
```

- [ ] **Step 4: Run tests**

Run: `.venv/bin/python -m pytest hedge_fund/live -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hedge_fund/live/runner.py hedge_fund/live/test_runner.py
git commit -m "Reconcile paper fills, slippage and daily NAV

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Paper report

**Files:**
- Create: `hedge_fund/live/report.py`
- Test: `hedge_fund/live/test_report.py`

- [ ] **Step 1: Write failing tests** — create `hedge_fund/live/test_report.py`:

```python
import pytest

from hedge_fund.backtesting.fund import FundBacktestMetrics, FundBacktestResult
from hedge_fund.live.ledger import Ledger, NavRow
from hedge_fund.live.report import build_report, strategy_attribution
from hedge_fund.live.test_plan import FakeDataClient


def nav(day, equity, bench):
    return NavRow(date=day, equity=equity, cash=0.0, long_exposure=0.0, short_exposure=0.0,
                  gross=0.0, benchmark_close=bench)


def seeded(tmp_path):
    ledger = Ledger(tmp_path)
    for day, equity, bench in [("2024-06-10", 100_000.0, 500.0), ("2024-06-11", 101_000.0, 505.0),
                               ("2024-06-12", 102_000.0, 500.0)]:
        ledger.upsert_nav(nav(day, equity, bench))
    ledger.write_plan("2024-06-10", {"plan": {"decision": {"strategies": [
        {"name": "solo", "final_contribution": {"AAPL": 0.5}}]}}})
    ledger.write_fills("2024-06-10", {"fills": [
        {"client_order_id": "x-AAPL", "ticker": "AAPL", "side": "buy", "quantity": 500, "filled_qty": 500,
         "status": "filled", "fill_price": 101.0, "reference_price": 100.0, "slippage_bps": 100.0},
        {"client_order_id": "x-MSFT", "ticker": "MSFT", "side": "sell", "quantity": 100, "filled_qty": 50,
         "status": "partially_filled", "fill_price": 99.0, "reference_price": 100.0, "slippage_bps": 100.0},
    ]})
    return ledger


def test_report_metrics(tmp_path):
    report = build_report(seeded(tmp_path))
    assert (report.start, report.end, report.n_days) == ("2024-06-10", "2024-06-12", 3)
    assert report.total_return_pct == pytest.approx(0.02)
    assert report.benchmark_return_pct == pytest.approx(0.0)
    assert report.excess_return_pct == pytest.approx(0.02)
    assert report.n_rebalances == 1
    assert report.fill_rate == pytest.approx(550 / 600)
    assert report.avg_slippage_bps == pytest.approx(100.0)
    assert report.turnover == pytest.approx((500 * 101.0 + 50 * 99.0) / 101_000.0)


def test_report_needs_two_sessions(tmp_path):
    ledger = Ledger(tmp_path)
    ledger.upsert_nav(nav("2024-06-10", 100_000.0, 500.0))
    assert build_report(ledger) is None


def test_report_compares_same_dates_backtest(tmp_path):
    result = FundBacktestResult(
        fund="f", start="2024-06-07", end="2024-06-12", rebalance="weekly", benchmark="SPY",
        universe=["AAPL"], capital=100.0,
        dates=["2024-06-07", "2024-06-10", "2024-06-11", "2024-06-12"],
        nav=[100.0, 100.0, 103.0, 105.0], benchmark_nav=[100.0] * 4,
        metrics=FundBacktestMetrics(total_return_pct=0.05, annualized_return_pct=0.0, sharpe_ratio=0.0,
                                    max_drawdown_pct=0.0, benchmark_return_pct=0.0, excess_return_pct=0.05,
                                    n_cycles=1, n_orders=1),
        records=[],
    )
    report = build_report(seeded(tmp_path), backtest=result)
    assert report.backtest_return_pct == pytest.approx(0.05)


def test_strategy_attribution(tmp_path):
    data = FakeDataClient({"AAPL": {"2024-06-10": 100.0, "2024-06-12": 110.0}})
    assert strategy_attribution(seeded(tmp_path), data) == {"solo": pytest.approx(0.05)}
```

- [ ] **Step 2: Run to verify failure**

Run: `.venv/bin/python -m pytest hedge_fund/live/test_report.py -q`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Implement** — create `hedge_fund/live/report.py`:

```python
"""How the paper fund is doing — from its own ledger, with the backtest alongside."""

from __future__ import annotations

from pydantic import BaseModel, Field

from hedge_fund.backtesting.fund import FundBacktestResult, performance_metrics
from hedge_fund.data.protocol import DataClient
from hedge_fund.live.ledger import Ledger
from hedge_fund.live.runner import FillRecord
from hedge_fund.pipeline.run_cycle import exact_marks

MIN_REBALANCES_FOR_VERDICT = 12


class PaperReport(BaseModel):
    start: str
    end: str
    n_days: int
    total_return_pct: float
    benchmark_return_pct: float
    excess_return_pct: float
    sharpe_ratio: float
    max_drawdown_pct: float
    n_rebalances: int
    avg_slippage_bps: float | None = None    # notional-weighted, positive = cost
    fill_rate: float | None = None           # filled / requested shares
    turnover: float = 0.0                    # filled notional / average equity
    backtest_return_pct: float | None = None # the backtest over the same dates, if supplied
    strategy_contribution: dict[str, float] = Field(default_factory=dict)


def build_report(ledger: Ledger, *, backtest: FundBacktestResult | None = None) -> PaperReport | None:
    """Metrics over every reconciled session; None until there are at least two."""
    rows = ledger.nav_rows()
    if len(rows) < 2:
        return None
    dates = [r.date for r in rows]
    nav = [r.equity for r in rows]
    bench = [nav[0] * r.benchmark_close / rows[0].benchmark_close for r in rows]
    m = performance_metrics(nav[0], dates, nav, bench, records=[])

    fills = [FillRecord.model_validate(f) for s in ledger.fill_sessions() for f in ledger.read_fills(s)["fills"]]
    filled = [(f, f.filled_qty * f.fill_price) for f in fills if f.filled_qty and f.fill_price]
    slipped = [(f.slippage_bps, notional) for f, notional in filled if f.slippage_bps is not None]
    requested = sum(f.quantity for f in fills)
    return PaperReport(
        start=dates[0], end=dates[-1], n_days=len(dates),
        total_return_pct=m.total_return_pct, benchmark_return_pct=m.benchmark_return_pct,
        excess_return_pct=m.excess_return_pct, sharpe_ratio=m.sharpe_ratio,
        max_drawdown_pct=m.max_drawdown_pct, n_rebalances=len(ledger.plan_sessions()),
        avg_slippage_bps=(sum(s * n for s, n in slipped) / sum(n for _, n in slipped)) if slipped else None,
        fill_rate=(sum(f.filled_qty for f in fills) / requested) if requested else None,
        turnover=sum(n for _, n in filled) / (sum(nav) / len(nav)),
        backtest_return_pct=_backtest_return(backtest, dates[0], dates[-1]) if backtest else None,
    )


def strategy_attribution(ledger: Ledger, data_client: DataClient) -> dict[str, float]:
    """Each strategy's return contribution: its final weights × each name's close-to-close
    return, from each rebalance to the next (or to the latest reconciled session)."""
    sessions = ledger.plan_sessions()
    rows = ledger.nav_rows()
    if not sessions or not rows:
        return {}
    bounds = sessions + [rows[-1].date]
    totals: dict[str, float] = {}
    for start, end in zip(bounds, bounds[1:]):
        if end <= start:
            continue
        decision = ledger.read_plan(start)["plan"].get("decision")
        if not decision:
            continue   # a flatten plan carries no strategy views
        contributions = {s["name"]: s["final_contribution"] for s in decision["strategies"]}
        tickers = sorted({t for weights in contributions.values() for t, w in weights.items() if w})
        if not tickers:
            continue
        a = exact_marks(tickers, start, data_client)
        b = exact_marks(tickers, end, data_client)
        for name, weights in contributions.items():
            totals[name] = totals.get(name, 0.0) + sum(w * (b[t] / a[t] - 1) for t, w in weights.items() if w)
    return {name: round(value, 6) for name, value in totals.items()}


def _backtest_return(result: FundBacktestResult, start: str, end: str) -> float | None:
    points = [nav for day, nav in zip(result.dates, result.nav) if start <= day <= end]
    if len(points) < 2:
        return None
    return round(points[-1] / points[0] - 1, 6)
```

- [ ] **Step 4: Run tests**

Run: `.venv/bin/python -m pytest hedge_fund/live -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hedge_fund/live/report.py hedge_fund/live/test_report.py
git commit -m "Report paper performance, slippage and strategy attribution

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Baseline evaluation

**Files:**
- Create: `hedge_fund/live/baseline.py`
- Test: `hedge_fund/live/test_baseline.py`

- [ ] **Step 1: Write failing tests** — create `hedge_fund/live/test_baseline.py`:

```python
import pytest

from hedge_fund.backtesting.fund import FundBacktestMetrics, FundBacktestResult
from hedge_fund.fund.spec import FundSpec
from hedge_fund.live.baseline import baseline_variants, run_baseline
from hedge_fund.models import Signal
from hedge_fund.signals.base import QuantModel


class Stub(QuantModel):
    investment_approach = "long_short"

    @property
    def name(self):
        return "stub"

    def predict(self, ticker, date, data_client):
        return Signal(model_name="stub", ticker=ticker, date=date, value=0.0)


@pytest.fixture(autouse=True)
def registered(monkeypatch):
    from hedge_fund.signals import ALPHA_MODEL_REGISTRY
    monkeypatch.setitem(ALPHA_MODEL_REGISTRY, "stub", Stub)


def spec():
    return FundSpec(
        schema_version=2, name="pf",
        strategies=[
            {"name": "alpha", "weight": 0.7, "models": [{"name": "stub"}], "blend": {"mode": "long_short"}},
            {"name": "beta", "weight": 0.3, "models": [{"name": "stub"}], "blend": {"mode": "long_short"}},
        ],
        risk={"max_position_pct": 0.1, "max_gross_exposure": 1.0},
        costs={"commission_bps": 5},
    )


def test_variants():
    variants = baseline_variants(spec())
    assert list(variants) == ["fund", "only:alpha", "only:beta", "equal-weight"]
    assert [s.name for s in variants["only:alpha"].strategies] == ["alpha"]
    assert variants["only:alpha"].strategies[0].weight == 1.0
    ew = variants["equal-weight"]
    assert ew.strategies[0].models[0].name == "equal_weight"
    assert ew.strategies[0].blend.mode == "long_only"
    assert ew.costs.commission_bps == 5 and ew.risk == spec().risk


def result(total, sharpe):
    return FundBacktestResult(
        fund="pf", start="2026-07-01", end="2026-07-03", rebalance="weekly", benchmark="SPY",
        universe=["AAPL"], capital=100.0, dates=["2026-07-01", "2026-07-02", "2026-07-03"],
        nav=[100.0, 100.0, 100.0 * (1 + total)], benchmark_nav=[100.0, 102.0, 101.0],
        metrics=FundBacktestMetrics(total_return_pct=total, annualized_return_pct=total, sharpe_ratio=sharpe,
                                    max_drawdown_pct=0.0, benchmark_return_pct=0.01,
                                    excess_return_pct=total - 0.01, n_cycles=1, n_orders=1, total_costs=3.0),
        records=[],
    )


def test_run_baseline_flags_only_what_beats_both_benchmarks():
    outcomes = {"pf": (0.10, 2.0), "pf-alpha": (0.20, 10.0), "pf-beta": (0.03, 5.0), "pf-equal-weight": (0.05, 1.0)}
    seen = []

    def fake_backtest(fund, start, end, data_client, universe):
        seen.append((fund.spec.name, start, end, universe))
        return result(*outcomes[fund.spec.name])

    report = run_baseline(spec(), ["AAPL"], "2026-07-01", "2026-07-03", None, backtest=fake_backtest)
    rows = {r.name: r for r in report.rows}
    assert rows["only:alpha"].beats_benchmarks is True
    assert rows["only:beta"].beats_benchmarks is False       # loses to equal-weight on return
    assert rows["fund"].beats_benchmarks is False            # Sharpe below SPY's
    assert rows["equal-weight"].beats_benchmarks is None
    assert rows["spy"].total_return_pct == pytest.approx(0.01)
    assert report.possibly_memorized is False
    assert len(seen) == 4 and all(s[3] == ["AAPL"] for s in seen)


def test_windows_before_the_cutoff_are_labelled():
    report = run_baseline(spec(), ["AAPL"], "2025-01-01", "2026-07-03", None,
                          backtest=lambda *a: result(0.0, 0.0))
    assert report.possibly_memorized is True
```

- [ ] **Step 2: Run to verify failure**

Run: `.venv/bin/python -m pytest hedge_fund/live/test_baseline.py -q`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Implement** — create `hedge_fund/live/baseline.py`:

```python
"""Does the fund add value? Backtest it, each strategy alone, and two yardsticks.

The yardsticks are the benchmark (SPY) and an equal-weight book of the same
universe run through the identical engine — same caps, costs and cadence. A
strategy "beats the benchmarks" only if it beats both on total return and on
Sharpe. Windows starting before the LLM's training cutoff are labelled: the
model may remember how those companies did.
"""

from __future__ import annotations

from typing import Callable

from pydantic import BaseModel

from hedge_fund.backtesting.fund import FundBacktestResult, backtest_fund, performance_metrics
from hedge_fund.data.protocol import DataClient
from hedge_fund.fund.spec import Fund, FundSpec

# After the default model's (claude-opus-5-5) stated June 2026 training cutoff.
POST_CUTOFF_START = "2026-07-01"


class BaselineRow(BaseModel):
    name: str
    total_return_pct: float
    annualized_return_pct: float
    sharpe_ratio: float
    max_drawdown_pct: float
    total_costs: float = 0.0
    beats_benchmarks: bool | None = None   # None for the yardsticks themselves


class BaselineReport(BaseModel):
    start: str
    end: str
    possibly_memorized: bool
    benchmark: str
    rows: list[BaselineRow]


def baseline_variants(spec: FundSpec) -> dict[str, FundSpec]:
    """The full fund, each strategy alone at full capital, and the equal-weight book."""
    base = spec.model_dump()
    variants = {"fund": spec}
    for strategy in spec.strategies:
        variants[f"only:{strategy.name}"] = FundSpec.model_validate({
            **base, "name": f"{spec.name}-{strategy.name}",
            "strategies": [{**strategy.model_dump(), "weight": 1.0}],
        })
    variants["equal-weight"] = FundSpec.model_validate({
        **base, "name": f"{spec.name}-equal-weight",
        "strategies": [{"name": "equal-weight", "models": [{"name": "equal_weight"}], "blend": {"mode": "long_only"}}],
    })
    return variants


def run_baseline(
    spec: FundSpec, universe: list[str], start: str, end: str, data_client: DataClient,
    *, backtest: Callable[..., FundBacktestResult] = backtest_fund,
) -> BaselineReport:
    results = {
        name: backtest(Fund(variant, blind=True), start, end, data_client, universe)
        for name, variant in baseline_variants(spec).items()
    }
    fund = results["fund"]
    spy = performance_metrics(fund.capital, fund.dates, fund.benchmark_nav, fund.benchmark_nav, [])
    ew = results["equal-weight"].metrics
    bar_return = max(spy.total_return_pct, ew.total_return_pct)
    bar_sharpe = max(spy.sharpe_ratio, ew.sharpe_ratio)

    rows = []
    for name, result in results.items():
        m = result.metrics
        beats = None if name == "equal-weight" else (m.total_return_pct > bar_return and m.sharpe_ratio > bar_sharpe)
        rows.append(BaselineRow(
            name=name, total_return_pct=m.total_return_pct, annualized_return_pct=m.annualized_return_pct,
            sharpe_ratio=m.sharpe_ratio, max_drawdown_pct=m.max_drawdown_pct,
            total_costs=m.total_costs, beats_benchmarks=beats,
        ))
    rows.append(BaselineRow(
        name=spec.benchmark.lower(), total_return_pct=spy.total_return_pct,
        annualized_return_pct=spy.annualized_return_pct, sharpe_ratio=spy.sharpe_ratio,
        max_drawdown_pct=spy.max_drawdown_pct,
    ))
    return BaselineReport(start=start, end=end, possibly_memorized=start < POST_CUTOFF_START,
                          benchmark=spec.benchmark, rows=rows)
```

- [ ] **Step 4: Run tests**

Run: `.venv/bin/python -m pytest hedge_fund/live -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hedge_fund/live/baseline.py hedge_fund/live/test_baseline.py
git commit -m "Backtest the fund, each strategy, SPY and equal-weight side by side

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: launchd schedule and notifications

**Files:**
- Create: `hedge_fund/live/launchd.py`
- Test: `hedge_fund/live/test_launchd.py`

- [ ] **Step 1: Write failing tests** — create `hedge_fund/live/test_launchd.py`:

```python
import plistlib
from datetime import date, time
from zoneinfo import ZoneInfo

from hedge_fund.live.launchd import (
    calendar_intervals, install_schedule, schedule_installed, uninstall_schedule,
)

WEEK = date(2026, 9, 28)   # a Monday, US daylight time


def test_new_york_time_converted_to_local_weekday_and_hour():
    kolkata = calendar_intervals(time(10, 0), local_tz=ZoneInfo("Asia/Kolkata"), week_of=WEEK)
    assert kolkata[0] == {"Weekday": 1, "Hour": 19, "Minute": 30}
    assert len(kolkata) == 5
    # 10:00 EDT is 03:00 the next day in Auckland (NZDT): Monday NY → Tuesday local.
    auckland = calendar_intervals(time(10, 0), local_tz=ZoneInfo("Pacific/Auckland"), week_of=WEEK)
    assert auckland[0] == {"Weekday": 2, "Hour": 3, "Minute": 0}
    assert auckland[-1]["Weekday"] == 6


def test_install_writes_both_agents_and_bootstraps(tmp_path):
    calls = []
    paths = install_schedule(
        mandate=tmp_path / "m.yaml", universe=tmp_path / "u.txt", log_dir=tmp_path / "logs",
        python="/venv/bin/python", agents_dir=tmp_path / "agents",
        run=lambda cmd, **kw: calls.append(cmd),
    )
    assert [p.name for p in paths] == ["ai.hedgefund.paper.reconcile.plist", "ai.hedgefund.paper.submit.plist"]
    plist = plistlib.loads(paths[1].read_bytes())
    assert plist["ProgramArguments"][:4] == ["/venv/bin/python", "-m", "hedge_fund.live.cli", "submit"]
    assert len(plist["StartCalendarInterval"]) == 5
    assert any(cmd[1] == "bootstrap" for cmd in calls)
    assert schedule_installed(tmp_path / "agents")
    removed = uninstall_schedule(agents_dir=tmp_path / "agents", run=lambda cmd, **kw: None)
    assert len(removed) == 2 and not schedule_installed(tmp_path / "agents")
```

- [ ] **Step 2: Run to verify failure**

Run: `.venv/bin/python -m pytest hedge_fund/live/test_launchd.py -q`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Implement** — create `hedge_fund/live/launchd.py`:

```python
"""Run the paper fund on a schedule with macOS LaunchAgents.

Two jobs, weekdays, in New York time: reconcile at 09:00 (records the
previous session) and submit at 10:00 (does nothing unless it is a rebalance
day). launchd fires in *local* time, so New York times are converted when the
jobs are installed — reinstall after a daylight-saving change on either side.
The Mac must be awake at those times.
"""

from __future__ import annotations

import json
import os
import plistlib
import subprocess
import sys
from datetime import date, datetime, time, timedelta, tzinfo
from pathlib import Path
from typing import Callable

from hedge_fund.data.sessions import NEW_YORK
from hedge_fund.paths import USER_DIR

LAUNCH_AGENTS = Path.home() / "Library" / "LaunchAgents"
LABEL_PREFIX = "ai.hedgefund.paper."
JOBS = {"reconcile": time(9, 0), "submit": time(10, 0)}   # New York times, run in this order


def calendar_intervals(ny_time: time, *, local_tz: tzinfo | None = None, week_of: date | None = None) -> list[dict[str, int]]:
    """launchd StartCalendarInterval entries for `ny_time` on each New York weekday."""
    week_of = week_of or datetime.now(NEW_YORK).date()
    monday = week_of - timedelta(days=week_of.weekday())
    intervals = []
    for offset in range(5):
        ny = datetime.combine(monday + timedelta(days=offset), ny_time, NEW_YORK)
        local = ny.astimezone(local_tz) if local_tz else ny.astimezone()
        intervals.append({"Weekday": local.isoweekday() % 7, "Hour": local.hour, "Minute": local.minute})
    return intervals


def install_schedule(
    *, mandate: Path, universe: Path, log_dir: Path, python: str = sys.executable,
    agents_dir: Path = LAUNCH_AGENTS, run: Callable = subprocess.run,
) -> list[Path]:
    agents_dir.mkdir(parents=True, exist_ok=True)
    log_dir.mkdir(parents=True, exist_ok=True)
    USER_DIR.mkdir(parents=True, exist_ok=True)
    domain = f"gui/{os.getuid()}"
    paths = []
    for step, ny_time in JOBS.items():
        path = agents_dir / f"{LABEL_PREFIX}{step}.plist"
        run(["launchctl", "bootout", domain, str(path)], check=False, capture_output=True)
        path.write_bytes(plistlib.dumps({
            "Label": LABEL_PREFIX + step,
            "ProgramArguments": [python, "-m", "hedge_fund.live.cli", step,
                                 "--mandate", str(mandate), "--universe", str(universe)],
            "StartCalendarInterval": calendar_intervals(ny_time),
            "WorkingDirectory": str(USER_DIR),
            "StandardOutPath": str(log_dir / f"launchd-{step}.out.log"),
            "StandardErrorPath": str(log_dir / f"launchd-{step}.err.log"),
        }))
        run(["launchctl", "bootstrap", domain, str(path)], check=True)
        paths.append(path)
    return paths


def uninstall_schedule(*, agents_dir: Path = LAUNCH_AGENTS, run: Callable = subprocess.run) -> list[Path]:
    domain = f"gui/{os.getuid()}"
    removed = []
    for step in JOBS:
        path = agents_dir / f"{LABEL_PREFIX}{step}.plist"
        if path.exists():
            run(["launchctl", "bootout", domain, str(path)], check=False, capture_output=True)
            path.unlink()
            removed.append(path)
    return removed


def schedule_installed(agents_dir: Path = LAUNCH_AGENTS) -> bool:
    return all((agents_dir / f"{LABEL_PREFIX}{step}.plist").exists() for step in JOBS)


def notify(title: str, message: str) -> None:
    """Best-effort macOS notification; never raises."""
    script = f"display notification {json.dumps(message[:200], ensure_ascii=False)} with title {json.dumps(title, ensure_ascii=False)}"
    try:
        subprocess.run(["osascript", "-e", script], check=False, capture_output=True)
    except OSError:
        pass
```

- [ ] **Step 4: Run tests**

Run: `.venv/bin/python -m pytest hedge_fund/live -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hedge_fund/live/launchd.py hedge_fund/live/test_launchd.py
git commit -m "Schedule the paper fund with launchd

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Mandate, universe, and `aihf-paper` CLI

**Files:**
- Create: `hedge_fund/fund/paper.yaml`, `hedge_fund/fund/paper_universe.txt`, `hedge_fund/live/cli.py`
- Modify: `hedge_fund/live/__init__.py`, `pyproject.toml`
- Test: `hedge_fund/live/test_cli.py`

- [ ] **Step 1: Create `hedge_fund/fund/paper.yaml`**

```yaml
# The Alpaca paper fund. All four library strategies, long/short, unlevered.
# Run it with `aihf-paper` (see README "Paper trading on Alpaca").
schema_version: 2
name: paper-fund
strategies:
  - name: fundamental-ls        # all five personas, dollar-neutral
    weight: 0.35
    blend: {mode: dollar_neutral}
    models:
      - name: buffett
      - name: munger
      - name: graham
      - name: lynch
      - name: druckenmiller
  - name: deep-value            # Graham-led, long-only
    weight: 0.20
    blend: {mode: long_only}
    models:
      - name: graham
        weight: 2.0
      - name: buffett
      - name: munger
  - name: inflections           # fundamentals rate-of-change, long/short
    weight: 0.20
    blend: {mode: long_short}
    models:
      - name: druckenmiller
      - name: lynch
  - name: earnings-drift        # PEAD held ~6 weeks with a fading view
    weight: 0.25
    blend: {mode: long_short}
    models:
      - name: pead
        params: {signal_window_days: 45, decay: true}
risk:
  max_position_pct: 0.10        # no name above 10% of equity
  max_gross_exposure: 1.0       # unlevered
costs:
  commission_bps: 5             # per side, bps of notional
  borrow_bps_annual: 50         # general-collateral large-cap borrow
capital: 100000
rebalance: weekly
benchmark: SPY
```

- [ ] **Step 2: Create `hedge_fund/fund/paper_universe.txt`**

```
# Paper fund universe: liquid large caps across sectors. One or more per line; # starts a comment.
AAPL MSFT NVDA GOOGL META AVGO ORCL   # technology / communication
AMZN TSLA HD MCD                      # consumer discretionary
WMT PG KO COST                        # consumer staples
LLY UNH JNJ MRK ABBV                  # health care
JPM BAC V GS BRK.B                    # financials
XOM CVX                               # energy
CAT GE                                # industrials
NFLX DIS                              # media
NEE                                   # utilities
```

- [ ] **Step 3: Write failing tests** — create `hedge_fund/live/test_cli.py`:

```python
from hedge_fund.fund.spec import load_spec
from hedge_fund.live.cli import DEFAULT_MANDATE, DEFAULT_UNIVERSE, build_parser, load_universe
from hedge_fund.signals import PEADModel


def test_packaged_universe():
    universe = load_universe(DEFAULT_UNIVERSE)
    assert len(universe) == 32
    assert universe[:2] == ["AAPL", "MSFT"] and "BRK.B" in universe


def test_universe_parsing(tmp_path):
    path = tmp_path / "u.txt"
    path.write_text("# header\naapl msft  # comment\n\nNVDA\naapl\n")
    assert load_universe(path) == ["AAPL", "MSFT", "NVDA"]


def test_packaged_paper_mandate_is_valid():
    spec = load_spec(DEFAULT_MANDATE)
    assert spec.name == "paper-fund"
    assert [s.name for s in spec.strategies] == ["fundamental-ls", "deep-value", "inflections", "earnings-drift"]
    assert spec.risk.max_position_pct == 0.10 and spec.costs.commission_bps == 5
    pead = spec.strategies[-1].models[0]
    assert PEADModel(**pead.params)._decay is True


def test_parser_defaults():
    args = build_parser().parse_args(["submit", "--dry-run"])
    assert args.command == "submit" and args.dry_run is True
    assert args.mandate == str(DEFAULT_MANDATE)
```

- [ ] **Step 4: Run to verify failure**

Run: `.venv/bin/python -m pytest hedge_fund/live/test_cli.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'hedge_fund.live.cli'`.

- [ ] **Step 5: Implement** — create `hedge_fund/live/cli.py`:

```python
"""aihf-paper — run the fund on an Alpaca paper account.

    aihf-paper status                  account, halts, last NAV, schedule
    aihf-paper submit [--dry-run]      plan (and send) today's MOC rebalance
    aihf-paper reconcile               record the previous session's fills + NAV
    aihf-paper report [--backtest F] [--attribution]
    aihf-paper baseline [--start D] [--end D]
    aihf-paper flatten --yes           halt and close every position at today's close
    aihf-paper resume                  clear a halt
    aihf-paper install-schedule | uninstall-schedule

Paper only: the Alpaca client refuses any endpoint but paper-api.alpaca.markets.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from datetime import date, datetime
from pathlib import Path

from hedge_fund.backtesting.fund import FundBacktestResult
from hedge_fund.brokers.alpaca import AlpacaPaperClient
from hedge_fund.data import CachedDataClient, FDClient
from hedge_fund.data.sessions import NEW_YORK, completed_through
from hedge_fund.fund import Fund, FundSpec, load_spec, normalize_universe
from hedge_fund.live.baseline import POST_CUTOFF_START, run_baseline
from hedge_fund.live.launchd import install_schedule, notify, schedule_installed, uninstall_schedule
from hedge_fund.live.ledger import Ledger
from hedge_fund.live.report import MIN_REBALANCES_FOR_VERDICT, build_report, strategy_attribution
from hedge_fund.live.runner import reconcile, session_to_reconcile, submit
from hedge_fund.paths import KILL_PATH
from hedge_fund.tui.keys import apply_credentials

logger = logging.getLogger("aihf-paper")

PACKAGE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_MANDATE = PACKAGE_DIR / "fund" / "paper.yaml"
DEFAULT_UNIVERSE = PACKAGE_DIR / "fund" / "paper_universe.txt"


def load_universe(path: str | Path) -> list[str]:
    """Tickers from a text file: whitespace-separated, `#` comments, duplicates dropped."""
    tickers: list[str] = []
    for line in Path(path).read_text().splitlines():
        tickers.extend(line.split("#", 1)[0].split())
    return normalize_universe(tickers)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="aihf-paper", description="Run the fund on an Alpaca paper account.")
    sub = parser.add_subparsers(dest="command", required=True)

    def command(name: str, help: str) -> argparse.ArgumentParser:
        p = sub.add_parser(name, help=help)
        p.add_argument("--mandate", default=str(DEFAULT_MANDATE), help="fund spec YAML")
        p.add_argument("--universe", default=str(DEFAULT_UNIVERSE), help="ticker list file")
        p.add_argument("--model", help="LLM for the investor agents, e.g. claude-opus-5-5")
        return p

    command("submit", "plan and send today's market-on-close rebalance").add_argument(
        "--dry-run", action="store_true", help="plan and save, send nothing (works any day)")
    command("reconcile", "record the previous session's fills and closing NAV")
    p = command("report", "paper performance from the ledger")
    p.add_argument("--backtest", help="a backtest result JSON to compare over the same dates")
    p.add_argument("--attribution", action="store_true", help="per-strategy contribution (fetches prices)")
    command("status", "account, halts, last NAV, schedule")
    command("flatten", "halt and close every position at today's close").add_argument("--yes", action="store_true")
    command("resume", "clear a halt so the fund trades again")
    p = command("baseline", "backtest the fund, each strategy, SPY and equal-weight")
    p.add_argument("--start", default=POST_CUTOFF_START)
    p.add_argument("--end", default=completed_through())
    p.add_argument("--out", help="where to write the JSON (default: the ledger's baseline/ dir)")
    command("install-schedule", "install the launchd jobs")
    command("uninstall-schedule", "remove the launchd jobs")
    return parser


def main(argv: list[str] | None = None) -> int:
    apply_credentials()
    args = build_parser().parse_args(argv)
    if args.model:
        os.environ["HEDGE_FUND_LLM_MODEL"] = args.model
    spec = load_spec(args.mandate)
    ledger = Ledger.for_fund(spec.name)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s", force=True,
        handlers=[logging.StreamHandler(), logging.FileHandler(ledger.log_path(date.today().isoformat(), args.command))],
    )
    try:
        return _COMMANDS[args.command](args, spec, ledger)
    except Exception as exc:
        logger.exception("%s failed", args.command)
        notify(f"aihf-paper {args.command} failed", str(exc))
        return 1


def _submit(args, spec: FundSpec, ledger: Ledger) -> int:
    fund = Fund(spec)
    with FDClient() as raw:
        result = submit(fund, load_universe(args.universe), AlpacaPaperClient(), CachedDataClient(raw),
                        ledger, now=datetime.now(NEW_YORK), dry_run=args.dry_run)
    print(f"{result.session}: {result.status} {result.detail}")
    if result.plan:
        print(f"equity ${result.plan.equity:,.2f} · {len(result.plan.targets)} targets · {len(result.plan.orders)} orders")
        for o in result.plan.orders:
            print(f"  {o.side:4} {o.quantity:>6} {o.ticker:6} ref ${o.price:,.2f}  (${o.quantity * o.price:,.0f})")
    for r in result.orders:
        if r.status == "rejected":
            print(f"  REJECTED {r.ticker}: {r.reason}")
    return 0


def _reconcile(args, spec: FundSpec, ledger: Ledger) -> int:
    client = AlpacaPaperClient()
    session = session_to_reconcile(client, datetime.now(NEW_YORK))
    with FDClient() as raw:
        result = reconcile(spec, client, CachedDataClient(raw), ledger, session=session)
    print(f"{session}: equity ${result.nav.equity:,.2f} · gross {result.nav.gross:.0%} · {len(result.fills)} fills")
    for message in result.mismatches:
        print(f"  WARNING {message}")
    return 0


def _report(args, spec: FundSpec, ledger: Ledger) -> int:
    backtest = FundBacktestResult.model_validate_json(Path(args.backtest).read_text()) if args.backtest else None
    report = build_report(ledger, backtest=backtest)
    if report is None:
        print("not enough history yet: need at least two reconciled sessions")
        return 0
    if args.attribution:
        with FDClient() as raw:
            report.strategy_contribution = strategy_attribution(ledger, CachedDataClient(raw))
    print(report.model_dump_json(indent=2))
    if report.n_rebalances < MIN_REBALANCES_FOR_VERDICT:
        print(f"note: {report.n_rebalances} rebalances so far; no verdict before {MIN_REBALANCES_FOR_VERDICT}", file=sys.stderr)
    return 0


def _status(args, spec: FundSpec, ledger: Ledger) -> int:
    client = AlpacaPaperClient()
    account = client.account()
    positions = client.positions()
    rows = ledger.nav_rows()
    halted = ledger.halted_path.read_text().strip() if ledger.is_halted() else "no"
    print(f"fund {spec.name} · account {account.status} · equity ${account.equity:,.2f} · cash ${account.cash:,.2f}")
    print(f"positions {len(positions)} ({sum(s < 0 for s in positions.values())} short)")
    print(f"kill switch {'ON' if KILL_PATH.exists() else 'off'} · halted: {halted}")
    print(f"last reconciled: {rows[-1].date} ${rows[-1].equity:,.2f}" if rows else "last reconciled: never")
    print(f"schedule {'installed' if schedule_installed() else 'not installed'} "
          "(local times; reinstall after a DST change; the Mac must be awake at 09:00 and 10:00 ET)")
    print(f"ledger {ledger.root}")
    return 0


def _flatten(args, spec: FundSpec, ledger: Ledger) -> int:
    if not args.yes:
        print("flatten halts the fund and closes every position at today's close; re-run with --yes")
        return 2
    ledger.halt("manual flatten via `aihf-paper flatten`. Run `aihf-paper resume` to trade again.")
    args.dry_run = False
    return _submit(args, spec, ledger)


def _resume(args, spec: FundSpec, ledger: Ledger) -> int:
    print("resumed" if ledger.resume() else "was not halted")
    return 0


def _baseline(args, spec: FundSpec, ledger: Ledger) -> int:
    with FDClient() as raw:
        report = run_baseline(spec, load_universe(args.universe), args.start, args.end, CachedDataClient(raw))
    out = Path(args.out) if args.out else ledger.root / "baseline" / f"{args.start}_{args.end}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(report.model_dump_json(indent=2))
    label = " (POSSIBLY MEMORIZED: window starts before the LLM's training cutoff)" if report.possibly_memorized else ""
    print(f"baseline {report.start} → {report.end}{label}")
    print(f"{'variant':24} {'return':>8} {'annual':>8} {'sharpe':>7} {'max dd':>7} {'costs':>9}  beats both?")
    for r in report.rows:
        verdict = {True: "yes", False: "no", None: "-"}[r.beats_benchmarks]
        print(f"{r.name:24} {r.total_return_pct:>+8.1%} {r.annualized_return_pct:>+8.1%} {r.sharpe_ratio:>7.2f} "
              f"{r.max_drawdown_pct:>7.1%} {r.total_costs:>9,.0f}  {verdict}")
    print(f"saved {out}")
    return 0


def _install(args, spec: FundSpec, ledger: Ledger) -> int:
    paths = install_schedule(mandate=Path(args.mandate).resolve(), universe=Path(args.universe).resolve(),
                             log_dir=ledger.root / "logs")
    for path in paths:
        print(f"installed {path}")
    print("reconcile 09:00 ET and submit 10:00 ET on weekdays; the Mac must be awake then")
    return 0


def _uninstall(args, spec: FundSpec, ledger: Ledger) -> int:
    for path in uninstall_schedule():
        print(f"removed {path}")
    return 0


_COMMANDS = {
    "submit": _submit, "reconcile": _reconcile, "report": _report, "status": _status,
    "flatten": _flatten, "resume": _resume, "baseline": _baseline,
    "install-schedule": _install, "uninstall-schedule": _uninstall,
}


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 6: Register the script** — in `pyproject.toml` under `[tool.poetry.scripts]` add:

```toml
aihf-paper = "hedge_fund.live.cli:main"
```

and update `hedge_fund/live/__init__.py` to:

```python
"""Live (paper) trading: plan, submit, reconcile, report.

Entry point: `aihf-paper` (hedge_fund/live/cli.py).
"""
```

Then reinstall so the script exists: `uv pip install --python .venv/bin/python -e .`

- [ ] **Step 7: Run tests**

Run: `.venv/bin/python -m pytest hedge_fund -q && .venv/bin/aihf-paper --help`
Expected: all tests PASS; help lists the nine commands.

- [ ] **Step 8: Commit**

```bash
git add hedge_fund/fund/paper.yaml hedge_fund/fund/paper_universe.txt hedge_fund/live/cli.py hedge_fund/live/__init__.py hedge_fund/live/test_cli.py pyproject.toml
git commit -m "Add the paper mandate, universe and aihf-paper CLI

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Docs

**Files:**
- Modify: `.env.example`, `README.md`, `ROADMAP.md`

- [ ] **Step 1: `.env.example`** — append:

```
# For paper trading on Alpaca (aihf-paper). PAPER keys only — the client
# refuses any endpoint but paper-api.alpaca.markets.
# Get them from https://app.alpaca.markets (Paper Trading → API Keys).
APCA_API_KEY_ID=your-alpaca-paper-key-id
APCA_API_SECRET_KEY=your-alpaca-paper-secret-key
```

- [ ] **Step 2: `README.md`** — add a section after "How to Run":

````markdown
## Paper trading on Alpaca

`aihf-paper` runs a fund forward on an Alpaca **paper** account (simulated money;
the client refuses any other endpoint). It trades exactly like the backtester:
on the first session of each rebalance period it assesses with data through the
previous close and submits market-on-close orders, so paper and backtest results
are directly comparable.

Add `APCA_API_KEY_ID` / `APCA_API_SECRET_KEY` (paper keys) to `~/.hedge-fund/.env`, then:

```bash
aihf-paper status               # account, halts, last NAV
aihf-paper submit --dry-run     # see the plan, send nothing
aihf-paper baseline             # backtest fund, each strategy, SPY, equal-weight
aihf-paper install-schedule     # reconcile 09:00 ET, submit 10:00 ET, weekdays
aihf-paper report               # paper return vs benchmark, slippage, fills
```

Defaults: `hedge_fund/fund/paper.yaml` (all four strategies, long/short, unlevered,
10% per name) over `hedge_fund/fund/paper_universe.txt` (32 large caps). The books
live in `~/.hedge-fund/paper/<fund>/`. Safety: `touch ~/.hedge-fund/KILL` stops all
trading; a 15% drawdown from peak halts and flattens the fund until
`aihf-paper resume`; `aihf-paper flatten --yes` does the same by hand.
````

- [ ] **Step 3: `ROADMAP.md`** — change the two rows:

```
| ↳ Paper broker | ✅ (Alpaca paper via `aihf-paper`: MOC orders, reconcile, ledger) |
```

```
| Scheduler / daemon — market-calendar cron, idempotent ticks, kill-switch | 🚧 (macOS launchd for the paper fund, idempotent submit, kill switch, drawdown halt) |
```

- [ ] **Step 4: Commit**

```bash
git add .env.example README.md ROADMAP.md
git commit -m "Document Alpaca paper trading

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Acceptance against the real paper account (needs the user's keys)

No code. Requires `APCA_API_KEY_ID`, `APCA_API_SECRET_KEY`, `FINANCIAL_DATASETS_API_KEY` and an LLM key in `~/.hedge-fund/.env` — the user adds these; never echo or log them.

- [ ] **Step 1:** `.venv/bin/aihf-paper status` → shows `account ACTIVE` and ~$100k equity.
- [ ] **Step 2:** `.venv/bin/aihf-paper submit --dry-run` → prints a plan: ≤10% per name, gross ≤ 100%, sells before buys; `~/.hedge-fund/paper/paper-fund/plans/<today>.dryrun.json` exists. Review it with the user.
- [ ] **Step 3:** `.venv/bin/aihf-paper baseline` → post-cutoff table with fund, four strategies, equal-weight and SPY. Record the table in the session summary.
- [ ] **Step 4:** With the user's go-ahead: `.venv/bin/aihf-paper install-schedule`, then `launchctl list | grep hedgefund` shows both jobs.
- [ ] **Step 5:** After the first rebalance day: `aihf-paper report` and check `fills/<session>.json` slippage.
````
