"""Result sizes come from the decoded image, so grids never crop unknown-size edits."""
from io import BytesIO

from PIL import Image as PILImage

from app.services.generation_service import image_dimensions


def _png(width: int, height: int) -> bytes:
    buffer = BytesIO()
    PILImage.new("RGB", (width, height)).save(buffer, format="PNG")
    return buffer.getvalue()


def test_decoded_size_replaces_missing_provider_size():
    assert image_dimensions(_png(720, 1280), None, None) == (720, 1280)


def test_decoded_size_wins_over_wrong_provider_size():
    assert image_dimensions(_png(608, 1088), 1024, 1024) == (608, 1088)


def test_undecodable_bytes_keep_reported_size():
    assert image_dimensions(b"not an image", 512, 768) == (512, 768)
