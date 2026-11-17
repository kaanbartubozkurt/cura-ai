"""Describe failures seen on DEV 2026-11-16/17 (batches 2361 and 2383)."""
from contextlib import nullcontext
from decimal import Decimal
from unittest.mock import MagicMock

import pytest

from app.providers.fal_vision_provider import STOPPED_EARLY, _cut_off_json, _extract_json
from app.services.billing_orchestrator import BillingOrchestrator


@pytest.mark.parametrize("content,key,cut", [
    # Gemini's safety filter stopped mid-answer (batch 2361, image 6980).
    ('{"description": "The image features one young adult female subject with fair skin', "description", True),
    ('```json\n{"tags": ["single-woman", "young-', "tags", True),
    ('{"description": "A complete answer."}', "description", False),
    ('```json\n{"tags": ["a", "b"]}\n```', "tags", False),
    ('{"tags": [], "error": "refused"}', "tags", False),  # explicit refusal keeps its own reason
    ("A plain-text description without JSON.", "description", False),  # still saved as before
])
def test_cut_off_answers_are_detected(content, key, cut):
    assert _cut_off_json(content, _extract_json(content), key) is cut


def test_stopped_early_message_suggests_another_model():
    assert "another model" in STOPPED_EARLY


def _orchestrator():
    orchestrator = BillingOrchestrator.__new__(BillingOrchestrator)
    orchestrator.db = MagicMock()
    orchestrator.db.begin_nested.return_value = nullcontext()
    orchestrator.user_id = 1
    return orchestrator


def test_anomaly_with_decimal_detail_is_stored_as_json_in_a_savepoint():
    orchestrator = _orchestrator()
    orchestrator._create_anomaly("zero_cost_actual", "fal", "google/gemini-3.8-flash", "describe",
                                 {"decision_id": 4858, "sparks": Decimal("0.00")})
    orchestrator.db.begin_nested.assert_called_once()
    anomaly = orchestrator.db.add.call_args.args[0]
    assert anomaly.detail == {"decision_id": 4858, "sparks": "0.00"}


def test_anomaly_failure_never_raises():
    orchestrator = _orchestrator()
    orchestrator.db.flush.side_effect = RuntimeError("db down")
    orchestrator._create_anomaly("zero_cost_actual", "fal", "m", "describe", {"sparks": Decimal("0")})


def test_batch_lock_targets_only_the_jobs_table():
    import inspect

    from app.workers import tasks

    for task in (tasks.run_batch_reprocess, tasks.run_batch_describe):
        source = inspect.getsource(task.run)
        assert ".with_for_update(of=Job)" in source
        assert ".with_for_update()" not in source
