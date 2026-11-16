"""Latency telemetry contracts, without a Redis server or external webhooks."""
import asyncio
import json
from collections import defaultdict
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.api.telemetry import TimingPayload, router
from app.core.config import Settings
from app.core.security import require_admin
from app.middleware.load_timings import LoadTimingsMiddleware
from app.services import load_timings as timings
from app.services.discord_alerts import send_alert


class FakeRedis:
    def __init__(self):
        self.values = {}
        self.sets = defaultdict(set)
        self.hashes = defaultdict(dict)
        self.expires = {}
        self.commands = []

    def pipeline(self, transaction=False):
        return FakePipeline(self)

    def set(self, key, value, nx=False, ex=None):
        if nx and key in self.values:
            return False
        self.values[key] = value
        self.expires[key] = ex
        return True

    def get(self, key):
        return self.values.get(key)

    def delete(self, *keys):
        for key in keys:
            self.values.pop(key, None)

    def incr(self, key):
        self.values[key] = int(self.values.get(key, 0)) + 1
        return self.values[key]

    def expire(self, key, seconds):
        self.expires[key] = seconds
        return True

    def hincrby(self, key, field, count):
        self.hashes[key][field] = self.hashes[key].get(field, 0) + count

    def hgetall(self, key):
        return self.hashes[key]

    def sadd(self, key, value):
        self.sets[key].add(value)

    def smembers(self, key):
        return self.sets[key]

    def scan_iter(self, match):
        return [key for key in self.values if key.startswith(match.rstrip('*'))]

    def close(self):
        pass


class FakePipeline:
    def __init__(self, store):
        self.store = store
        self.commands = []

    def __getattr__(self, name):
        def queue(*args, **kwargs):
            self.commands.append((name, args, kwargs))
            return self
        return queue

    def execute(self):
        commands, self.commands = self.commands, []
        return [getattr(self.store, name)(*args, **kwargs) for name, args, kwargs in commands]


@pytest.fixture(autouse=True)
def clear_buffer():
    timings.pending.clear()
    yield
    timings.pending.clear()


@pytest.fixture
def http():
    app = FastAPI()
    app.include_router(router, prefix='/api')
    store = FakeRedis()
    with patch.object(timings, 'client', return_value=store):
        yield TestClient(app), store, app


def sample(**changes):
    return {'metric': 'api', 'key': 'GET /api/images', 'duration_ms': 2500.0,
            'status': '2xx', **changes}


@pytest.mark.parametrize('changes', [
    {'metric': 'server'}, {'duration_ms': -1}, {'duration_ms': 120001},
    {'duration_ms': '10'}, {'duration_ms': float('inf')}, {'secret': 'token'},
    {'key': 'GET /api/images/123?token=secret'}, {'key': 'GET /api/private-secret'},
    {'key': 'a' * 81}, {'status': '200'}, {'connection': 'secret-wifi'},
    {'metric': 'image', 'key': 'secret.png'},
])
def test_payload_validation(changes):
    with pytest.raises(ValidationError):
        TimingPayload.model_validate({'samples': [sample(**changes)]})


def test_limits_and_rate_limit(http):
    client, store, _ = http
    assert client.post('/api/telemetry/timings', json={'samples': [sample()] * 101}).status_code == 422
    assert client.post('/api/telemetry/timings', content=b' ' * 16385).status_code == 413
    assert client.post('/api/telemetry/timings', content=b'{bad').status_code == 422
    for _ in range(27):
        assert client.post('/api/telemetry/timings', json={'samples': [sample()]}).status_code == 204
    assert client.post('/api/telemetry/timings', json={'samples': []}).status_code == 429
    assert all('testclient' not in key for key in store.values)
    assert len(timings.pending) == 27


def test_summary_admin_only(http):
    client, _, app = http
    assert client.get('/api/telemetry/summary').status_code in (401, 403)
    app.dependency_overrides[require_admin] = lambda: object()
    assert client.get('/api/telemetry/summary').json() == {'10m': [], '1h': []}


@pytest.mark.parametrize('path,expected', [
    ('/api/images/123?token=secret', '/api/images/:id'),
    ('https://example.com/api/images/abcdefabcdefabcdef?prompt=secret', '/api/images/:id'),
    ('/api/images/files/private-photo.jpg?token=secret', '/api/images/files/:id'),
    ('/api/images/123/history/inputs/4', '/api/images/:id/history/inputs/:id'),
    ('/api/secrets/secret-token', '/:id'),
    ('/api/images/{image_id}', '/api/images/:id'),
])
def test_normalization(path, expected):
    assert timings.normalize_path(path) == expected


def add(store, metric, duration, now, count=5, key='GET /api/images'):
    for _ in range(count):
        timings.pending.append((now - 60, metric, key, duration, "2xx"))
    timings.flush(store)


def test_histogram_math_and_windows():
    store = FakeRedis()
    now = 120000
    for duration in (0, 10, 150, 200, 120000):
        add(store, 'api', duration, now, count=1)
    add(store, 'api', 100, now - 3600)
    row = timings.summary(store, 10, now)[0]
    assert row == {'metric': 'api', 'key': 'GET /api/images', 'count': 5,
                   'p50': 150, 'p75': 200, 'p95': 120000}
    assert all(value == 7200 for value in store.expires.values())
    assert timings.percentiles({}) == {'count': 0, 'p50': None, 'p75': None, 'p95': None}


@pytest.mark.parametrize('metric,threshold,key', [
    ('api', 2000, 'GET /api/images'), ('server', 1000, 'GET /api/images'),
    ('library_first_images', 4000, '/generate'), ('image', 3000, 'library_thumb'),
])
def test_threshold_min_samples_cooldown(metric, threshold, key):
    store = FakeRedis()
    settings = Settings()
    now = 120000
    with patch.object(timings, 'send_alert') as send:
        add(store, metric, threshold + 500, now, count=4, key=key)
        timings.evaluate(store, settings, now)
        send.assert_not_called()
        add(store, metric, threshold + 500, now, count=1, key=key)
        timings.evaluate(store, settings, now + 60)
        assert send.call_count == 1
        timings.evaluate(store, settings, now + 120)
        assert send.call_count == 1
        cooldown = next(k for k in store.values if 'cooldown:' in k)
        assert store.expires[cooldown] == 1800
        store.delete(cooldown)
        timings.evaluate(store, settings, now + 180)
        assert send.call_count == 2


@pytest.mark.parametrize('server,wording', [(100, 'outside the server'), (1500, 'server is also slow')])
def test_browser_vs_server(server, wording):
    store = FakeRedis()
    add(store, 'api', 9800, 120000)
    add(store, 'server', server, 120000)
    with patch.object(timings, 'send_alert') as send:
        timings.evaluate(store, Settings(), 120000)
    message = next(call.args[0] for call in send.call_args_list if 'Slow api' in call.args[0])
    assert wording in message
    assert 'Browser p75 9.8 s' in message


def test_recovered_requires_full_healthy_window():
    store = FakeRedis()
    settings = Settings(load_alert_window_minutes=1)
    now = 120000
    with patch.object(timings, 'send_alert') as send:
        add(store, 'api', 3000, now)
        timings.evaluate(store, settings, now)
        add(store, 'api', 100, now + 60)
        timings.evaluate(store, settings, now + 60)
        assert send.call_count == 1
        add(store, 'api', 100, now + 120)
        timings.evaluate(store, settings, now + 120)
        assert send.call_count == 2
        assert send.call_args.args[0].startswith('Recovered api')
        add(store, 'api', 100, now + 180)
        timings.evaluate(store, settings, now + 180)
        assert send.call_count == 2


@pytest.mark.parametrize('environment,secret,expected', [
    ('local', 'https://example.invalid/secret', 0), ('dev', '', 0),
    ('dev', 'https://example.invalid/secret', 1), ('prod', 'https://example.invalid/secret', 1),
])
def test_environment_gate(environment, secret, expected):
    with patch('app.services.discord_alerts.httpx.HTTPTransport') as transport:
        send_alert('Safe content', Settings(environment=environment, discord_alert_webhook_url=secret))
        assert transport.call_count == expected


def test_middleware_templates_and_exclusions():
    app = FastAPI()
    app.add_middleware(LoadTimingsMiddleware)

    @app.get('/api/images/{image_id}')
    def image(image_id: int):
        return {}

    @app.get('/health')
    @app.get('/api/health')
    @app.post('/api/telemetry/timings')
    def excluded():
        return {}

    client = TestClient(app)
    client.get('/api/images/123?token=secret')
    assert timings.pending[0][1:3] == ('server', 'GET /api/images/:id')
    for path in ('/health', '/api/health'):
        client.get(path)
    client.post('/api/telemetry/timings')
    assert len(timings.pending) == 1


def test_failed_request_is_measured():
    async def failed(scope, receive, send):
        raise RuntimeError('private')
    with pytest.raises(RuntimeError):
        asyncio.run(LoadTimingsMiddleware(failed)(
            {'type': 'http', 'method': 'GET', 'path': '/api/images/1'}, None, None))
    assert timings.pending[0][1:3] == ('server', 'GET /api/images/:id')


def test_no_raw_body_in_error(http):
    client, _, _ = http
    response = client.post('/api/telemetry/timings', content=json.dumps({'secret': 'private-token'}))
    assert response.status_code == 422
    assert 'private-token' not in response.text


def test_server_uses_p95_and_api_uses_p75():
    store = FakeRedis()
    for metric in ('api', 'server'):
        add(store, metric, 100, 120000, count=18)
        add(store, metric, 9000, 120000, count=2)
    with patch.object(timings, 'send_alert') as send:
        timings.evaluate(store, Settings(), 120000)
        timings.evaluate(store, Settings(), 120000)
    assert send.call_count == 1
    assert 'Slow server' in send.call_args.args[0]
    assert 'p95 9s' in send.call_args.args[0]


def test_exact_threshold_does_not_alert():
    store = FakeRedis()
    add(store, 'api', 2000, 120000)
    with patch.object(timings, 'send_alert') as send:
        timings.evaluate(store, Settings(), 120000)
    send.assert_not_called()


def test_missing_traffic_resets_recovery_timer():
    store = FakeRedis()
    settings = Settings(load_alert_window_minutes=1)
    now = 120000
    with patch.object(timings, 'send_alert') as send:
        add(store, 'api', 3000, now)
        timings.evaluate(store, settings, now)
        add(store, 'api', 100, now + 60)
        timings.evaluate(store, settings, now + 60)
        timings.evaluate(store, settings, now + 120)
        add(store, 'api', 100, now + 180)
        timings.evaluate(store, settings, now + 180)
        assert send.call_count == 1
        add(store, 'api', 100, now + 240)
        timings.evaluate(store, settings, now + 240)
        assert send.call_count == 2


def test_status_bins_are_combined_and_current_minute_excluded():
    store = FakeRedis()
    with patch.object(timings.time, 'time', return_value=120000):
        timings.record('server', 'GET /api/images', 200, '5xx')
        timings.flush(store)
        assert not timings.summary(store, 10, 120000)
        row = timings.summary(store, 10, 120060)[0]
    assert row['count'] == 1
    assert row['p95'] == 200
    assert any('5xx:200' in histogram for histogram in store.hashes.values())


def test_maximum_samples_allowed(http):
    client, _, _ = http
    response = client.post('/api/telemetry/timings', json={'samples': [sample()] * 100})
    assert response.status_code == 204
    assert len(timings.pending) == 100


def test_rate_limit_resets_next_minute(http):
    client, _, _ = http
    with patch('app.api.telemetry.time.time', return_value=120000):
        for _ in range(30):
            assert client.post('/api/telemetry/timings', json={'samples': []}).status_code == 204
        assert client.post('/api/telemetry/timings', json={'samples': []}).status_code == 429
    with patch('app.api.telemetry.time.time', return_value=120060):
        assert client.post('/api/telemetry/timings', json={'samples': []}).status_code == 204


def test_redis_unavailable_does_not_echo_exception(http):
    client, store, _ = http
    with patch.object(store, 'pipeline', side_effect=RuntimeError('secret-connection-string')):
        response = client.post('/api/telemetry/timings', json={'samples': [sample()]})
    assert response.status_code == 503
    assert 'secret' not in response.text


def test_template_lists_match_and_cover_registered_routes():
    import re
    from pathlib import Path

    from app.api import api_router

    root = Path(__file__).resolve().parents[2]
    assert json.loads((root / 'frontend/src/lib/timingRoutes.json').read_text()) == sorted(timings.ROUTES)
    for route in api_router.routes:
        template = re.sub(r'\{[^}]+\}', ':id', '/api' + route.path).rstrip('/')
        assert template in timings.ROUTES


def test_rate_limit_uses_forwarded_client_only_behind_ingress():
    from types import SimpleNamespace

    from app.api.telemetry import _client_address

    def req(peer, forwarded=None):
        headers = {"x-forwarded-for": forwarded} if forwarded else {}
        return SimpleNamespace(client=SimpleNamespace(host=peer), headers=headers)

    assert _client_address(req("100.100.0.226", "203.0.113.9")) == "203.0.113.9"
    assert _client_address(req("10.0.0.4", "198.51.100.1, 203.0.113.9")) == "203.0.113.9"
    assert _client_address(req("8.8.8.8", "198.51.100.1")) == "8.8.8.8"
    assert _client_address(req("100.100.0.226", "not-an-ip")) == "100.100.0.226"
    assert _client_address(req("100.100.0.226")) == "100.100.0.226"


def test_ingestion_accepts_text_plain_beacons(http):
    import json

    client, _, _ = http
    # Browsers send beacons as text/plain so the cross-origin POST needs no preflight.
    response = client.post('/api/telemetry/timings', content=json.dumps({'samples': [sample()]}),
                           headers={'Content-Type': 'text/plain;charset=UTF-8'})
    assert response.status_code == 204
