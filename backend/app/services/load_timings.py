"""Bounded, anonymous latency histograms and best-effort alert evaluation."""
import asyncio
import hashlib
import json
import math
import re
import time
from collections import Counter, deque
from pathlib import Path
from urllib.parse import urlsplit

import redis

from app.core.config import get_settings
from app.services.discord_alerts import send_alert

ROUTES = json.loads(Path(__file__).with_name("timing_routes.json").read_text())
ROUTES = sorted(ROUTES, key=lambda path: (path.count(":id"), -len(path)))
PATTERNS = [(route, re.compile("^" + re.escape(route).replace(":id", "[^/]+") + "/?$")) for route in ROUTES]
PREFIX = "load-timings:"
TTL = 7200
pending = deque(maxlen=10000)


def normalize_path(value):
    """Only return known templates; unknown paths never become telemetry keys."""
    path = urlsplit(value).path
    for route, pattern in PATTERNS:
        if pattern.fullmatch(path):
            return route
    return "/:id"


def route_key(method, path):
    return f"{method.upper()} {normalize_path(path)}"[:80]


def client():
    return redis.Redis.from_url(get_settings().redis_url, decode_responses=True,
                               socket_timeout=2, socket_connect_timeout=2)


def record(metric, key, duration_ms, status="2xx"):
    """No I/O on the request path; drop oldest samples during overload."""
    pending.append((time.time(), metric, key, min(120000, max(0, duration_ms)), status))


def flush(store):
    batch = []
    while pending and len(batch) < 10000:
        batch.append(pending.popleft())
    if not batch:
        return
    buckets = {}
    identities = set()
    for timestamp, metric, key, duration, status in batch:
        identity = json.dumps([metric, key], separators=(",", ":"))
        identities.add(identity)
        bucket = f"{PREFIX}bucket:{identity}:{int(timestamp // 60)}"
        histogram = buckets.setdefault(bucket, Counter())
        # Fixed 50ms upper bounds, capped at 120s. At most 2401 bins per minute.
        histogram[f"{status}:{math.ceil(duration / 50) * 50}"] += 1
    pipe = store.pipeline(transaction=False)
    for bucket, histogram in buckets.items():
        for bound, count in histogram.items():
            pipe.hincrby(bucket, bound, count)
        pipe.expire(bucket, TTL)
    for identity in identities:
        pipe.sadd(PREFIX + "series", identity)
    pipe.expire(PREFIX + "series", TTL)
    pipe.execute()


def percentiles(histogram):
    count = sum(histogram.values())
    result = {"count": count}
    for percentile in (50, 75, 95):
        rank = math.ceil(count * percentile / 100)
        cumulative = 0
        result[f"p{percentile}"] = None
        for bound, frequency in sorted(histogram.items()):
            cumulative += frequency
            if cumulative >= rank:
                result[f"p{percentile}"] = bound
                break
    return result


def summary(store, minutes, now=None):
    # Completed minute buckets give stable, full windows and exclude future data.
    minute = int((time.time() if now is None else now) // 60)
    identities = sorted(store.smembers(PREFIX + "series"))
    pipe = store.pipeline(transaction=False)
    for identity in identities:
        for index in range(minute - minutes, minute):
            pipe.hgetall(f"{PREFIX}bucket:{identity}:{index}")
    rows = iter(pipe.execute())
    result = []
    for identity in identities:
        histogram = Counter()
        for _ in range(minutes):
            for field, count in next(rows).items():
                histogram[int(field.rsplit(":", 1)[-1])] += int(count)
        if histogram:
            metric, key = json.loads(identity)
            result.append({"metric": metric, "key": key, **percentiles(histogram)})
    return result


def evaluate(store, settings=None, now=None):
    settings = settings or get_settings()
    now = time.time() if now is None else now
    if not store.set(f"{PREFIX}evaluate:{int(now // 60)}", "1", nx=True, ex=120):
        return
    rows = summary(store, settings.load_alert_window_minutes, now)
    servers = {row["key"]: row for row in rows if row["metric"] == "server"}
    for row in rows:
        metric, key = row["metric"], row["key"]
        identity = hashlib.sha256(f"{metric}:{key}".encode()).hexdigest()
        active = PREFIX + "active:" + identity
        healthy = PREFIX + "healthy:" + identity
        cooldown = PREFIX + "cooldown:" + identity
        threshold = getattr(settings, f"load_alert_{metric}_ms")
        percentile = "p95" if metric == "server" else "p75"
        if row["count"] < settings.load_alert_min_samples:
            store.delete(healthy)
            continue
        if row[percentile] > threshold:
            store.delete(healthy)
            store.set(active, "1", ex=TTL)
            if not store.set(cooldown, "1", nx=True, ex=settings.load_alert_cooldown_seconds):
                continue
            message = (
                f"Slow {metric} {key} on {settings.environment}: {percentile} {row[percentile] / 1000:g}s "
                f"over the last {settings.load_alert_window_minutes} min "
                f"({row['count']} samples, threshold {threshold / 1000:g}s)"
            )
            if metric == "api":
                server = servers.get(key)
                if server and server["count"] >= settings.load_alert_min_samples:
                    explanation = ("the server is also slow" if server["p95"] > settings.load_alert_server_ms
                                   else "the time is outside the server (network or client)")
                    message += (f"\nBrowser p75 {row['p75'] / 1000:g} s · server p95 "
                                f"{server['p95'] / 1000:g} s, so {explanation}")
                else:
                    message += "\nMatching server p95 unavailable (insufficient samples)."
            send_alert(message, settings)
        elif store.get(active):
            store.set(healthy, str(now), nx=True, ex=TTL)
            if now - float(store.get(healthy)) >= settings.load_alert_window_minutes * 60:
                send_alert(f"Recovered {metric} {key} on {settings.environment}: "
                           f"{percentile} under {threshold / 1000:g}s for a full "
                           f"{settings.load_alert_window_minutes} min window", settings)
                store.delete(active, healthy)
    # Missing traffic cannot establish continuous recovery.
    observed = {hashlib.sha256(f"{r['metric']}:{r['key']}".encode()).hexdigest() for r in rows}
    for state in store.scan_iter(match=PREFIX + "healthy:*"):
        if state.rsplit(":", 1)[-1] not in observed:
            store.delete(state)


async def run_background():
    """Flush and evaluate off the event loop. DEV has no Celery beat, so the API
    process evaluates in every environment; the per-minute Redis lock in
    evaluate() keeps replicas (and beat, if one runs) from double-alerting."""
    store = client()
    try:
        while True:
            try:
                await asyncio.to_thread(flush, store)
                await asyncio.to_thread(evaluate, store)
            except Exception:
                # Telemetry must never affect serving requests or log payloads.
                pass
            await asyncio.sleep(5)
    finally:
        store.close()
