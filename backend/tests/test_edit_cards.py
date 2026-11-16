"""The edit list resolves owned library previews once per page."""
import asyncio
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest

from app.api import edit
from app.models.generated_image import GenerationStatus


@pytest.mark.parametrize("count", [0, 3])
def test_edit_list_batches_library_previews(count):
    db = Mock()
    db.query.return_value.filter.return_value.all.return_value = [(1, 11, "medium.jpg", "large.jpg")]
    gens = [SimpleNamespace(
        id=i, user_id=7, prompt="sea", negative_prompt=None, base_model="nano-banana-pro",
        generation_provider="fal", lora_model_id=None, lora_model=None, lora_scale=None,
        generation_params={}, status=GenerationStatus.COMPLETED, error_message=None,
        object_key="result.png", width=768, height=1376, file_size=100, mime_type="image/png",
        thumbnail_uri_small="small.jpg", thumbnail_uri_medium="medium.jpg", job_id=None,
        created_at=datetime(2026, 11, 16), completed_at=None,
    ) for i in range(1, count + 1)]
    service = Mock()
    service.get_generated_images.return_value = gens
    service.count_generated_images.return_value = count
    with patch.object(edit, "get_generation_service", return_value=service):
        response = asyncio.run(edit.list_edit_images(skip=0, limit=40, db=db, current_user=SimpleNamespace(id=7)))
    assert response.total == count
    assert len(response.items) == count
    assert db.query.call_count == (1 if count else 0)
    service.get_generated_images.assert_called_once_with(mode="edit", skip=0, limit=40)
    if count:
        assert response.items[0].library_image_id == 11
        assert response.items[0].library_thumbnail_uri_medium == "medium.jpg"
        assert response.items[0].library_thumbnail_uri_large == "large.jpg"
        assert response.items[1].library_image_id is None
        filters = db.query.return_value.filter.call_args.args
        assert "images.user_id" in str(filters[1])


@pytest.mark.parametrize("key", ["edit-sources/8-" + "a" * 32 + ".png", "edit-sources/7-../../other.png", "images/private.png"])
def test_upload_input_rejects_foreign_or_invalid_keys(key):
    from fastapi import HTTPException

    service = Mock()
    service.get_generated_image.return_value = SimpleNamespace(generation_params={"sources": {"ordered": [{"type": "upload", "key": key}]}})
    with patch.object(edit, "get_generation_service", return_value=service):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(edit.serve_edit_upload_source(1, 0, False, Mock(), SimpleNamespace(id=7)))
    assert exc.value.status_code == 404


def test_upload_input_serves_owned_original_and_resolve():
    key = "edit-sources/7-" + "a" * 32 + ".jpg"
    service = Mock()
    service.get_generated_image.return_value = SimpleNamespace(generation_params={"sources": {"ordered": [{"type": "upload", "key": key}]}})
    storage = Mock()
    with patch.object(edit, "get_generation_service", return_value=service), patch("app.services.storage.get_storage_service", return_value=storage):
        assert asyncio.run(edit.serve_edit_upload_source(1, 0, True, Mock(), SimpleNamespace(id=7))) == storage.get_file_response.return_value
    storage.get_file_response.assert_called_once_with("generated", key, "image/jpeg", resolve=True)


@pytest.mark.parametrize("index,exists", [(-1, True), (0, True), (0, False)])
def test_upload_input_missing_source_or_edit(index, exists):
    from fastapi import HTTPException

    service = Mock()
    service.get_generated_image.return_value = SimpleNamespace(generation_params={}) if exists else None
    with patch.object(edit, "get_generation_service", return_value=service):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(edit.serve_edit_upload_source(1, index, False, Mock(), SimpleNamespace(id=7)))
    assert exc.value.status_code == 404
