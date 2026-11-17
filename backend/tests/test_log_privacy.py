"""User content never reaches logs or Sentry (#159)."""
import re
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.core import sentry_config
from app.providers import log_safety

PROMPT = "An image like Image 1 but with the face from Image 2"


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setattr(log_safety, "get_settings", lambda: SimpleNamespace(environment="dev", log_provider_payloads=False))


def test_summary_keeps_settings_and_hides_content():
    summary = log_safety.summarize({
        "prompt": PROMPT, "negative_prompt": "blurry", "image_size": "auto", "num_images": 2,
        "image_urls": ["data:image/png;base64,AAAA"], "model": "openai/gpt-image-2.5/sunburst/edit",
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "cost": 0.01},
        "output": '{"description": "A woman with dark hair"}', "images": [{"url": "https://fal.media/x.png", "width": 1}],
    })
    text = str(summary)
    assert PROMPT not in text and "blurry" not in text and "A woman" not in text and "fal.media" not in text
    assert summary["image_size"] == "auto" and summary["num_images"] == 2
    assert summary["model"] == "openai/gpt-image-2.5/sunburst/edit"
    assert summary["usage"] == {"prompt_tokens": 10, "completion_tokens": 5, "cost": 0.01}
    assert summary["prompt"] == f"<text:{len(PROMPT)} chars>"


def test_full_payloads_only_locally_with_the_switch(monkeypatch):
    payload = {"prompt": PROMPT}
    assert log_safety.for_log(payload) != payload
    monkeypatch.setattr(log_safety, "get_settings", lambda: SimpleNamespace(environment="dev", log_provider_payloads=True))
    assert log_safety.for_log(payload) != payload  # ignored on dev/prod
    monkeypatch.setattr(log_safety, "get_settings", lambda: SimpleNamespace(environment="local", log_provider_payloads=True))
    assert log_safety.for_log(payload) == payload


@pytest.mark.parametrize("line", [
    f"FAL REQUEST | endpoint=x args={{'prompt': '{PROMPT}', 'model': 'm'}}",
    f"[{{'loc': ['body', 'prompt'], 'msg': 'flagged', 'input': '{PROMPT}'}}]",
    f"OPENAI_AUDIT [embed] REQUEST: text_len=52 text={PROMPT}",
    "upload data:image/png;base64,iVBORw0KGgoAAAANSUhEUg== done",
])
def test_redact_removes_content(line):
    redacted = log_safety.redact(line)
    assert PROMPT not in redacted and "iVBOR" not in redacted


def test_redact_keeps_ids_and_summaries():
    line = "FAL REQUEST | endpoint=fal-ai/x args={'prompt': '<text:52 chars>', 'model': 'openai/gpt-image-2.5/sunburst/edit'}"
    assert log_safety.redact(line) == line


def test_sentry_event_and_log_are_scrubbed():
    event = {
        "exception": {"values": [{"value": "AI could not describe image: The image shows a person on a beach"},
                                 {"value": f"[{{'input': '{PROMPT}'}}]"}]},
        "breadcrumbs": {"values": [{"message": f"FAL RESPONSE | endpoint=x request_id=1 result={{'output': '{PROMPT}'}}"}]},
        "logentry": {"message": f"Task failed: {{'input': '{PROMPT}'}}"},
        "message": "Pipeline failed for image 6840: AI could not describe image: The image shows a person on a beach",
    }
    text = str(sentry_config.sanitize_event(event))
    assert PROMPT not in text and "beach" not in text
    log = sentry_config._before_send_log({"body": f"OPENAI_AUDIT text={PROMPT}", "attributes": {"x": f"'input': '{PROMPT}'"}}, None)
    assert PROMPT not in str(log)


def test_every_provider_payload_log_goes_through_for_log():
    for path in Path(__file__).resolve().parents[1].joinpath("app/providers").glob("*.py"):
        for line in path.read_text().splitlines():
            if re.search(r'logger\.\w+\("FAL (REQUEST|RESPONSE)', line):
                assert "for_log(" in line, f"{path.name}: {line.strip()}"
            if "OPENAI_AUDIT" in line or "REQUEST: text_len" in line:
                assert "text=%" not in line, f"{path.name}: {line.strip()}"
