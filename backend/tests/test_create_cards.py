"""Create choices storage, list filtering and library viewer links."""
import asyncio
import json
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Session
from starlette.requests import Request

from app.api import generation, settings
from app.models.generated_image import GenerationStatus
from app.models.settings import AppSettings
from app.services.generation_service import GenerationService


def request(value):
    body = json.dumps(value).encode()

    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}

    return Request({"type": "http", "method": "PUT", "path": "/"}, receive)


@pytest.fixture
def db():
    engine = create_engine("sqlite://")
    AppSettings.__table__.create(engine)
    with Session(engine) as session:
        yield session
    engine.dispose()


def put(db, user_id, value, model="nano-banana-pro"):
    return asyncio.run(settings.put_create_choices(model, request(value), db, SimpleNamespace(id=user_id)))


def get(db, user_id):
    return asyncio.run(settings.get_create_choices(db, SimpleNamespace(id=user_id)))


def test_choices_round_trip_and_replace(db):
    choices = {"aspect_ratio": "9:16", "num_images": 2, "enable_web_search": True, "guidance": 2.5}
    assert put(db, 1, choices) == choices
    assert get(db, 1) == {"nano-banana-pro": choices}
    put(db, 1, {"num_images": 1})
    assert get(db, 1) == {"nano-banana-pro": {"num_images": 1}}
    assert db.query(AppSettings).count() == 1


def test_choices_are_isolated_by_user_and_model(db):
    put(db, 1, {"num_images": 2})
    put(db, 2, {"num_images": 3})
    put(db, 1, {"num_images": 1}, "flux-3")
    assert get(db, 1) == {"nano-banana-pro": {"num_images": 2}, "flux-3": {"num_images": 1}}
    assert get(db, 2) == {"nano-banana-pro": {"num_images": 3}}
    assert get(db, 3) == {}


@pytest.mark.parametrize("model", ["unknown", "kling-image"])
def test_choices_reject_unknown_or_edit_model(db, model):
    with pytest.raises(HTTPException) as exc:
        put(db, 1, {}, model)
    assert exc.value.status_code == 400
    assert get(db, 1) == {}


def test_choices_reject_oversized_body(db):
    with pytest.raises(HTTPException) as exc:
        put(db, 1, {"prompt": "x" * 4096})
    assert exc.value.status_code == 413
    assert get(db, 1) == {}


@pytest.mark.parametrize("value", [[], None, {"nested": {}}, {"nested": []}, {"null": None}, {"number": float("nan")}])
def test_choices_reject_nonflat_or_invalid_values(db, value):
    with pytest.raises(HTTPException) as exc:
        put(db, 1, value)
    assert exc.value.status_code == 422


@pytest.mark.parametrize("mode", [None, "generate", "edit"])
def test_list_passes_optional_filter_to_items_and_count(monkeypatch, mode):
    service = Mock()
    service.get_generated_images.return_value = []
    service.count_generated_images.return_value = 0
    monkeypatch.setattr(generation, "get_generation_service", lambda db, user_id: service)
    result = asyncio.run(generation.list_generated_images(mode=mode, skip=0, limit=50, db=Mock(), current_user=SimpleNamespace(id=7)))
    assert result.total == 0
    assert service.get_generated_images.call_args.kwargs["mode"] == mode
    assert service.count_generated_images.call_args.kwargs["mode"] == mode


def test_generate_filter_includes_legacy_and_excludes_edits():
    # Compile the real query: PostgreSQL JSON semantics cannot run in SQLite.
    db = Mock()
    from sqlalchemy.orm import Query

    from app.models.generated_image import GeneratedImage
    query = Query(GeneratedImage)
    db.query.return_value = query
    service = GenerationService.__new__(GenerationService)
    service.db, service.user_id = db, 7
    # Intercept execution after all real filters have been applied.
    statements = []
    original = Query.all
    try:
        Query.all = lambda self: statements.append(str(self.statement.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))) or []
        service.get_generated_images(mode="generate")
    finally:
        Query.all = original
    sql = statements[0]
    assert "generated_images.user_id = 7" in sql
    assert "!= 'edit'" in sql
    assert "IS NULL" in sql


@pytest.mark.parametrize("library_id", [None, 42])
def test_response_exposes_owned_library_copy(library_id):
    db = Mock()
    query = db.query.return_value
    query.filter.return_value.all.return_value = [(8, library_id)] if library_id else []
    gen = SimpleNamespace(
        id=8, user_id=7, prompt="sea", negative_prompt=None, base_model="nano-banana-pro",
        generation_provider="fal", lora_model_id=None, lora_model=None, lora_scale=None,
        generation_params={}, status=GenerationStatus.COMPLETED, error_message=None,
        object_key="result.png", width=768, height=1376, file_size=100, mime_type="image/png",
        thumbnail_uri_small=None, thumbnail_uri_medium=None, job_id=None,
        created_at=datetime(2026, 11, 16), completed_at=None,
    )
    result = generation._gen_to_response(gen, db)
    assert result.library_image_id == library_id
    filters = query.filter.call_args.args
    assert len(filters) == 2
    assert "images.user_id" in str(filters[1])


def test_list_looks_up_library_copies_in_one_query():
    db = Mock()
    db.query.return_value.filter.return_value.all.return_value = [(1, 11), (3, 33)]
    gens = [SimpleNamespace(id=i, user_id=7) for i in (1, 2, 3)]
    assert generation._library_image_ids(db, gens) == {1: 11, 3: 33}
    assert db.query.call_count == 1
    assert generation._library_image_ids(db, []) == {}


def test_list_default_still_excludes_edits():
    import inspect

    assert inspect.signature(generation.list_generated_images).parameters["mode"].default == "generate"
