"""Public, read-only sample library (no sign-up).

The landing page and /sample show one folder chosen with
SAMPLE_LIBRARY_FOLDER_ID: its images with their descriptions, tags and
clusters, plus the edits made from them (model and prompt). Nothing else is
reachable here: previews are served only for images in that folder or for
edits whose history links back to one, and only as thumbnails (up to 800 px),
never the original files. 0 (the default) turns the sample library off.
"""
import time
from collections import defaultdict
from pathlib import PurePosixPath

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.base import get_db
from app.models.cluster import Cluster, ClusterMembership
from app.models.folder import Folder, FolderImage
from app.models.generated_image import GeneratedImage
from app.models.image import Image, ImageMetadata, ImageStatus
from app.models.image_history_link import ImageHistoryLink
from app.services.model_catalog import get_image_model

router = APIRouter(prefix="/public", tags=["public"])

SIZES = {"small": "thumbnail_uri_small", "medium": "thumbnail_uri_medium", "large": "thumbnail_uri_large"}
MAX_EDITS_PER_IMAGE = 8
CACHE_SECONDS = 60
_cache: dict[int, tuple[float, dict]] = {}


def _folder(db: Session) -> Folder | None:
    folder_id = get_settings().sample_library_folder_id
    if not folder_id:
        return None
    return db.query(Folder).filter(Folder.id == folder_id).first()


def _preview(image_id: int, size: str) -> str:
    return f"/api/public/sample/images/{image_id}/{size}"


def _visible(query):
    return query.filter(Image.status != ImageStatus.FAILED, Image.thumbnail_uri_medium.isnot(None))


def _source_ids(db: Session, folder: Folder) -> list[int]:
    rows = _visible(
        db.query(Image.id).join(FolderImage, FolderImage.image_id == Image.id)
        .filter(FolderImage.folder_id == folder.id, Image.user_id == folder.user_id)
    ).order_by(Image.id).all()
    return [row[0] for row in rows]


def _clusters(db: Session, ids: list[int]) -> list[dict]:
    """Clusters of the clustering run that covers the most sample images."""
    if not ids:
        return []
    rows = (
        db.query(Cluster.id, Cluster.run_id, Cluster.summary_title, Cluster.created_at, ClusterMembership.image_id)
        .join(ClusterMembership, ClusterMembership.cluster_id == Cluster.id)
        .filter(ClusterMembership.image_id.in_(ids), ClusterMembership.is_excluded.is_(False),
                Cluster.is_archived.is_(False))
        .all()
    )
    coverage: dict[str, set] = defaultdict(set)
    latest: dict[str, object] = {}
    for _, run_id, _, created, image_id in rows:
        coverage[run_id].add(image_id)
        latest[run_id] = max(latest.get(run_id, created), created)
    if not coverage:
        return []
    run = max(coverage, key=lambda r: (len(coverage[r]), latest[r]))
    members: dict[int, list[int]] = defaultdict(list)
    titles: dict[int, str | None] = {}
    for cluster_id, run_id, title, _, image_id in rows:
        if run_id == run:
            members[cluster_id].append(image_id)
            titles[cluster_id] = title
    clusters = [
        {"id": cid, "title": titles[cid] or f"Group {n}", "count": len(image_ids), "image_ids": sorted(image_ids)}
        for n, (cid, image_ids) in enumerate(sorted(members.items(), key=lambda kv: -len(kv[1])), start=1)
    ]
    return clusters


def _edits(db: Session, folder: Folder, ids: list[int]) -> dict[int, list[dict]]:
    """Library copies of edits made from sample images, grouped by source."""
    if not ids:
        return {}
    rows = _visible(
        db.query(ImageHistoryLink.source_image_id, Image, GeneratedImage.base_model, GeneratedImage.prompt)
        .join(Image, Image.id == ImageHistoryLink.result_image_id)
        .join(GeneratedImage, GeneratedImage.id == Image.generated_image_id)
        .filter(ImageHistoryLink.source_image_id.in_(ids), ImageHistoryLink.user_id == folder.user_id,
                Image.user_id == folder.user_id)
    ).order_by(Image.id).all()
    edits: dict[int, list[dict]] = defaultdict(list)
    seen: set[tuple[int, int]] = set()
    for source_id, image, base_model, prompt in rows:
        if (source_id, image.id) in seen or len(edits[source_id]) >= MAX_EDITS_PER_IMAGE:
            continue
        seen.add((source_id, image.id))
        model = get_image_model(base_model, "edit") or get_image_model(base_model, "generate")
        edits[source_id].append({
            "id": image.id,
            "model": base_model,
            "model_label": model.label if model else base_model,
            "prompt": prompt,
            "width": image.width,
            "height": image.height,
            "thumb": _preview(image.id, "medium"),
            "large": _preview(image.id, "large"),
        })
    return dict(edits)


def build_sample(db: Session) -> dict:
    folder = _folder(db)
    if folder is None:
        return {"configured": False, "images": [], "clusters": [], "edits": {}}
    ids = _source_ids(db, folder)
    images = db.query(Image).filter(Image.id.in_(ids)).order_by(Image.id).all() if ids else []
    metas = {m.image_id: m for m in db.query(ImageMetadata).filter(ImageMetadata.image_id.in_(ids)).all()} if ids else {}
    clusters = _clusters(db, ids)
    cluster_of: dict[int, list[int]] = defaultdict(list)
    for cluster in clusters:
        for image_id in cluster["image_ids"]:
            cluster_of[image_id].append(cluster["id"])
    return {
        "configured": True,
        "name": folder.name,
        "images": [
            {
                "id": image.id,
                "width": image.width,
                "height": image.height,
                "description": metas[image.id].description_long if image.id in metas else None,
                "tags": (metas[image.id].tags or [])[:12] if image.id in metas else [],
                "cluster_ids": cluster_of.get(image.id, []),
                "thumb": _preview(image.id, "medium"),
                "large": _preview(image.id, "large"),
            }
            for image in images
        ],
        "clusters": clusters,
        "edits": {str(k): v for k, v in _edits(db, folder, ids).items()},
    }


@router.get("/sample")
def get_sample(db: Session = Depends(get_db)):
    """The public sample library: images, clusters and edits made from them."""
    folder_id = get_settings().sample_library_folder_id
    cached = _cache.get(folder_id)
    if cached and cached[0] > time.monotonic():
        return cached[1]
    data = build_sample(db)
    _cache.clear()
    _cache[folder_id] = (time.monotonic() + CACHE_SECONDS, data)
    return data


def allowed(db: Session, image_id: int) -> Image | None:
    """The image, if it is a sample image or an edit made from one; else None."""
    folder = _folder(db)
    if folder is None:
        return None
    image = _visible(db.query(Image).filter(Image.id == image_id, Image.user_id == folder.user_id)).first()
    if image is None:
        return None
    in_folder = db.query(func.count(FolderImage.id)).filter(
        FolderImage.folder_id == folder.id, FolderImage.image_id == image_id).scalar()
    if in_folder:
        return image
    from_sample = (
        db.query(func.count(ImageHistoryLink.id))
        .join(FolderImage, FolderImage.image_id == ImageHistoryLink.source_image_id)
        .filter(ImageHistoryLink.result_image_id == image_id, FolderImage.folder_id == folder.id)
        .scalar()
    )
    return image if from_sample else None


@router.get("/sample/images/{image_id}/{size}")
def get_sample_preview(image_id: int, size: str, resolve: bool = False, db: Session = Depends(get_db)):
    """A preview of a sample image or of an edit made from one (thumbnails only)."""
    from app.services.storage import get_storage_service

    column = SIZES.get(size)
    image = allowed(db, image_id) if column else None
    uri = getattr(image, column, None) if image is not None else None
    if not uri:
        raise HTTPException(status_code=404, detail="Not found")
    response = get_storage_service().get_file_response("thumbnails", PurePosixPath(uri).name, resolve=resolve)
    if response is None:
        raise HTTPException(status_code=404, detail="Not found")
    # Public sample previews may be cached by browsers and CDNs for a few minutes.
    response.headers["Cache-Control"] = "public, max-age=300"
    return response


_prices_cache: dict[str, tuple[float, dict]] = {}


def _price(db: Session, key: str, operation: str) -> int | None:
    """Sparks for one run at the model's default settings (as shown before running in the app)."""
    from app.services.cost_calculator import estimate_sparks, resolve_catalog_model

    try:
        provider, model, op = resolve_catalog_model("fal", key, operation)
        sparks, _ = estimate_sparks(db, provider, model, op, generation_params={})
    except Exception:
        return None
    return round(float(sparks)) if sparks else None


def build_prices(db: Session) -> dict:
    from app.services.model_catalog import image_models, trainable_keys

    def rows(kind: str, operation: str) -> list[dict]:
        found = [{"key": m.key, "label": m.label, "sparks": _price(db, m.key, operation)} for m in image_models(kind)]
        return sorted((r for r in found if r["sparks"]), key=lambda r: r["sparks"])

    labels = {m.key: m.label for m in image_models("generate")}
    train = [{"key": k, "label": labels.get(k, k), "sparks": _price(db, k, "train")} for k in trainable_keys()]
    return {
        "edit": rows("edit", "edit"),
        "generate": rows("generate", "generate"),
        "train": sorted((r for r in train if r["sparks"]), key=lambda r: r["sparks"]),
    }


@router.get("/prices")
def get_prices(db: Session = Depends(get_db)):
    """Sparks per run for each offered model at default settings, for the pricing page."""
    cached = _prices_cache.get("prices")
    if cached and cached[0] > time.monotonic():
        return cached[1]
    data = build_prices(db)
    _prices_cache["prices"] = (time.monotonic() + 300, data)
    return data
