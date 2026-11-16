"""Hermetic tests for folder/selection clustering runs.

Scoped runs (a folder or a selection) must add clusters without deleting any
existing ones; whole-library runs replace only the previous whole-library run.
"""
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from app.services.cluster_service import SCOPED_RUN_PREFIX, ClusterService
from app.workers import tasks as tasks_module


def _image(image_id: int):
    return SimpleNamespace(id=image_id, image_metadata=SimpleNamespace(embedding=[float(image_id), 1.0, 0.5]))


@pytest.fixture
def harness(monkeypatch):
    images = [_image(i) for i in (11, 12, 13)]
    image_service = Mock()
    image_service.get_images_for_clustering.return_value = images
    cluster_service = Mock()
    cluster_service.create_clusters_from_result.return_value = [SimpleNamespace(id=501)]
    result = SimpleNamespace(run_id="abc123", n_clusters=1)
    clustering_service = Mock()
    clustering_service.cluster.return_value = result
    settings_service = Mock()
    settings_service.get_clustering_config.return_value = {"method": "hdbscan", "hdbscan_min_cluster_size": 15}
    dispatch = Mock()

    db = Mock()
    db.query.return_value.filter.return_value.first.return_value = None
    monkeypatch.setattr(tasks_module, "get_db", Mock(return_value=db))
    monkeypatch.setattr(tasks_module, "get_image_service", Mock(return_value=image_service))
    monkeypatch.setattr(tasks_module, "get_cluster_service", Mock(return_value=cluster_service))
    monkeypatch.setattr(tasks_module, "get_clustering_service", Mock(return_value=clustering_service))
    monkeypatch.setattr(tasks_module, "get_settings_service", Mock(return_value=settings_service))
    monkeypatch.setattr(tasks_module, "dispatch", dispatch)
    monkeypatch.setattr(tasks_module, "write_log", Mock())
    monkeypatch.setattr(tasks_module, "_init_task_context", Mock())
    return SimpleNamespace(
        image_service=image_service, cluster_service=cluster_service,
        clustering_service=clustering_service, result=result, dispatch=dispatch,
    )


def test_scoped_run_adds_clusters_without_deleting(harness):
    out = tasks_module.cluster_all_images.run(
        7, image_ids=[11, 12, 13], params={"hdbscan_min_cluster_size": 3}
    )

    harness.image_service.get_images_for_clustering.assert_called_once_with(image_ids=[11, 12, 13])
    harness.cluster_service.delete_old_clusters.assert_not_called()
    assert out["run_id"].startswith(SCOPED_RUN_PREFIX)
    _, kwargs = harness.cluster_service.create_clusters_from_result.call_args
    assert kwargs["include_noise"] is False
    config = harness.clustering_service.cluster.call_args.kwargs["params"]
    assert config == {"method": "hdbscan", "hdbscan_min_cluster_size": 3}
    assert harness.dispatch.called  # new clusters are summarized


def test_library_run_replaces_only_previous_library_run(harness):
    out = tasks_module.cluster_all_images.run(7)

    harness.image_service.get_images_for_clustering.assert_called_once_with(image_ids=None)
    harness.cluster_service.delete_old_clusters.assert_called_once_with(library_only=True)
    assert not out["run_id"].startswith(SCOPED_RUN_PREFIX)
    _, kwargs = harness.cluster_service.create_clusters_from_result.call_args
    assert kwargs["include_noise"] is True


def test_delete_old_clusters_library_only_keeps_scoped_runs():
    query = Mock()
    query.filter.return_value = query
    query.all.return_value = []
    query.delete.return_value = 0
    db = Mock()
    db.query.return_value = query
    service = ClusterService.__new__(ClusterService)
    service.db = db
    service.user_id = 3

    service.delete_old_clusters(library_only=True)

    expressions = [str(call.args[0]) for call in query.filter.call_args_list]
    assert any("NOT" in e and "run_id" in e and "LIKE" in e for e in expressions)


def test_get_images_for_clustering_filters_by_ids():
    from app.services.image_service import ImageService

    query = Mock()
    query.options.return_value = query
    query.filter.return_value = query
    query.all.return_value = []
    db = Mock()
    db.query.return_value = query
    service = ImageService.__new__(ImageService)
    service.db = db
    service.user_id = 3

    service.get_images_for_clustering(image_ids=[1, 2])
    assert query.filter.call_count == 2
    assert "images.id IN" in str(query.filter.call_args_list[-1].args[0])

