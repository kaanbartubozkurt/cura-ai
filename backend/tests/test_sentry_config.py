from app.core.sentry_config import (
    get_sentry_init_kwargs,
    sanitize_breadcrumb,
    sanitize_event,
)


def test_scrub_transaction_and_outbound_spans():
    event = {
        "transaction": "GET /api/images/{image_id}",
        "request": {"url": "https://api.test/api/images/123?token=secret#fragment"},
        "spans": [{
            "description": "POST https://fal.test/run?key=secret#fragment",
            "data": {
                "http.url": "https://blob.test/image.png?sig=secret",
                "url.full": "https://openai.test/run#secret",
                "http.query": "sig=secret",
                "url.query": "key=secret",
                "server.address": "blob.test",
                "http.status_code": 200,
            },
        }],
        "breadcrumbs": {"values": [{"category": "http", "data": {"url": "/run?secret"}}]},
    }
    assert sanitize_event(event) is event
    assert event["transaction"] == "GET /api/images/{image_id}"
    assert event["request"]["url"] == "https://api.test/api/images/123"
    span = event["spans"][0]
    assert span["description"] == "POST https://fal.test/run"
    assert span["data"] == {
        "http.url": "https://blob.test/image.png",
        "url.full": "https://openai.test/run",
        "http.query": "",
        "url.query": "",
        "server.address": "blob.test",
        "http.status_code": 200,
    }
    assert event["breadcrumbs"]["values"][0]["data"]["url"] == "/run"


def test_breadcrumb_and_missing_fields():
    crumb = {"category": "navigation", "data": {"from": "/a?secret", "to": "/b#secret"}}
    assert sanitize_breadcrumb(crumb)["data"] == {"from": "/a", "to": "/b"}
    assert sanitize_event({"spans": [{"description": None, "data": None}]})
    assert sanitize_breadcrumb({}) == {}


def test_shared_hooks_cover_api_and_workers():
    config = get_sentry_init_kwargs()
    assert config["before_send_transaction"] is sanitize_event
    assert config["before_send"] is sanitize_event
    assert config["before_breadcrumb"] is sanitize_breadcrumb
