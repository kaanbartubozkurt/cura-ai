"""Statistics for one library view: the whole library, a folder, or a cluster.

Powers the library inspector, which shows coverage (described, clustered,
failed), how the images spread across clusters and folders, top tags and
composition, always scoped to the images in the current view.
"""

from collections import Counter
from datetime import datetime, timedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models import Cluster, ClusterMembership, Folder, FolderImage, Image, ImageMetadata
from app.models.image import ImageSource, ImageStatus

DESCRIBED_STATUSES = (ImageStatus.DESCRIBED, ImageStatus.EMBEDDED, ImageStatus.CLUSTERED)
TAGGED_STATUSES = (ImageStatus.TAGGED, *DESCRIBED_STATUSES)
NOT_DESCRIBED_STATUSES = (ImageStatus.INGESTED, ImageStatus.NORMALIZED, ImageStatus.TAGGED)
MAX_BREAKDOWN = 8
MAX_TAGS = 12
UNCLUSTERED_TITLE = "Unclustered Images"


class LibraryStatsService:
    def __init__(self, db: Session, user_id: int):
        self.db = db
        self.user_id = user_id

    def _scope_ids(self, folder_id: int | None, cluster_id: int | None):
        """Subquery of image ids in the scope, or None if the scope isn't the user's."""
        if folder_id is not None:
            if not self.db.query(Folder.id).filter(Folder.id == folder_id, Folder.user_id == self.user_id).first():
                return None
            return (
                self.db.query(FolderImage.image_id)
                .join(Image, Image.id == FolderImage.image_id)
                .filter(FolderImage.folder_id == folder_id, Image.user_id == self.user_id)
            )
        if cluster_id is not None:
            if not self.db.query(Cluster.id).filter(Cluster.id == cluster_id, Cluster.user_id == self.user_id).first():
                return None
            return (
                self.db.query(ClusterMembership.image_id)
                .join(Image, Image.id == ClusterMembership.image_id)
                .filter(
                    ClusterMembership.cluster_id == cluster_id,
                    ClusterMembership.is_excluded.is_(False),
                    Image.user_id == self.user_id,
                )
            )
        return self.db.query(Image.id).filter(Image.user_id == self.user_id)

    def compute(self, folder_id: int | None = None, cluster_id: int | None = None) -> dict | None:
        ids = self._scope_ids(folder_id, cluster_id)
        if ids is None:
            return None
        ids_sq = ids.scalar_subquery()
        in_scope = Image.id.in_(ids_sq)
        base = self.db.query(Image).filter(Image.user_id == self.user_id, in_scope)

        status_counts = Counter(
            {s.value if hasattr(s, "value") else s: n
             for s, n in base.with_entities(Image.status, func.count()).group_by(Image.status).all()}
        )
        total = sum(status_counts.values())

        def count(statuses) -> int:
            return sum(status_counts.get(s.value, 0) for s in statuses)

        source_counts = Counter(
            {s.value if hasattr(s, "value") else s: n
             for s, n in base.with_entities(Image.source, func.count()).group_by(Image.source).all()}
        )
        generated = source_counts.get(ImageSource.GENERATED.value, 0)
        edited = source_counts.get(ImageSource.EDITED.value, 0)

        agg = base.with_entities(
            func.coalesce(func.sum(Image.file_size), 0),
            func.min(Image.created_at),
            func.max(Image.created_at),
            func.count().filter(Image.width > Image.height),
            func.count().filter(Image.width < Image.height),
            func.count().filter(Image.width == Image.height),
        ).one()
        total_bytes, first_added, last_added, landscape, portrait, square = agg

        # Clusters touching these images (active memberships, non-archived clusters).
        membership = (
            self.db.query(ClusterMembership.cluster_id, ClusterMembership.image_id)
            .join(Cluster, Cluster.id == ClusterMembership.cluster_id)
            .filter(
                Cluster.user_id == self.user_id,
                Cluster.is_archived.is_(False),
                Cluster.summary_title.is_distinct_from(UNCLUSTERED_TITLE),
                ClusterMembership.is_excluded.is_(False),
                ClusterMembership.image_id.in_(ids_sq),
            )
        )
        if cluster_id is not None:
            membership = membership.filter(ClusterMembership.cluster_id != cluster_id)
        rows = membership.all()
        clustered_images = {image_id for _, image_id in rows}
        per_cluster = Counter(cluster_id_ for cluster_id_, _ in rows)
        cluster_names = {
            c.id: c.display_name or c.summary_title or f"Cluster {c.id}"
            for c in self.db.query(Cluster).filter(Cluster.id.in_(list(per_cluster))).all()
        } if per_cluster else {}
        clusters = [
            {"id": cid, "name": cluster_names.get(cid, f"Cluster {cid}"), "count": n}
            for cid, n in per_cluster.most_common(MAX_BREAKDOWN)
        ]

        # Folders holding these images.
        folder_rows = (
            self.db.query(FolderImage.folder_id, FolderImage.image_id)
            .join(Folder, Folder.id == FolderImage.folder_id)
            .filter(Folder.user_id == self.user_id, FolderImage.image_id.in_(ids_sq))
            .all()
        )
        filed_images = {image_id for _, image_id in folder_rows}
        other_folder_rows = [r for r in folder_rows if r[0] != folder_id] if folder_id is not None else folder_rows
        per_folder = Counter(fid for fid, _ in other_folder_rows)
        folder_names = {
            f.id: f.name for f in self.db.query(Folder).filter(Folder.id.in_(list(per_folder))).all()
        } if per_folder else {}
        folders = [
            {"id": fid, "name": folder_names.get(fid, f"Folder {fid}"), "count": n}
            for fid, n in per_folder.most_common(MAX_BREAKDOWN)
        ]

        tag_counter: Counter[str] = Counter()
        for (tags,) in (
            self.db.query(ImageMetadata.tags).filter(ImageMetadata.image_id.in_(ids_sq)).all()
        ):
            tag_counter.update({t for t in (tags or []) if isinstance(t, str)})

        now = datetime.utcnow()
        recent = base.with_entities(
            func.count().filter(Image.created_at >= now - timedelta(days=7)),
            func.count().filter(Image.created_at >= now - timedelta(days=30)),
        ).one()

        return {
            "scope": "folder" if folder_id is not None else "cluster" if cluster_id is not None else "library",
            "total": total,
            "pending": status_counts.get(ImageStatus.PENDING.value, 0),
            "failed": status_counts.get(ImageStatus.FAILED.value, 0),
            "not_described": count(NOT_DESCRIBED_STATUSES),
            "tagged": count(TAGGED_STATUSES),
            "described": count(DESCRIBED_STATUSES),
            "embedded": count((ImageStatus.EMBEDDED, ImageStatus.CLUSTERED)),
            "in_cluster": len(clustered_images),
            "cluster_count": len(per_cluster),
            "clusters": clusters,
            "in_folder": len(filed_images),
            "folder_count": len(per_folder),
            "folders": folders,
            "in_other_folders": len({i for _, i in other_folder_rows}) if folder_id is not None else None,
            "sources": {"upload": total - generated - edited, "generated": generated, "edited": edited},
            "orientation": {"portrait": portrait, "landscape": landscape, "square": square},
            "total_bytes": int(total_bytes or 0),
            "first_added": first_added,
            "last_added": last_added,
            "added_7d": recent[0],
            "added_30d": recent[1],
            "top_tags": [{"tag": t, "count": n} for t, n in tag_counter.most_common(MAX_TAGS)],
        }


def get_library_stats_service(db: Session, user_id: int) -> LibraryStatsService:
    return LibraryStatsService(db, user_id)
