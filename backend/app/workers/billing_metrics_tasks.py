"""Hourly cost and income metrics for Sentry, plus a margin guard.

Every hour (Celery Beat) this sends to Sentry, per provider/model/operation, what
providers cost us and what we charged since the last run, and real revenue from
completed payments. The Sentry dashboards "Provider cost" and "Income vs cost"
chart these metrics. It also alerts on Discord when, over the last 24 hours, we
charged less than ``billing_min_markup`` times our cost or spent more than
``billing_daily_cost_alert_usd``.
"""
import logging
from collections import defaultdict
from datetime import datetime, timedelta

import sentry_sdk
from sqlalchemy import func, or_

from app.core.config import get_settings
from app.db.base import SessionLocal
from app.models.billing import UsageRecord
from app.models.payment import PaymentStatus, PaymentTransaction
from app.services.discord_alerts import send_alert
from app.workers.celery_app import celery_app

logger = logging.getLogger(__name__)

WATERMARK_KEY = "billing_metrics:watermark"
ALERT_KEY = "billing_metrics:alerted:{}"
# Payments made by tests or the old mock gateway are not revenue.
TEST_PAYMENT_IDS = ("mock_%", "TEST-%")


def _redis():
    import redis

    return redis.Redis.from_url(get_settings().redis_url, socket_connect_timeout=5)


def real_payments(query):
    """Exclude test and mock-gateway payments (they were never real money)."""
    for pattern in TEST_PAYMENT_IDS:
        query = query.filter(
            or_(PaymentTransaction.provider_payment_id.is_(None), ~PaymentTransaction.provider_payment_id.like(pattern))
        )
    return query


def collect(db, since: datetime, until: datetime) -> dict:
    """Cost, charges and revenue between ``since`` (exclusive) and ``until`` (inclusive)."""
    rows = (
        db.query(
            UsageRecord.provider, UsageRecord.model, UsageRecord.operation,
            func.count(UsageRecord.id), func.coalesce(func.sum(UsageRecord.raw_cost), 0),
            func.coalesce(func.sum(UsageRecord.charged_cost), 0),
        )
        .filter(UsageRecord.created_at > since, UsageRecord.created_at <= until)
        .group_by(UsageRecord.provider, UsageRecord.model, UsageRecord.operation)
        .all()
    )
    usage = [
        {"provider": p or "unknown", "model": m or "unknown", "operation": o or "unknown",
         "calls": int(n), "cost_usd": float(cost), "charged_usd": float(charged)}
        for p, m, o, n, cost, charged in rows
    ]
    revenue = defaultdict(float)
    payments = real_payments(
        db.query(PaymentTransaction.provider, func.coalesce(func.sum(PaymentTransaction.amount_cents), 0))
        .filter(PaymentTransaction.status == PaymentStatus.COMPLETED,
                PaymentTransaction.completed_at > since, PaymentTransaction.completed_at <= until)
    ).group_by(PaymentTransaction.provider).all()
    for provider, cents in payments:
        revenue[provider or "unknown"] += float(cents) / 100
    return {"usage": usage, "revenue": dict(revenue)}


def emit(data: dict, environment: str) -> None:
    """Send the collected numbers to Sentry as metrics (summed in the dashboards)."""
    for row in data["usage"]:
        attrs = {"provider": row["provider"], "model": row["model"], "operation": row["operation"],
                 "env": environment}
        sentry_sdk.metrics.count("billing.provider_cost_usd", row["cost_usd"], unit="usd", attributes=attrs)
        sentry_sdk.metrics.count("billing.charged_usd", row["charged_usd"], unit="usd", attributes=attrs)
        sentry_sdk.metrics.count("billing.calls", row["calls"], attributes=attrs)
    for provider, usd in data["revenue"].items():
        sentry_sdk.metrics.count("billing.revenue_usd", usd, unit="usd",
                                 attributes={"provider": provider, "env": environment})


def margin_alerts(cost_24h: float, charged_24h: float, settings) -> list[tuple[str, str]]:
    """(key, message) for each guard the last 24 hours trip."""
    alerts = []
    if cost_24h >= 0.10 and charged_24h < cost_24h * settings.billing_min_markup:
        alerts.append(("markup", (
            f"Billing margin guard: in the last 24 h we charged ${charged_24h:.2f} for ${cost_24h:.2f} of "
            f"provider cost ({charged_24h / cost_24h:.2f}×, minimum {settings.billing_min_markup:.2f}×). "
            "Check cost_catalog prices and markups."
        )))
    if cost_24h > settings.billing_daily_cost_alert_usd:
        alerts.append(("daily_cost", (
            f"Billing margin guard: provider cost in the last 24 h is ${cost_24h:.2f}, above the "
            f"${settings.billing_daily_cost_alert_usd:.2f} limit (charged ${charged_24h:.2f})."
        )))
    return alerts


@celery_app.task(name="app.workers.billing_metrics_tasks.report_billing_metrics")
def report_billing_metrics():
    settings = get_settings()
    now = datetime.utcnow()
    store = None
    try:
        store = _redis()
        raw = store.get(WATERMARK_KEY)
        since = datetime.fromisoformat(raw.decode()) if raw else now - timedelta(hours=1)
    except Exception:
        logger.warning("Billing metrics: Redis unavailable, reporting the last hour", exc_info=True)
        since = now - timedelta(hours=1)
    db = SessionLocal()
    try:
        data = collect(db, since, now)
        emit(data, settings.environment)
        last_day = collect(db, now - timedelta(hours=24), now)
        cost_24h = sum(row["cost_usd"] for row in last_day["usage"])
        charged_24h = sum(row["charged_usd"] for row in last_day["usage"])
        sentry_sdk.metrics.gauge("billing.markup_24h", charged_24h / cost_24h if cost_24h else 0,
                                 attributes={"env": settings.environment})
        for key, message in margin_alerts(cost_24h, charged_24h, settings):
            # At most one alert per guard per day.
            if store is None or store.set(ALERT_KEY.format(key), "1", nx=True, ex=86400):
                send_alert(message, settings)
                logger.warning(message)
        if store is not None:
            store.set(WATERMARK_KEY, now.isoformat())
        logger.info("Billing metrics reported since %s: %d groups, $%.4f cost, $%.4f charged",
                    since.isoformat(), len(data["usage"]),
                    sum(r["cost_usd"] for r in data["usage"]), sum(r["charged_usd"] for r in data["usage"]))
        return {"since": since.isoformat(), "groups": len(data["usage"]), "cost_24h": cost_24h,
                "charged_24h": charged_24h}
    finally:
        db.close()
        if store is not None:
            store.close()
