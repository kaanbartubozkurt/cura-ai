"""Keep user content out of logs (#159).

Provider requests and responses carry prompts, descriptions of people in the
user's images, refusal texts and image data. Logs leave the process (Azure Log
Analytics, Sentry Logs), so by default we log only technical metadata: setting
values from an allow-list, and the length of every text. Content stays in our
own database, linked by ids, where an admin can look it up when debugging.

``LOG_PROVIDER_PAYLOADS=true`` logs full payloads for local development only;
it's ignored when ENVIRONMENT is dev or prod.
"""
import re
from typing import Any

from app.core.config import get_settings

# Technical settings whose values are safe (no user content).
SAFE_KEYS = {
    "model", "image_size", "width", "height", "resolution", "aspect_ratio", "quality", "num_images",
    "seed", "safety_tolerance", "output_format", "sync_mode", "steps", "num_inference_steps",
    "guidance_scale", "max_tokens", "temperature", "reasoning", "enable_safety_checker",
    "enable_prompt_expansion", "enable_web_search", "strength", "scale", "lora_scale", "result_type",
    "series_amount", "content_type", "file_size", "file_name", "has_nsfw_concepts", "timings",
    "request_id", "status", "usage", "prompt_tokens", "completion_tokens", "total_tokens", "cost",
    "cached_tokens", "cache_write_tokens", "prompt_tokens_details", "input_tokens", "output_tokens",
}


def payloads_allowed() -> bool:
    settings = get_settings()
    return bool(getattr(settings, "log_provider_payloads", False)) and settings.environment == "local"


def summarize(value: Any, key: str | None = None) -> Any:
    """Shape of a payload without its content: safe settings kept, texts reduced to their length."""
    if isinstance(value, dict):
        return {k: summarize(v, k) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        if key in SAFE_KEYS:
            return [summarize(v, key) for v in value]
        return f"<list:{len(value)}>" if not value or not isinstance(value[0], dict) else [summarize(v) for v in value]
    if isinstance(value, str):
        if key in SAFE_KEYS and not value.startswith("data:") and len(value) <= 120:
            return value
        return f"<text:{len(value)} chars>"
    if isinstance(value, (bool, int, float)) or value is None:
        return value
    return f"<{type(value).__name__}>"


def for_log(payload: Any) -> Any:
    """What to put in a log line for a provider payload."""
    return payload if payloads_allowed() else summarize(payload)


# Defense in depth for anything that still reaches Sentry: strip content-bearing parts.
_MARKERS = (" args=", " result=", " text=", "RESPONSE_FULL:")
_INPUT = re.compile(r"""(['"]input['"]\s*:\s*)(['"]).*?(?<!\\)\2""", re.S)
_DATA_URI = re.compile(r"data:[\w/+.-]+;base64,[A-Za-z0-9+/=]+")
_BARE_TEXT = re.compile(r"(\btext=)(?!['\"{<])[^\n]*")
_QUOTED = re.compile(r"""(['"])((?:(?!\1).){16,}?)\1""", re.S)


def _scrub_sentences(segment: str) -> str:
    """Redact quoted sentences (they have spaces); keep ids, endpoints and <text:N> summaries."""
    return _QUOTED.sub(
        lambda m: m.group(0) if " " not in m.group(2) or m.group(2).startswith("<") else f"{m.group(1)}[redacted]{m.group(1)}",
        segment,
    )


def redact(text: str) -> str:
    """Remove prompt/output text a log line or error message might carry."""
    if not isinstance(text, str) or payloads_allowed():
        return text
    text = _DATA_URI.sub("<data-uri>", text)
    text = _INPUT.sub(lambda m: f"{m.group(1)}{m.group(2)}[redacted]{m.group(2)}", text)
    text = _BARE_TEXT.sub(r"\1[redacted]", text)
    positions = [text.find(marker) for marker in _MARKERS if marker in text]
    if positions:
        start = min(positions)
        text = text[:start] + _scrub_sentences(text[start:])
    return text
