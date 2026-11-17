"""Hourly billing metrics for Sentry and the margin guard."""
from types import SimpleNamespace
from unittest.mock import MagicMock

from app.workers import billing_metrics_tasks as task

SETTINGS = SimpleNamespace(billing_min_markup=1.5, billing_daily_cost_alert_usd=25.0)


def test_healthy_day_raises_no_alert():
    assert task.margin_alerts(cost_24h=13.78, charged_24h=27.55, settings=SETTINGS) == []


def test_charging_below_minimum_markup_alerts():
    alerts = dict(task.margin_alerts(cost_24h=10.0, charged_24h=12.0, settings=SETTINGS))
    assert "markup" in alerts and "1.20×" in alerts["markup"]


def test_tiny_cost_never_trips_the_markup_guard():
    assert task.margin_alerts(cost_24h=0.05, charged_24h=0.0, settings=SETTINGS) == []


def test_spend_over_daily_limit_alerts():
    alerts = dict(task.margin_alerts(cost_24h=30.0, charged_24h=60.0, settings=SETTINGS))
    assert list(alerts) == ["daily_cost"]


def test_test_and_mock_payments_are_not_revenue():
    query = MagicMock()
    query.filter.return_value = query
    task.real_payments(query)
    sql = " ".join(str(call.args[0].compile(compile_kwargs={"literal_binds": True}))
                   for call in query.filter.call_args_list)
    assert "mock_%" in sql and "NOT" in sql
    assert "TEST-%" in sql


def test_emit_sends_cost_charged_calls_and_revenue(monkeypatch):
    sent = []
    monkeypatch.setattr(task.sentry_sdk.metrics, "count",
                        lambda name, value, unit=None, attributes=None: sent.append((name, value, attributes)))
    task.emit({"usage": [{"provider": "fal", "model": "m", "operation": "edit", "calls": 2,
                          "cost_usd": 0.1, "charged_usd": 0.2}],
               "revenue": {"paypal_manual": 10.0}}, "dev")
    names = {(name, value) for name, value, _ in sent}
    assert {("billing.provider_cost_usd", 0.1), ("billing.charged_usd", 0.2), ("billing.calls", 2),
            ("billing.revenue_usd", 10.0)} <= names
    assert all(attrs["env"] == "dev" for _, _, attrs in sent)


def test_report_is_scheduled_hourly():
    from app.workers.celery_app import celery_app

    entry = celery_app.conf.beat_schedule["report-billing-metrics"]
    assert entry["task"] == "app.workers.billing_metrics_tasks.report_billing_metrics"
    assert entry["schedule"] == 3600.0
