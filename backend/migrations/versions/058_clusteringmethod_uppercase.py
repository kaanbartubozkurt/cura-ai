"""Add uppercase clusteringmethod values so clustering works on every database.

The model writes ClusteringMethod member names (HDBSCAN, KMEANS, GRAPH). DEV's
database was built with create_all() and already has those labels, but databases
built by these migrations (001) only have lowercase ones, so saving clusters
failed with `invalid input value for enum clusteringmethod: "HDBSCAN"` (#138).
Reads of existing lowercase rows keep working (LegacyClusteringEnum).

ADD VALUE IF NOT EXISTS makes this a no-op where the labels exist. Enum values
can't be removed in PostgreSQL, so downgrade does nothing.

Revision ID: 058_clusteringmethod_uppercase
Revises: 057_image_history
"""

from alembic import op

revision = "058_clusteringmethod_uppercase"
down_revision = "057_image_history"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.get_context().autocommit_block():
        for value in ("HDBSCAN", "KMEANS", "GRAPH"):
            op.execute(f"ALTER TYPE clusteringmethod ADD VALUE IF NOT EXISTS '{value}'")


def downgrade() -> None:
    pass
