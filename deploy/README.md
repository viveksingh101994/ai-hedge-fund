# Scheduled runs on GitHub Actions + Telegram

Runs the daily routine (`aihf-daily`) at 08:00 UTC on weekdays — US
pre-market all year — without your laptop, and sends the result to Telegram.
It runs in a **private** repo: this public fork can't be made private, and
the saved state contains your account values and positions.

Design: `docs/superpowers/specs/2026-10-05-scheduled-runner-design.md`.

## 1. Telegram (once)

1. In Telegram, message **@BotFather** → `/newbot` → copy the bot token.
2. Put it in this project's `.env` as `TELEGRAM_BOT_TOKEN=...` (never paste it into a chat).
3. Send your new bot any message ("hi"), then run:

   ```bash
   .venv/bin/aihf-daily --find-chat-id
   ```

   Add the number it prints to `.env` as `TELEGRAM_CHAT_ID=...`.
4. Test locally:

   ```bash
   .venv/bin/aihf-daily --mode paper --notify
   ```

## 2. The private runner repo (once)

```bash
gh repo create ai-hedge-fund-runner --private
git clone https://github.com/<you>/ai-hedge-fund-runner.git ~/ai-hedge-fund-runner
cd ~/ai-hedge-fund-runner
mkdir -p .github/workflows
cp ~/Desktop/Projects/ai-hedge-fund/deploy/github-actions/daily.yml .github/workflows/daily.yml
git add . && git commit -m "Add the daily workflow" && git push -u origin main
```

Seed the `state` branch from your current `~/.hedge-fund` (ledgers and the
AI-answer cache; never `market.db` or `.env`):

```bash
git switch --orphan state
cp ~/Desktop/Projects/ai-hedge-fund/deploy/state.gitignore .gitignore
cp -R ~/.hedge-fund/paper ~/.hedge-fund/crypto ./ 2>/dev/null
mkdir -p cache && cp -R ~/.hedge-fund/cache/llm cache/
[ -f ~/Desktop/Projects/ai-hedge-fund/live.yaml ] && cp ~/Desktop/Projects/ai-hedge-fund/live.yaml ./
git add -A && git commit -m "Seed state" && git push -u origin state
```

## 3. Secrets and settings (in GitHub: repo → Settings → Secrets and variables → Actions)

**Secrets** (you paste these yourself):

| Secret | Needed for |
|---|---|
| `APCA_API_KEY_ID`, `APCA_API_SECRET_KEY` | paper account + free price data |
| `SEC_USER_AGENT` | free SEC fundamentals (e.g. `Your Name you@example.com`) |
| `ANTHROPIC_API_KEY` | the investor agents (Opus) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | notifications |
| `ALPACA_LIVE_KEY_ID`, `ALPACA_LIVE_SECRET_KEY` | only when you go live |

**Variables:**

| Variable | Value |
|---|---|
| `RUN_MODE` | `paper` (later `paper+live-dry`, then `paper+live`; `off` pauses) |
| `CODE_REF` | the branch of this repo to run, e.g. `alpaca-paper-trading` or `main` |
| `CODE_REPO` | optional; defaults to `viveksingh101994/ai-hedge-fund` |

## 4. First run

Actions tab → **hedge-fund daily** → **Run workflow**. A Telegram message
arrives when it finishes (✅ or ❌ with the failing step and a log link).
If you installed the Mac schedule, remove it so runs don't double up:
`.venv/bin/aihf-paper uninstall-schedule`.

## 5. The 08:00 alarm clock (Cloudflare Worker, once)

GitHub's own schedule starts runs hours late, or skips them, when Actions is
busy (the top of every hour is the busiest). So a free Cloudflare Worker
presses "Run workflow" at 08:00 UTC instead; GitHub's timer stays as an
off-peak backup (08:37 and 11:07 UTC) that does nothing once the day has
succeeded.

1. **GitHub token** (only you see it): github.com → Settings → Developer
   settings → Personal access tokens → **Fine-grained tokens** → Generate new
   token. Name it `hedge-fund-alarm`; pick the longest expiry; Repository
   access → **Only select repositories** → `ai-hedge-fund-runner`;
   Permissions → Repository → **Actions: Read and write**. Copy the token.
2. **Deploy** (a free Cloudflare account; the first command opens a browser to log in):

   ```bash
   cd deploy/cloudflare-trigger
   npx wrangler login
   npx wrangler deploy
   npx wrangler secret put GITHUB_TOKEN
   ```

   The last command asks for the token: paste it there, never into a chat.
3. **Check** without starting a run: open the `…workers.dev` address that
   `deploy` printed, with `/check` on the end. It should say `"ok": true`.

When the token expires, make a new one and run `npx wrangler secret put
GITHUB_TOKEN` again. Workflow runs started by hand ("Run workflow") always
run; only the alarm and the backup timers skip a day that already succeeded.

## Day to day

- **Switch modes:** change the `RUN_MODE` variable (website or GitHub app).
  `paper+live` still needs the live keys, `confirm_live: true` in `live.yaml`
  and one completed live dry run — the setting alone can't trade real money.
- **Edit `live.yaml`:** on the `state` branch in the GitHub web editor.
- **Crypto trend (ma100):** `crypto_trend: shadow` reports in Telegram what
  ma100 would do while still buying and holding; `crypto_trend: ma100` trades
  it with limit orders; `off` is plain buy-and-hold.
- **Pause:** `RUN_MODE=off`, or create a file named `KILL` on the `state` branch.
- **Run now:** "Run workflow", optionally choosing a mode for that run.
- **History:** every run commits the ledgers to the `state` branch.

Cost: roughly 100–300 of the 2,000 free Actions minutes a month for private
repos; Telegram is free; Anthropic usage is unchanged.
