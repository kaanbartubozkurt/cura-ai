"""Compression checks using the production middleware stack."""
import gzip
import io
import json
import zipfile

import pytest
from fastapi import FastAPI
from fastapi.responses import FileResponse, RedirectResponse, Response, StreamingResponse
from fastapi.testclient import TestClient

from app.main import app as production_app

PAYLOAD = {"items": ["design inspiration" * 20] * 20}


@pytest.fixture
def client(tmp_path):
    app = FastAPI()
    app.user_middleware = list(production_app.user_middleware)
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as output:
        output.writestr("metadata.json", json.dumps(PAYLOAD))
    image = tmp_path / "image.png"
    image.write_bytes(b"image bytes" * 200)
    app.get("/large")(lambda: PAYLOAD)
    app.get("/small")(lambda: {"ok": True})
    app.get("/export")(lambda: StreamingResponse(io.BytesIO(archive.getvalue()), media_type="application/zip"))
    app.get("/stream")(lambda: StreamingResponse(iter([json.dumps(PAYLOAD).encode()]), media_type="application/json"))
    app.get("/image")(lambda: FileResponse(image))
    app.get("/redirect")(lambda: RedirectResponse("/large"))
    app.get("/encoded")(lambda: Response(gzip.compress(json.dumps(PAYLOAD).encode()),
                                        media_type="application/json", headers={"Content-Encoding": "gzip"}))
    app.get("/events")(lambda: StreamingResponse(iter([b"data: " + b"x" * 2000 + b"\n\n"]),
                                                media_type="text/event-stream"))
    with TestClient(app) as test_client:
        yield test_client, archive.getvalue(), image.read_bytes()


def test_large_json_compressed_with_context_and_cors(client):
    response = client[0].get("/large", headers={
        "Accept-Encoding": "gzip, br", "Origin": "http://localhost:3000", "X-Trace-Id": "test-trace",
    })
    assert response.headers["content-encoding"] == "gzip"
    assert response.json() == PAYLOAD  # httpx decodes the wire gzip body.
    assert int(response.headers["content-length"]) < len(response.content)
    assert "accept-encoding" in response.headers["vary"].lower()
    assert response.headers["x-trace-id"] == "test-trace"
    assert response.headers["x-request-id"]
    assert response.headers["access-control-allow-origin"] == "http://localhost:3000"
    assert "X-Trace-Id" in response.headers["access-control-expose-headers"]


@pytest.mark.parametrize("path,encoding", [("/small", "gzip"), ("/large", ""), ("/large", "br")])
def test_uncompressed_responses(client, path, encoding):
    response = client[0].get(path, headers={"Accept-Encoding": encoding})
    assert "content-encoding" not in response.headers
    assert response.json() == ({"ok": True} if path == "/small" else PAYLOAD)


def test_streamed_zip_is_unchanged(client):
    response = client[0].get("/export", headers={"Accept-Encoding": "gzip"})
    assert "content-encoding" not in response.headers
    assert response.content == client[1]
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert json.loads(archive.read("metadata.json")) == PAYLOAD


def test_absent_accept_encoding(client):
    client[0].headers.pop("accept-encoding", None)
    response = client[0].get("/large")
    assert "accept-encoding" not in response.request.headers
    assert "content-encoding" not in response.headers
    assert response.json() == PAYLOAD


def test_streamed_json(client):
    response = client[0].get("/stream", headers={"Accept-Encoding": "gzip"})
    assert response.headers["content-encoding"] == "gzip"
    assert response.json() == PAYLOAD


def test_image_file_and_redirect(client):
    response = client[0].get("/image", headers={"Accept-Encoding": "gzip"})
    assert "content-encoding" not in response.headers
    assert response.content == client[2]
    response = client[0].get("/redirect", follow_redirects=False)
    assert response.status_code == 307
    assert response.headers["location"] == "/large"
    assert "content-encoding" not in response.headers


def test_existing_encoding_and_event_stream(client):
    response = client[0].get("/encoded", headers={"Accept-Encoding": "gzip"})
    assert response.json() == PAYLOAD
    response = client[0].get("/events", headers={"Accept-Encoding": "gzip"})
    assert "content-encoding" not in response.headers
    assert response.content == b"data: " + b"x" * 2000 + b"\n\n"
