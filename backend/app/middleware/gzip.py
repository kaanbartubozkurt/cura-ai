"""Response compression with a bypass for already-compressed media."""

from starlette.datastructures import Headers
from starlette.middleware.gzip import GZipMiddleware


class MediaAwareGZipMiddleware(GZipMiddleware):
    """Keep image and ZIP responses untouched, including streaming exports."""

    async def __call__(self, scope, receive, send):
        async def filtered_app(scope, receive, compressed_send):
            bypass = False

            async def send_response(message):
                nonlocal bypass
                if message["type"] == "http.response.start":
                    content_type = Headers(raw=message.get("headers", [])).get("content-type", "")
                    media_type = content_type.partition(";")[0].strip().lower()
                    bypass = media_type.startswith("image/") or media_type in (
                        "application/zip", "application/x-zip-compressed", "text/event-stream",
                    )
                await (send if bypass else compressed_send)(message)

            await self.app(scope, receive, send_response)

        await GZipMiddleware(
            filtered_app, minimum_size=self.minimum_size, compresslevel=self.compresslevel,
        )(scope, receive, send)
