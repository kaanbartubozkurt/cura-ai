"""Pure ASGI request timing with no request-path Redis operations."""
import time

from app.services.load_timings import record, route_key


class LoadTimingsMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        if scope["type"] != "http" or not path.startswith("/api/") or path in (
            "/api/health", "/api/telemetry/timings", "/api/telemetry/timings/",
        ):
            return await self.app(scope, receive, send)
        start = time.perf_counter()
        status = "error"

        async def timed_send(message):
            nonlocal status
            if message["type"] == "http.response.start":
                status = f"{message['status'] // 100}xx"
            await send(message)

        try:
            await self.app(scope, receive, timed_send)
        finally:
            try:
                route = scope.get("route")
                template = getattr(route, "path", path)
                record("server", route_key(scope["method"], template),
                       (time.perf_counter() - start) * 1000, status)
            except Exception:
                pass
