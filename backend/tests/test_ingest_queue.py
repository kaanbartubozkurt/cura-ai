"""Hermetic tests: thumbnail ingest runs on its own queue and tolerates re-delivery."""
from types import SimpleNamespace
from unittest.mock import Mock

from app.models.image import ImageStatus
from app.workers import tasks as tasks_module
from app.workers.celery_app import celery_app


def test_ingest_tasks_route_to_ingest_queue():
    routes = celery_app.conf.task_routes
    assert routes["app.workers.tasks.process_ingest"] == {"queue": "ingest"}
    assert routes["app.workers.tasks.process_ingest_batch"] == {"queue": "ingest"}


def test_worker_commands_consume_ingest_queue():
    from pathlib import Path

    root = Path(__file__).resolve().parents[2]
    for path in ["docker-compose.yml", "docker-compose.cloud.yml", "scripts/dev-cloud.sh",
                 "infra/modules/container_apps/main.tf"]:
        text = (root / path).read_text()
        assert "celery,ingest" in text, f"{path}: default worker must consume the ingest queue"


def test_process_ingest_skips_already_ingested_image(monkeypatch):
    image = SimpleNamespace(id=5, status=ImageStatus.INGESTED)
    image_service = Mock()
    image_service.get_image.return_value = image
    db = Mock()
    monkeypatch.setattr(tasks_module, "get_db", Mock(return_value=db))
    monkeypatch.setattr(tasks_module, "get_image_service", Mock(return_value=image_service))
    monkeypatch.setattr(tasks_module, "write_log", Mock())
    monkeypatch.setattr(tasks_module, "_init_task_context", Mock())

    result = tasks_module.process_ingest.run(5, 1)

    assert result == {"status": "skipped", "image_id": 5}
    image_service.storage.save_thumbnail.assert_not_called()
