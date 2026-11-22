"""Describe with a chosen vision model: validated by the API and passed to every image's pipeline."""
import asyncio
import contextlib
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException

from app.api import jobs as jobs_api
from app.schemas import BatchReprocessRequest
from app.services.model_catalog import offered_language_ids
from app.workers import tasks as tasks_module


def test_unknown_model_is_rejected_before_any_work(monkeypatch):
    monkeypatch.setattr(jobs_api, "_check_no_active_batch", Mock())
    db = Mock()
    with pytest.raises(HTTPException) as error:
        asyncio.run(jobs_api.trigger_reprocess_selected(
            BatchReprocessRequest(image_ids=[1], model="not-a-model"), db=db, current_user=SimpleNamespace(id=1)))
    assert error.value.status_code == 400
    db.add.assert_not_called()


def test_chosen_model_is_stored_and_dispatched(monkeypatch):
    model = offered_language_ids()[0]
    monkeypatch.setattr(jobs_api, "_check_no_active_batch", Mock())
    dispatch = Mock(return_value=SimpleNamespace(id="task"))
    monkeypatch.setattr(jobs_api, "dispatch", dispatch)
    query = Mock()
    query.filter.return_value = query
    query.all.return_value = [SimpleNamespace(id=1), SimpleNamespace(id=2)]
    db = Mock()
    db.query.return_value = query
    db.refresh.side_effect = lambda job: setattr(job, "id", 77)

    asyncio.run(jobs_api.trigger_reprocess_selected(
        BatchReprocessRequest(image_ids=[1, 2], model=model), db=db, current_user=SimpleNamespace(id=1)))

    job = db.add.call_args.args[0]
    assert job.parameters == {"model": model}
    assert dispatch.call_args.kwargs["model"] == model


def test_batch_passes_model_to_each_image(monkeypatch):
    job = SimpleNamespace(id=5, status=None, result=None, started_at=None)
    db = Mock()
    db.query.return_value.filter.return_value.first.return_value = job
    monkeypatch.setattr(tasks_module, "get_db", Mock(return_value=db))
    monkeypatch.setattr(tasks_module, "get_image_service", Mock(return_value=Mock()))
    monkeypatch.setattr(tasks_module, "write_log", Mock())
    monkeypatch.setattr(tasks_module, "_init_task_context", Mock())
    child = Mock()
    monkeypatch.setattr(tasks_module, "_dispatch_pipeline_child", child)
    # Only Phase 1 (dispatching each image) matters here; the polling loop that follows
    # can't run against a mocked database, so stop at its first sleep or error.
    monkeypatch.setattr(tasks_module.time, "sleep", Mock(side_effect=RuntimeError("stop")))

    with contextlib.suppress(Exception):
        tasks_module.run_batch_reprocess.run(5, 1, [10, 11], model="vendor/model")

    assert [c.kwargs["model"] for c in child.call_args_list] == ["vendor/model", "vendor/model"]
