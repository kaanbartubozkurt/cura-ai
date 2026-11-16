#!/usr/bin/env python3
"""
One-time backfill: fill in width/height for finished generations and edits.

Several fal edit models report no output size, so older results were saved with
NULL width/height and the Edit/Create result grids drew them as squares (cropped).
New results store the decoded size (generation_service.image_dimensions).

For each completed result with no size this uses, in order:
  1. its library copy's width/height (Image.generated_image_id), or
  2. the decoded size of the stored file.
It is idempotent: results that already have a size are skipped.

Usage:
    python scripts/backfill_generated_dimensions.py [--dry-run]

On DEV:
    az containerapp exec --name cae-imggen-dev-backend --resource-group rg-imggen-dev \
        --command "python scripts/backfill_generated_dimensions.py"
"""
import argparse
import asyncio
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.db.base import SessionLocal  # noqa: E402
from app.models.generated_image import GeneratedImage, GenerationStatus  # noqa: E402
from app.models.image import Image  # noqa: E402
from app.services.generation_service import image_dimensions  # noqa: E402
from app.services.storage import get_storage_service  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger("backfill_generated_dimensions")


def main(dry_run: bool) -> None:
    db = SessionLocal()
    storage = get_storage_service()
    fixed = from_copy = from_file = failed = 0
    try:
        rows = (
            db.query(GeneratedImage)
            .filter(
                GeneratedImage.status == GenerationStatus.COMPLETED,
                (GeneratedImage.width.is_(None)) | (GeneratedImage.height.is_(None)),
            )
            .all()
        )
        logger.info("%d completed results without a size", len(rows))
        for gen in rows:
            copy = (
                db.query(Image.width, Image.height)
                .filter(Image.generated_image_id == gen.id, Image.width.isnot(None), Image.height.isnot(None))
                .first()
            )
            width = height = None
            if copy:
                width, height = copy
                from_copy += 1
            elif gen.object_key:
                try:
                    data = asyncio.run(storage.get_generated_image(gen.object_key))
                    width, height = image_dimensions(data, None, None)
                    from_file += 1
                except Exception as error:  # noqa: BLE001
                    logger.warning("Result %s: could not read %s (%s)", gen.id, gen.object_key, error)
            if not width or not height:
                failed += 1
                continue
            logger.info("Result %s -> %sx%s", gen.id, width, height)
            if not dry_run:
                gen.width, gen.height = width, height
            fixed += 1
        if not dry_run:
            db.commit()
        logger.info(
            "%s %d results (%d from library copies, %d from files), %d left without a size",
            "Would fix" if dry_run else "Fixed", fixed, from_copy, from_file, failed,
        )
    finally:
        db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    parser.add_argument("--dry-run", action="store_true")
    main(parser.parse_args().dry_run)
