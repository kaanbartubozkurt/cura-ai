"""Batches finish from their children, never from a poller a worker restart can kill (#143)."""
from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock

from app.models import JobStatus, JobType
from app.services import job_recovery
from app.workers import tasks as tasks_module


def _parent(**overrides):
    values = dict(id=10, user_id=1, job_type=JobType.BATCH_REPROCESS, status=JobStatus.RUNNING,
                  result={"image_ids": [1, 2, 3], "dispatched": True, "queued": 3},
                  progress=0, updated_at=None, completed_at=None, error_message=None)
    values.update(overrides)
    return SimpleNamespace(**values)


def _db_with_counts(counts):
    query = Mock()
    query.filter.return_value = query
    query.group_by.return_value = query
    query.all.return_value = list(counts.items())
    db = Mock()
    db.query.return_value = query
    return db


def test_partial_batch_updates_progress_and_lease_but_stays_running():
    parent = _parent()
    now = datetime(2026, 11, 17)
    finished = job_recovery.reconcile_batch(
        _db_with_counts({JobStatus.COMPLETED: 1, JobStatus.PENDING: 2}), parent, now=now)
    assert finished is False
    assert parent.progress == 1
    assert parent.updated_at == now
    assert parent.status == JobStatus.RUNNING


def test_batch_completes_when_every_child_is_done():
    parent = _parent()
    finished = job_recovery.reconcile_batch(
        _db_with_counts({JobStatus.COMPLETED: 2, JobStatus.FAILED: 1}), parent)
    assert finished is True
    assert parent.status == JobStatus.COMPLETED
    assert parent.progress == 3
    assert parent.error_message == "1/3 images failed"
    assert parent.result["succeeded"] == 2 and parent.result["failed"] == 1
    assert parent.result["image_ids"] == [1, 2, 3]
    assert parent.completed_at is not None


def test_batch_where_every_child_failed_is_failed():
    parent = _parent()
    job_recovery.reconcile_batch(_db_with_counts({JobStatus.FAILED: 2, JobStatus.CANCELLED: 1}), parent)
    assert parent.status == JobStatus.FAILED
    assert parent.error_message == "All 3 images failed"


def test_batch_still_dispatching_never_finishes_early():
    parent = _parent(result={"image_ids": [1, 2, 3]})
    db = _db_with_counts({JobStatus.COMPLETED: 1})
    assert job_recovery.reconcile_batch(db, parent) is False
    assert parent.status == JobStatus.RUNNING
    db.query.assert_not_called()


def test_finished_batch_is_left_alone():
    parent = _parent(status=JobStatus.CANCELLED)
    db = _db_with_counts({JobStatus.COMPLETED: 3})
    assert job_recovery.reconcile_batch(db, parent) is False
    assert parent.status == JobStatus.CANCELLED


def test_child_without_parent_does_not_touch_batches():
    db = Mock()
    assert job_recovery.advance_batch_parent(db, SimpleNamespace(parameters={}, user_id=1)) is False
    db.query.assert_not_called()


def test_startup_recovery_reconciles_quiet_batch_instead_of_failing_it(monkeypatch):
    batch = _parent(updated_at=datetime.utcnow() - timedelta(hours=1))
    lost = SimpleNamespace(id=11, user_id=1, job_type=JobType.REPROCESS, status=JobStatus.RUNNING,
                           result=None, parameters={"parent_job_id": 10})
    query = Mock()
    query.filter.return_value = query
    query.with_for_update.return_value = query
    query.all.return_value = [batch, lost]
    db = Mock()
    db.query.return_value = query
    reconcile = Mock(return_value=False)
    finish = Mock()
    advance = Mock()
    monkeypatch.setattr(job_recovery, "reconcile_batch", reconcile)
    monkeypatch.setattr(job_recovery, "finish_job", finish)
    monkeypatch.setattr(job_recovery, "advance_batch_parent", advance)

    assert job_recovery.reap_stale_jobs(db) == 1

    assert reconcile.call_args.args[1] is batch
    assert finish.call_args.args[1] is lost  # only the lost child is failed...
    advance.assert_called_once_with(db, lost)  # ...and its batch is updated


def test_finished_child_job_advances_its_batch(monkeypatch):
    child = SimpleNamespace(id=11, status=JobStatus.RUNNING, parameters={"parent_job_id": 10},
                            created_at=None, started_at=None, completed_at=None)
    db = MagicMock()
    db.query.return_value.filter.return_value.populate_existing.return_value.first.return_value = child
    advance = Mock()
    monkeypatch.setattr(job_recovery, "advance_batch_parent", advance)

    tasks_module._update_job_status(db, 11, JobStatus.COMPLETED, progress=1)

    assert child.status == JobStatus.COMPLETED
    advance.assert_called_once_with(db, child)


def test_running_child_does_not_advance_its_batch(monkeypatch):
    child = SimpleNamespace(id=11, status=JobStatus.PENDING, parameters={"parent_job_id": 10},
                            created_at=None, started_at=None, completed_at=None, job_type=None)
    db = MagicMock()
    db.query.return_value.filter.return_value.populate_existing.return_value.first.return_value = child
    advance = Mock()
    monkeypatch.setattr(job_recovery, "advance_batch_parent", advance)

    tasks_module._update_job_status(db, 11, JobStatus.RUNNING)

    advance.assert_not_called()
