# Load time measurements and Discord alerts

Browser measurements capture every Axios API request through response or error, a 20% sample of image loads through `LibraryImage`, and time from mounting a library grid or Create page (or changing its route) until four distinct card previews have loaded, or all previews if fewer exist. Cached images count. Empty grids do not report. A view that becomes hidden while waiting is discarded. Image timers start when a source is assigned, so lazy visibility waits and signed URL resolution are excluded; the first-images measurement includes those waits. Progressive preview upgrades do not count as additional cards.

The pure ASGI middleware measures `/api/` requests through response completion, including errors. It excludes health checks and timing ingestion. It uses matched route templates, with a conservative normalization fallback for unknown paths. Request handling appends to an in-memory queue capped at 10,000 samples; a background task flushes grouped histogram increments to Redis every five seconds. Queue overflow and Redis outages can lose samples without affecting application requests.

## Privacy and bounds

Payloads contain only metric, known route template or image kind, milliseconds, status class, and optional coarse effective connection type (`slow-2g`, `2g`, `3g`, `4g`). They contain no URLs, query strings, tokens, filenames, prompts, user content or user identifiers. Route normalization matches the checked-in known-template lists in `frontend/src/lib/timingRoutes.json` and `backend/app/services/timing_routes.json`; unknown paths become `/:id`. Run `python scripts/update-timing-routes.py` to synchronize both lists when adding routes. Static segments must be trusted application route names; dynamic segments are always `:id`.

The browser keeps at most 80 samples in memory, flushing every 30 seconds or when hidden, using a public beacon endpoint with keepalive fetch fallback. No access token or correlation headers are attached. Collection and transport are best effort and guarded against errors. The public `POST /api/telemetry/timings` accepts at most 16KB and 100 samples, rejects extra fields and unknown keys, and permits durations from 0 through 120,000ms. It limits each peer IP to 30 requests per fixed UTC minute in Redis (including malformed submissions). Invalid payload errors never echo the body. The rate-limit key uses a hash of the peer address and expires after two minutes. Forwarded headers are not read here; configure trusted proxy handling in the ASGI server for the deployment. Without it, clients behind a proxy share its rate limit.

Redis retains one-minute latency histograms for two hours, with 50ms upper-bound bins. Status classes are retained as aggregate histogram dimensions, and combined for percentile evaluation; connection hints are validated then discarded. Only aggregate latency counts are persisted. Percentiles use nearest rank and can overestimate by less than 50ms. There are no database tables or migrations.

## Thresholds and evaluation

| Metric | Percentile | Default threshold | Key |
|---|---|---|---|
| `library_first_images` | p75 | 4,000ms | Page template |
| `api` | p75 | 2,000ms | Method + API template |
| `image` | p75 | 3,000ms | `library_thumb`, `generation_thumb`, `full` |
| `server` | p95 | 1,000ms | Method + API template |

Evaluation requires five samples, uses the last ten **completed** minute buckets, and runs every minute. This deliberately excludes the partial current minute, so new data appears after the next minute boundary plus the flush/evaluation delay. The API process runs the evaluator in every environment, because DEV runs no Celery beat. A minute-specific Redis lock prevents multiple replicas (or a beat schedule, if one is added later) from evaluating the same minute.

Set `LOAD_ALERT_WINDOW_MINUTES` (1–120, default 10), `LOAD_ALERT_MIN_SAMPLES` (default 5), `LOAD_ALERT_COOLDOWN_SECONDS` (default 1800), and `LOAD_ALERT_LIBRARY_FIRST_IMAGES_MS`, `LOAD_ALERT_API_MS`, `LOAD_ALERT_IMAGE_MS`, `LOAD_ALERT_SERVER_MS` in the backend environment. These map to the `load_alert_*` settings in `app/core/config.py`.

Discord uses `DISCORD_ALERT_WEBHOOK_URL` and the shared helper used for failed-job alerts. Delivery is restricted to dev/prod, disables mentions, bypasses instrumented HTTP clients, never logs webhook URLs or exception messages, and fails silently. Each metric/key can alert once per cooldown. Recovery is sent once after a previously alerting series stays at or below threshold for a full evaluation window with sufficient samples at each evaluation. Sparse or missing traffic resets the recovery timer; silence is not evidence of recovery. Alert state expires after two hours without being refreshed by slow traffic. Discord delivery is best effort; a failed delivery still consumes cooldown.

## Reading and checking alerts

`Slow api GET /api/images on prod: p75 9.8s over the last 10 min (42 samples, threshold 2s)` identifies the route, percentile, window, count and threshold. API alerts also include matching server p95 when it has enough samples. A fast server with a slow browser points toward network or client work; a slow server means server work also contributes. These are aggregate populations, not correlated individual requests. Server alerts use p95 in their message. A recovered message indicates a full healthy window, rather than one fast request.

An administrator can inspect `GET /api/telemetry/summary` with the usual Bearer token. It returns `10m` and `1h` arrays with `metric`, `key`, `count`, `p50`, `p75`, `p95` (milliseconds). Non-admins are rejected. These windows also use completed minute buckets.

To test by hand on a development instance:

1. Open a library or Create page with images, keep it visible, and use browser network throttling. Wait 30 seconds or hide the tab to flush. Inspect the timing request to confirm only normalized keys and aggregate-safe fields are present.
2. For a deterministic slow series, POST `{"samples":[{"metric":"api","key":"GET /api/images","duration_ms":9800,"status":"2xx"}]}` five times to `/api/telemetry/timings`. Do not send auth or any user identifier to ingestion.
3. After the next completed minute and evaluation, inspect the admin summary and Discord. Ensure `ENVIRONMENT=dev` and the webhook is configured on the backend app. Local evaluation populates Redis but intentionally sends no Discord messages.
4. Keep adding enough low-duration samples for the slow values to leave the window, then maintain healthy traffic for a full window. Check for one recovery message. Lower the window to one minute for a faster dev test.
5. Run `PYTHONPATH=. NUMBA_CACHE_DIR=/tmp/cura-numba-cache pytest tests/test_load_timings.py` in `backend` for payload, rate-limit, histogram, threshold, cooldown, recovery, wording, environment and middleware checks without Redis or Discord.

## Sentry monitors

Sentry (sentry.io) also watches load times from its own tracing data and emails the owner: server API p95 over 1 s, browser API p75 over 2 s and page load (LCP) p75 over 4 s, all on DEV. The list is in CLAUDE.md under Observability → Sentry. The two systems answer different questions: Sentry keeps history and traces for digging in, while these alerts post to Discord, the channel that gets read. Sentry can't post to Discord on its current plan.
