from pathlib import Path

import yaml

WORKFLOW = Path(__file__).resolve().parents[2] / "deploy" / "github-actions" / "daily.yml"


def test_workflow_shape():
    wf = yaml.safe_load(WORKFLOW.read_text())
    triggers = wf.get("on") or wf.get(True)                 # YAML 1.1 reads a bare `on` as True
    # off-peak backups only; the 08:00 alarm is the Cloudflare Worker (GitHub's top-of-hour cron runs late)
    assert triggers["schedule"] == [{"cron": "37 8 * * 1-5"}, {"cron": "7 11 * * 1-5"}]
    assert triggers["workflow_dispatch"]["inputs"]["source"]["options"] == ["manual", "alarm"]
    assert wf["concurrency"]["group"] == "hedge-fund-daily" and wf["concurrency"]["cancel-in-progress"] is False
    steps = wf["jobs"]["daily"]["steps"]
    run = next(s for s in steps if s.get("id") == "run")
    assert run["run"].strip() == "aihf-daily --notify"
    assert "ANTHROPIC_API_KEY" in run["env"] and "TELEGRAM_BOT_TOKEN" in run["env"]
    save = next(s for s in steps if s.get("name") == "Save state")
    assert save["if"] == "always() && steps.gate.outputs.skip != 'true'" and "git push" in save["run"]


def test_automatic_runs_skip_a_day_that_already_succeeded():
    wf = yaml.safe_load(WORKFLOW.read_text())
    steps = wf["jobs"]["daily"]["steps"]
    names = [s.get("name") or s.get("uses") for s in steps]
    gate = steps[names.index("Already ran today?")]
    assert names.index("State") < names.index("Already ran today?") < names.index("Run")
    assert "schedule" in gate["env"]["AUTOMATIC"] and "alarm" in gate["env"]["AUTOMATIC"]
    assert "state/last-success" in gate["run"]
    for s in steps[names.index("Already ran today?") + 1:]:
        assert "steps.gate.outputs.skip != 'true'" in s["if"], s
    mark = steps[names.index("Mark today done")]
    assert mark["if"].startswith("success()") and "state/last-success" in mark["run"]
    assert names.index("Mark today done") < names.index("Save state")
