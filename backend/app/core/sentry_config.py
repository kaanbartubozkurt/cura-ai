"""Shared Sentry configuration for API and Celery workers.

Provides common integrations and log filtering so both init paths
stay consistent.
"""
import logging
import re


def get_sentry_init_kwargs():
    """Return shared kwargs for sentry_sdk.init().

    Caller is responsible for providing dsn, environment, and
    traces_sample_rate — this returns the logging-related config.
    """
    from sentry_sdk.integrations.celery import CeleryIntegration
    from sentry_sdk.integrations.logging import LoggingIntegration

    return {
        "send_default_pii": False,
        "enable_logs": True,
        "before_send": sanitize_event,
        "before_send_transaction": sanitize_event,
        "before_breadcrumb": sanitize_breadcrumb,
        "before_send_log": _before_send_log,
        "integrations": [
            LoggingIntegration(
                level=logging.INFO,
                event_level=logging.ERROR,
                sentry_logs_level=logging.INFO,
            ),
            # CeleryIntegration with propagate_traces injects sentry-trace
            # headers into Celery messages for API → worker trace linking.
            # OTel CeleryInstrumentor (otel.py) creates producer-side spans;
            # worker-side trace continuation is handled manually in celery_app.py
            # via task_prerun/task_postrun signals.
            CeleryIntegration(
                propagate_traces=True,
                monitor_beat_tasks=True,
            ),
        ],
    }


def _before_send_log(log, _hint):
    """Filter noisy logs and strip user content before sending to Sentry (#159)."""
    body = log.get("body", "")
    if "/health" in body:
        return None
    if "mingle" in body.lower() or "gossip" in body.lower():
        return None
    log["body"] = redact_content(body)
    attributes = log.get("attributes")
    if isinstance(attributes, dict):
        for key, value in attributes.items():
            if isinstance(value, str):
                attributes[key] = redact_content(value)
    return log


_REFUSAL = re.compile(r"(AI could not \w+ image|fal\.ai OpenRouter \w+ refused)[:]?[^\n]*")


def redact_content(text):
    """Prompts, outputs and model refusal texts (they describe the user's image) never reach Sentry."""
    from app.providers.log_safety import redact

    if not isinstance(text, str):
        return text
    text = _REFUSAL.sub(lambda m: f"{m.group(1)}: [model's reason redacted]", text)
    return redact(text)


_URL_KEYS = {"url", "http.url", "url.full", "http.target", "url.path"}
_QUERY_KEYS = {"http.query", "url.query", "url.fragment"}


def strip_url_query(value):
    """Remove query strings and fragments, including from METHOD URL descriptions."""
    return value.split("?", 1)[0].split("#", 1)[0]


def _scrub_data(data):
    if not isinstance(data, dict):
        return
    for key, value in data.items():
        if key in _QUERY_KEYS:
            data[key] = ""
        elif key in _URL_KEYS and isinstance(value, str):
            data[key] = strip_url_query(value)


def sanitize_breadcrumb(breadcrumb, _hint=None):
    """Scrub HTTP and navigation breadcrumb URLs before transmission."""
    data = breadcrumb.get("data")
    _scrub_data(data)
    if breadcrumb.get("category") == "navigation" and isinstance(data, dict):
        for key in ("from", "to"):
            if isinstance(data.get(key), str):
                data[key] = strip_url_query(data[key])
    return breadcrumb


def sanitize_event(event, _hint=None):
    """Scrub URLs without changing FastAPI route-template transaction names."""
    request = event.get("request")
    if isinstance(request, dict) and isinstance(request.get("url"), str):
        request["url"] = strip_url_query(request["url"])
    for span in event.get("spans", []):
        if isinstance(span.get("description"), str):
            span["description"] = strip_url_query(span["description"])
        _scrub_data(span.get("data"))
    for breadcrumb in event.get("breadcrumbs", {}).get("values", []):
        sanitize_breadcrumb(breadcrumb)
        if isinstance(breadcrumb.get("message"), str):
            breadcrumb["message"] = redact_content(breadcrumb["message"])
    # Exception messages and log messages can carry prompts (provider errors echo
    # the input) or model refusal texts that describe the user's image (#159).
    for exception in (event.get("exception") or {}).get("values", []) or []:
        if isinstance(exception.get("value"), str):
            exception["value"] = redact_content(exception["value"])
    for field in ("logentry", "message"):
        entry = event.get(field)
        if isinstance(entry, dict):
            for key in ("message", "formatted"):
                if isinstance(entry.get(key), str):
                    entry[key] = redact_content(entry[key])
        elif isinstance(entry, str):
            event[field] = redact_content(entry)
    extra = event.get("extra")
    if isinstance(extra, dict):
        for key, value in extra.items():
            if isinstance(value, str):
                extra[key] = redact_content(value)
    return event
