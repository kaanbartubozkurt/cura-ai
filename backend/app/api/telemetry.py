"""Public bounded timing ingestion; authenticated administrator summaries."""
import asyncio
import hashlib
import ipaddress
import time
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from app.core.security import require_admin
from app.services import load_timings

router = APIRouter(prefix="/telemetry", tags=["telemetry"])


class TimingSample(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    metric: Literal["library_first_images", "api", "image"]
    key: str = Field(max_length=80)
    duration_ms: float = Field(ge=0, le=120000, allow_inf_nan=False)
    status: Literal["2xx", "3xx", "4xx", "5xx", "error"]
    connection: Literal["slow-2g", "2g", "3g", "4g"] | None = None

    @model_validator(mode="after")
    def validate_key(self):
        if self.metric == "image":
            valid = self.key in ("library_thumb", "generation_thumb", "full")
        elif self.metric == "library_first_images":
            valid = self.key in load_timings.ROUTES and not self.key.startswith("/api/")
        else:
            method, _, path = self.key.partition(" ")
            valid = method in ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS") and path in load_timings.ROUTES
        if not valid:
            raise ValueError("Invalid timing key")
        return self


class TimingPayload(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    samples: list[TimingSample] = Field(max_length=100)


def _client_address(request: Request) -> str:
    """Rate-limit per real client. Azure Container Apps ingress connects from a
    private/CGNAT address and appends the client to X-Forwarded-For; trust that
    header only when the direct peer is such a proxy address."""
    peer = request.client.host if request.client else "unknown"
    try:
        trusted = ipaddress.ip_address(peer) in _PROXY_NETWORKS or ipaddress.ip_address(peer).is_private
    except ValueError:
        trusted = False
    forwarded = request.headers.get("x-forwarded-for", "")
    if trusted and forwarded:
        # The last hop added by our ingress is the right-most entry.
        candidate = forwarded.split(",")[-1].strip()
        try:
            ipaddress.ip_address(candidate)
            return candidate
        except ValueError:
            pass
    return peer


_PROXY_NETWORKS = ipaddress.ip_network("100.64.0.0/10")


@router.post("/timings", status_code=204)
async def timings(request: Request):
    address = _client_address(request)
    identity = hashlib.sha256(address.encode()).hexdigest()
    store = load_timings.client()
    try:
        pipe = store.pipeline(transaction=True)
        key = f"{load_timings.PREFIX}rate:{identity}:{int(time.time() // 60)}"
        pipe.incr(key)
        pipe.expire(key, 120)
        # The sync Redis client runs in a thread to keep the event loop free.
        count, _ = await asyncio.to_thread(pipe.execute)
        if count > 30:
            raise HTTPException(429, "Timing rate limit exceeded")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(503, "Timing service unavailable") from None
    finally:
        store.close()
    # Do not trust Content-Length, forwarded addresses, or validation errors that
    # echo untrusted bodies. Stream at most 16KB, including chunked requests.
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > 16384:
            raise HTTPException(413, "Timing payload too large")
        body.extend(chunk)
    try:
        payload = TimingPayload.model_validate_json(body)
    except ValidationError:
        raise HTTPException(422, "Invalid timing payload") from None
    for sample in payload.samples:
        load_timings.record(sample.metric, sample.key, sample.duration_ms, sample.status)
    return Response(status_code=204)


@router.get("/summary", dependencies=[Depends(require_admin)])
def timing_summary():
    store = load_timings.client()
    try:
        return {"10m": load_timings.summary(store, 10), "1h": load_timings.summary(store, 60)}
    except Exception:
        raise HTTPException(503, "Timing service unavailable") from None
    finally:
        store.close()
