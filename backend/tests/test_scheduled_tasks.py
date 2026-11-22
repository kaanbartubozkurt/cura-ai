"""Scheduled maintenance must actually run, exactly once (#150)."""
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

from app.workers import tasks
from app.workers.celery_app import celery_app

ROOT = Path(__file__).resolve().parents[2]


def test_clustering_worker_runs_beat_and_is_single_replica():
    module = (ROOT / "infra/modules/container_apps/main.tf").read_text()
    clustering = module[module.index('resource "azurerm_container_app" "celery_worker_clustering"'):]
    clustering = clustering[: clustering.index('resource "azurerm_container_app"', 10)]
    assert '"-B"' in clustering
    variables = (ROOT / "infra/modules/container_apps/variables.tf").read_text()
    block = variables[variables.index('variable "celery_clustering_max_replicas"'):]
    assert "var.celery_clustering_max_replicas == 1" in block[: block.index("\n}\n")]
    for env in ("dev", "prod"):
        text = (ROOT / f"infra/environments/{env}/main.tf").read_text()
        if "celery_clustering_max_replicas" in text:
            line = next(row for row in text.splitlines() if "celery_clustering_max_replicas" in row)
            assert line.split("=")[1].split("#")[0].strip() == "1", env


def test_every_scheduled_task_is_registered():
    celery_app.loader.import_default_modules()  # what a worker does at startup (include=[...])
    for entry in celery_app.conf.beat_schedule.values():
        assert entry["task"] in celery_app.tasks, entry["task"]


def test_reconciliation_anomaly_stores_decimal_detail_as_json():
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = None  # not flagged yet
    decision = SimpleNamespace(id=7, trace_id="t", user_id=1, provider="fal",
                               model="m", operation="describe")
    tasks._create_reconciliation_anomaly(
        db, decision, "stale_decision", {"reserved_sparks": Decimal("20.67"), "age_minutes": 31.5})
    anomaly = db.add.call_args.args[0]
    assert anomaly.detail == {"reserved_sparks": "20.67", "age_minutes": 31.5, "decision_id": 7, "trace_id": "t"}
