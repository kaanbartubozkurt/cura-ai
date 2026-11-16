"""Remix: GET /edit/images/{id}/recipe rebuilds an edit exactly as it was sent."""
import asyncio
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException

from app.api import edit as edit_api


def test_recipe_sources_keep_ordered_list():
    refs = {"ordered": [{"type": "upload", "key": "k"}, {"type": "gallery", "id": 3, "role": "element_main", "element": 1}],
            "image_ids": [3]}
    assert edit_api._recipe_sources(refs) == refs["ordered"]


def test_recipe_sources_rebuild_legacy_edits():
    refs = {"image_ids": [1], "generated_ids": [2], "upload_keys": ["edit-sources/1-a.png"],
            "upload_names": {"edit-sources/1-a.png": "cat.png"}}
    assert edit_api._recipe_sources(refs) == [
        {"type": "gallery", "id": 1},
        {"type": "generated", "id": 2},
        {"type": "upload", "key": "edit-sources/1-a.png", "name": "cat.png"},
    ]


@pytest.mark.parametrize("params,sources,job", [
    ({"mask_key": "edit-sources/1-x.png"}, [], "paint"),
    ({"object_boxes": []}, [], "objects"),
    ({"result_type": "series"}, [], "subject"),
    ({}, [{"type": "gallery", "id": 1, "role": "element_main", "element": 1}], "subject"),
    ({}, [{"type": "gallery", "id": 1}], "describe"),
])
def test_recipe_job_inference(params, sources, job):
    assert edit_api._recipe_job(params, sources) == job


def _db(found):
    """db.query(...).filter(...).first() returns items from `found` in call order."""
    query = Mock()
    query.filter.return_value = query
    query.first.side_effect = found
    db = Mock()
    db.query.return_value = query
    return db


def test_recipe_restores_settings_and_flags_missing_sources(monkeypatch):
    gen = SimpleNamespace(
        id=9, job_id=None, prompt="Put Image 2 behind Image 1", negative_prompt="blur", base_model="seedream",
        generation_params={
            "mode": "edit", "edit_model": "seedream-4.5-edit", "actual_seed": 48213,
            "image_size": "portrait_4_3", "quality": "high", "safety_tolerance": "2", "unknown": "x",
            "sources": {"ordered": [{"type": "gallery", "id": 1}, {"type": "gallery", "id": 2}]},
        },
    )
    monkeypatch.setattr(edit_api, "get_generation_service", lambda db, uid: Mock(get_generated_image=lambda _: gen))
    image = SimpleNamespace(object_key="a.jpg", width=800, height=1000, thumbnail_uri_medium="t.jpg",
                            thumbnail_uri_small=None, thumbnail_uri_large=None)
    db = _db([image, None])  # source 1 exists, source 2 was deleted

    recipe = asyncio.run(edit_api.get_edit_recipe(9, db=db, current_user=SimpleNamespace(id=1)))

    assert recipe["job"] == "describe"
    assert recipe["edit_model"] == "seedream-4.5-edit"
    assert recipe["settings"] == {"image_size": "portrait_4_3", "quality": "high", "safety_tolerance": "2"}
    assert recipe["original_seed"] == 48213
    assert recipe["negative_prompt"] == "blur"
    assert [s["available"] for s in recipe["sources"]] == [True, False]
    assert recipe["sources"][0]["width"] == 800
    assert recipe["missing_sources"] == 1


def test_recipe_rejects_non_edit_results(monkeypatch):
    gen = SimpleNamespace(generation_params={"mode": "generate"})
    monkeypatch.setattr(edit_api, "get_generation_service", lambda db, uid: Mock(get_generated_image=lambda _: gen))
    with pytest.raises(HTTPException) as error:
        asyncio.run(edit_api.get_edit_recipe(1, db=Mock(), current_user=SimpleNamespace(id=1)))
    assert error.value.status_code == 404
