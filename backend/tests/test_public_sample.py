"""Public sample library: only the configured folder and edits made from it are visible."""
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pgvector.sqlalchemy import Vector
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import TSVECTOR
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app.api import public
from app.models.cluster import Cluster, ClusteringMethod, ClusterMembership
from app.models.folder import Folder, FolderImage
from app.models.generated_image import GeneratedImage
from app.models.image import Image, ImageMetadata, ImageSource, ImageStatus
from app.models.image_history_link import ImageHistoryLink
from app.models.user import User, UserRole


# The library tables carry Postgres-only column types; SQLite stores them as text.
@compiles(TSVECTOR, "sqlite")
@compiles(Vector, "sqlite")
def _as_text(element, compiler, **kw):
    return "TEXT"


@pytest.fixture
def db(monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    tables = [User.__table__, Folder.__table__, Image.__table__, FolderImage.__table__, ImageMetadata.__table__,
              Cluster.__table__, ClusterMembership.__table__, GeneratedImage.__table__, ImageHistoryLink.__table__]
    User.metadata.create_all(engine, tables=tables)
    session = Session(engine)
    session.add_all([User(id=1, email="owner@example.test", hashed_password="x", role=UserRole.ADMIN),
                     User(id=2, email="other@example.test", hashed_password="x", role=UserRole.USER)])
    session.add_all([Folder(id=10, user_id=1, name="Sample library"), Folder(id=11, user_id=1, name="Private")])

    def image(id, user=1, source=ImageSource.UPLOAD, generated=None, status=ImageStatus.EMBEDDED):
        return Image(id=id, user_id=user, source=source, object_key=f"k{id}", file_hash=f"h{id}", generated_image_id=generated,
                     width=800, height=1000, status=status, thumbnail_uri_small=f"/s/thumbnails/{id}_200.jpg",
                     thumbnail_uri_medium=f"/s/thumbnails/{id}_400.jpg", thumbnail_uri_large=f"/s/thumbnails/{id}_800.jpg")

    session.add_all([image(1), image(2), image(3), image(4, status=ImageStatus.FAILED), image(5, user=2)])
    session.add_all([FolderImage(folder_id=10, image_id=i) for i in (1, 2, 4)] + [FolderImage(folder_id=11, image_id=3)])
    session.add_all([ImageMetadata(image_id=1, tags=["car", "night"], description_long="A red car at night."),
                     ImageMetadata(image_id=2, tags=["mug"], description_long="A white mug.")])
    # An edit of sample image 1 (library copy 20) and an edit of the private image 3 (library copy 21).
    session.add_all([
        GeneratedImage(id=100, user_id=1, prompt="Make it night", base_model="nano-banana-2.1-edit",
                       generation_provider="fal"),
        GeneratedImage(id=101, user_id=1, prompt="Private edit", base_model="nano-banana-2.1-edit",
                       generation_provider="fal"),
    ])
    session.add_all([image(20, source=ImageSource.EDITED, generated=100), image(21, source=ImageSource.EDITED, generated=101)])
    session.add_all([ImageHistoryLink(user_id=1, result_image_id=20, source_image_id=1, result_key="r20", source_key="k1"),
                     ImageHistoryLink(user_id=1, result_image_id=21, source_image_id=3, result_key="r21", source_key="k3")])
    session.add_all([Cluster(id=50, user_id=1, run_id="scoped-1", method=ClusteringMethod.HDBSCAN, size=2,
                             summary_title="Cars at night"),
                     Cluster(id=51, user_id=1, run_id="old", method=ClusteringMethod.HDBSCAN, size=1)])
    session.add_all([ClusterMembership(cluster_id=50, image_id=1), ClusterMembership(cluster_id=50, image_id=2),
                     ClusterMembership(cluster_id=51, image_id=1)])
    session.commit()
    monkeypatch.setattr(public, "get_settings", lambda: SimpleNamespace(sample_library_folder_id=10))
    public._cache.clear()
    yield session
    session.close()


def test_sample_lists_folder_images_with_descriptions_clusters_and_edits(db):
    data = public.build_sample(db)
    assert data["configured"] and data["name"] == "Sample library"
    assert [i["id"] for i in data["images"]] == [1, 2]  # failed image 4 and private image 3 left out
    first = data["images"][0]
    assert first["description"] == "A red car at night." and first["tags"] == ["car", "night"]
    assert first["thumb"] == "/api/public/sample/images/1/medium"
    assert data["clusters"] == [{"id": 50, "title": "Cars at night", "count": 2, "image_ids": [1, 2]}]
    assert first["cluster_ids"] == [50]
    edits = data["edits"]["1"]
    assert [e["id"] for e in edits] == [20] and edits[0]["prompt"] == "Make it night"
    assert "3" not in data["edits"]


def test_off_by_default(db, monkeypatch):
    monkeypatch.setattr(public, "get_settings", lambda: SimpleNamespace(sample_library_folder_id=0))
    assert public.build_sample(db) == {"configured": False, "images": [], "clusters": [], "edits": {}}
    assert public.allowed(db, 1) is None


@pytest.mark.parametrize("image_id, visible", [(1, True), (20, True), (3, False), (21, False), (4, False), (5, False)])
def test_previews_only_for_sample_images_and_their_edits(db, image_id, visible):
    assert (public.allowed(db, image_id) is not None) is visible


def test_preview_serves_thumbnails_only(db, monkeypatch):
    served = []

    class Storage:
        def get_file_response(self, subdir, filename, *args, **kwargs):
            from fastapi.responses import Response

            served.append((subdir, filename))
            return Response(b"jpeg")

    import app.services.storage as storage

    monkeypatch.setattr(storage, "get_storage_service", lambda: Storage())
    response = public.get_sample_preview(1, "large", db=db)
    assert served == [("thumbnails", "1_800.jpg")]
    assert response.headers["Cache-Control"] == "public, max-age=300"
    for image_id, size in ((1, "original"), (3, "medium")):
        with pytest.raises(HTTPException):
            public.get_sample_preview(image_id, size, db=db)
