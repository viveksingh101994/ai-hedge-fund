# Scheduled Runner (GitHub Actions + Telegram) — Design

Date: 2026-10-05 · Status: approved in brainstorming, pending spec review

## Goal

Run the daily routine (paper fund, optionally the live account) without the
user's laptop, on a free schedule, and send the result to the user's phone.
Switching between paper, live dry-run and live must take seconds and must
never be able to trade real money by accident.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Platform | GitHub Actions scheduled workflow. Not Cloudflare Workers/Workflows: Python + pandas/langchain + a 224 MB SQLite DB + a file ledger don't fit Workers' runtime or free CPU limits; Cloudflare Containers are paid |
| Where it runs | A new **private** repo (e.g. `ai-hedge-fund-runner`). The user's repo is a public fork and can't be made private; state (account values, positions) must not be public |
| Code | Pulled from the public fork at a configurable ref on every run; the private repo holds only the workflow and state |
| Notifications | Telegram bot (free, one HTTPS request per message) |
| Switching | Repo variable `RUN_MODE`: `off` · `paper` · `paper+live-dry` · `paper+live` |
| Time | 08:00 UTC, Monday–Friday (US pre-market: 03:00–04:00 New York); manual "Run workflow" button too |

Timing rationale: the run must (1) start after the previous US close is
final and (2) finish reconciling before the 09:30 New York open, after which
the day's fills change the book. 08:00 UTC sits inside that window all year
with ~5½ hours of buffer for GitHub's best-effort cron delays and a re-run;
pre-market orders fill at the opening auction. Running in US market hours
would make reconcile refuse and fill orders at random intraday prices.

## 1. `aihf-daily` (in this repo)

`hedge_fund/ops/daily.py`, entry point `aihf-daily`:

```
aihf-daily [--mode off|paper|paper+live-dry|paper+live] [--notify]
```

- `--mode` defaults to the `RUN_MODE` environment variable, else `paper`.
- Steps per mode, run in-process by calling the existing CLIs' `main()` with
  stdout captured:

| Mode | Steps |
|---|---|
| `off` | none ("paused") |
| `paper` | `aihf-paper reconcile`, `aihf-paper submit` |
| `paper+live-dry` | paper steps, then `aihf-live run --dry-run` |
| `paper+live` | paper steps, then `aihf-live run` |

- Every step runs even if an earlier one failed (a failed reconcile must not
  stop a Monday rebalance; the existing commands already guard themselves).
- Builds a summary: one header line (`✅`/`❌`, weekday + date, mode), then
  each step's name, exit status and its printed output trimmed to the last
  ~8 lines, total ≤ 3,500 characters (Telegram's limit is 4,096). A run URL
  (`GITHUB_SERVER_URL/GITHUB_REPOSITORY/actions/runs/GITHUB_RUN_ID`, when set)
  is appended.
- `--notify` sends the summary via Telegram; the summary is always printed.
- Exit code 1 if any step failed (so the Actions run shows red), after the
  notification is sent.

Live safety is unchanged and layered: `paper+live` only *invokes*
`aihf-live run`, which still refuses without live keys, `confirm_live: true`
and a completed dry run.

## 2. Telegram (`hedge_fund/ops/telegram.py`)

`send(text, *, token=None, chat_id=None, session=None) -> bool` posts to
`https://api.telegram.org/bot<token>/sendMessage`. Credentials from
`TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`. Missing credentials → returns
False and prints a hint (never fails the run). Errors never include the
token: the request URL is redacted from any exception text before logging.

## 3. Workflow (`deploy/github-actions/daily.yml`, copied into the runner repo)

- Triggers: `schedule: cron "0 8 * * 1-5"` and `workflow_dispatch` with inputs
  `mode` (choice, default from `RUN_MODE`) and `dry_run_live` (bool).
- `concurrency: hedge-fund-daily` (no overlapping runs, none cancelled).
- Steps:
  1. Checkout code: repo `vars.CODE_REPO` (default
     `viveksingh101994/ai-hedge-fund`) at `vars.CODE_REF` into `code/`.
  2. Checkout this private repo's `state` branch into `state/`; symlink
     `$HOME/.hedge-fund → state/` (the code reads `~/.hedge-fund`).
  3. Restore the market DB with `actions/cache` (key `market-db-<run id>`,
     restore prefix `market-db-`) into `state/market.db`; on a cold cache the
     free data layer re-downloads what it needs.
  4. Python 3.12 + `uv pip install -e code/`.
  5. `aihf-daily --notify` with secrets as env: `APCA_API_KEY_ID`,
     `APCA_API_SECRET_KEY`, `SEC_USER_AGENT`, `ANTHROPIC_API_KEY`,
     `ALPACA_LIVE_KEY_ID`, `ALPACA_LIVE_SECRET_KEY` (optional),
     `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`; `RUN_MODE` from the input or
     `vars.RUN_MODE`.
  6. Always: save the market DB cache; commit and push `state/` (market.db
     excluded by the state branch's `.gitignore`) as
     `state: <date> <mode>`.
- `state` branch contents: `paper/`, `live/`, `live.yaml`, `cache/llm/`,
  `crypto/`, `KILL` (optional). The user edits `live.yaml` or adds `KILL` in
  the GitHub web editor.

## 4. Setup (user-side, documented in `deploy/README.md`)

1. Create the Telegram bot (@BotFather) and get the chat ID.
2. Create the private repo (Claude may create it with `gh` on approval) with
   the workflow and an initial `state` branch seeded from the current
   `~/.hedge-fund` (ledgers, LLM cache, crypto; no market.db, no `.env`).
3. The user adds secrets in the repo settings (never via Claude) and sets
   `RUN_MODE=paper`, `CODE_REF`.
4. Run once with the "Run workflow" button; confirm the Telegram message.
5. Uninstall the Mac schedule if installed, so runs don't double up
   (the duplicate-order guard would make the second a no-op anyway).

## 5. Costs

Actions: ~3–10 min per run × ~22 runs/month ≈ 100–300 min of the 2,000 free
private-repo minutes. Telegram: free. Anthropic: unchanged (the LLM cache
travels in the state branch).

## 6. Error handling

| Failure | Behavior |
|---|---|
| A step raises / exits non-zero | Others still run; ❌ summary names it; job red |
| Telegram unreachable or not configured | Summary printed to the log; job result unchanged |
| State push conflict (manual edit during a run) | `git pull --rebase` then push; if still failing, job red and the summary says state wasn't saved |
| Cold market-DB cache | Slower run while free data re-downloads |
| Cron starts late | Harmless up to ~5 hours (pre-open window) |

## 7. Testing

`aihf-daily`: mode → steps mapping; every step runs after a failure; summary
trimming and length cap; exit code; run-URL line; `--notify` calls the
sender. Telegram: request shape, missing credentials, token redaction in
errors. Fakes only; no network. The workflow YAML is validated by a test that
loads it and checks triggers, cron, concurrency, the `aihf-daily` step and
the always-run state commit.

## 8. Out of scope

Telegram commands (two-way control), Cloudflare, an always-on VM, web
dashboards.

## 9. Addendum (2026-10-12): an outside alarm clock

In the first week GitHub's `0 8 * * 1-5` schedule started runs 6–7 hours
late (14:47, 15:16, 15:01 UTC) and skipped two days entirely; late runs fail
paper reconcile (after the US open) and trade at intraday prices. GitHub
documents that scheduled runs are delayed or dropped under load, worst at the
top of the hour.

- **Primary trigger:** a Cloudflare Worker cron (`0 8 * * MON-FRI`, free)
  calls the workflow_dispatch API with `inputs.source = alarm`, using a
  fine-grained token limited to the runner repo with Actions read/write
  (a Worker secret the user sets). `GET /check` verifies the token without
  starting a run. Code: `deploy/cloudflare-trigger/`.
- **Backup:** GitHub schedules at off-peak minutes, 08:37 and 11:07 UTC.
- **Same-day skip:** a successful run writes the UTC date to
  `state/last-success`; scheduled and alarm runs skip every later step when
  it already holds today's date (no message, no state commit). Manual runs
  always run. A failed run doesn't mark the day, so a backup retries it.
