"""Automated PayPal Checkout (#167): orders, capture, notifications, refunds.

PayPal's API is replaced by a fake that records requests and answers like
PayPal's Orders v2 API, so these tests check our side: the price comes from
the pack, sparks are credited exactly once however the confirmation arrives,
refunds take them back once, and unverified notifications change nothing.
"""
import asyncio
import json
import uuid
from decimal import Decimal

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models.billing import BalanceTransaction, UserBalance
from app.models.payment import PaymentStatus, PaymentTransaction, PaymentWebhookEvent, SparkPack
from app.models.user import User, UserRole
from app.services import discord_alerts
from app.services import payment_service as service_module
from app.services.payment_gateway import PayPalError, PayPalGateway, cents_to_value, value_to_cents
from app.services.payment_service import PaymentService

ORDER_ID = "5O190127TN364715T"
CAPTURE_ID = "3C679366HH908993F"
HEADERS = {
    "paypal-transmission-id": "t-1", "paypal-transmission-time": "2026-11-18T09:00:00Z",
    "paypal-transmission-sig": "sig", "paypal-cert-url": "https://api.sandbox.paypal.com/cert",
    "paypal-auth-algo": "SHA256withRSA",
}


class FakePayPal(PayPalGateway):
    """Answers like PayPal; ``capture_status``/``capture_value`` shape the capture result."""

    def __init__(self):
        super().__init__("client", "secret", webhook_id="WH-1")
        self.calls = []
        self.capture_status = "COMPLETED"
        self.capture_value = "25.00"
        self.capture_error = None
        self.signature_ok = True
        self.custom_id = None

    def capture(self):
        return {"id": CAPTURE_ID, "status": self.capture_status, "custom_id": self.custom_id,
                "amount": {"currency_code": "USD", "value": self.capture_value},
                "seller_receivable_breakdown": {"paypal_fee": {"value": "1.36"}}}

    async def _request(self, method, path, json_body=None, request_id=None):
        self.calls.append((method, path, json_body, request_id))
        if path == "/v2/checkout/orders":
            self.custom_id = json_body["purchase_units"][0]["custom_id"]
            return {"id": ORDER_ID, "status": "PAYER_ACTION_REQUIRED", "links": [
                {"rel": "self", "href": f"https://api.sandbox.paypal.com/v2/checkout/orders/{ORDER_ID}"},
                {"rel": "payer-action", "href": f"https://www.sandbox.paypal.com/checkoutnow?token={ORDER_ID}"},
            ]}
        if path.endswith("/capture"):
            if self.capture_error:
                raise PayPalError("declined", 422, self.capture_error)
            return {"id": ORDER_ID, "status": "COMPLETED",
                    "purchase_units": [{"payments": {"captures": [self.capture()]}}]}
        if path == "/v1/notifications/verify-webhook-signature":
            return {"verification_status": "SUCCESS" if self.signature_ok else "FAILURE"}
        if path.endswith("/refund"):
            return {"id": "REFUND-1", "status": "COMPLETED",
                    "seller_payable_breakdown": {"total_refunded_amount": {"value": "25.00"}}}
        raise AssertionError(f"unexpected PayPal call {method} {path}")


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    tables = [User.__table__, SparkPack.__table__, PaymentWebhookEvent.__table__,
              BalanceTransaction.__table__, PaymentTransaction.__table__, UserBalance.__table__]
    User.metadata.create_all(engine, tables=tables)
    session = Session(engine)
    session.add(User(id=1, email="buyer@example.test", hashed_password="x", role=UserRole.ADMIN))
    session.add(SparkPack(id=2, name="Creator", sparks_amount=15000, bonus_sparks=7000, price_cents=2500,
                          currency="USD", is_active=True, sort_order=2))
    session.commit()
    yield session
    session.close()


@pytest.fixture
def paypal(monkeypatch):
    fake = FakePayPal()
    monkeypatch.setattr(service_module, "get_payment_gateway", lambda: fake)
    monkeypatch.setattr(discord_alerts, "send_alert", lambda message, settings: fake.calls.append(("alert", message)))
    return fake


def balance(db) -> Decimal:
    row = db.query(UserBalance).filter(UserBalance.user_id == 1).first()
    return row.balance_sparks if row else Decimal(0)


def start_checkout(db) -> PaymentTransaction:
    result = asyncio.run(PaymentService(db, 1).create_checkout(
        pack_id=2, user_email="buyer@example.test",
        success_url="https://sightlab.org/billing?paypal=return",
        cancel_url="https://sightlab.org/billing?paypal=cancel",
    ))
    assert result["checkout_url"].endswith(f"token={ORDER_ID}")
    return db.query(PaymentTransaction).one()


def notify(db, event_type, resource, event_id=None):
    body = json.dumps({"id": event_id or f"WH-{uuid.uuid4().hex[:8]}", "event_type": event_type,
                       "resource_type": "capture", "resource": resource}).encode()
    return asyncio.run(PaymentService(db).handle_paypal_webhook(body, HEADERS))


def test_order_uses_the_pack_price_and_our_purchase_id(db, paypal):
    txn = start_checkout(db)
    method, path, body, request_id = paypal.calls[0]
    unit = body["purchase_units"][0]
    assert (method, path) == ("POST", "/v2/checkout/orders")
    assert unit["amount"] == {"currency_code": "USD", "value": "25.00"}
    assert unit["custom_id"] == str(txn.purchase_id)
    assert "22,000 sparks" in unit["description"]
    context = body["payment_source"]["paypal"]["experience_context"]
    assert context["return_url"].endswith("paypal=return") and context["shipping_preference"] == "NO_SHIPPING"
    assert request_id == f"order-{txn.purchase_id}"
    assert (txn.provider, txn.provider_session_id, txn.status) == ("paypal", ORDER_ID, PaymentStatus.PENDING)


def test_capture_on_return_credits_the_sparks_once(db, paypal):
    start_checkout(db)
    first = asyncio.run(PaymentService(db, 1).capture_paypal_order(ORDER_ID))
    again = asyncio.run(PaymentService(db, 1).capture_paypal_order(ORDER_ID))
    assert first["status"] == again["status"] == "completed"
    assert first["sparks"] == 22000 and first["payment_reference"] == CAPTURE_ID
    assert balance(db) == 22000
    assert sum(1 for call in paypal.calls if call[1].endswith("/capture")) == 1
    assert any("New purchase: Creator pack, $25.00" in str(call) and "fee $1.36" in str(call)
               for call in paypal.calls)


def test_return_and_notification_together_credit_once(db, paypal):
    start_checkout(db)
    asyncio.run(PaymentService(db, 1).capture_paypal_order(ORDER_ID))
    result = notify(db, "PAYMENT.CAPTURE.COMPLETED", paypal.capture())
    assert result["status"] == "processed"
    assert balance(db) == 22000
    assert db.query(BalanceTransaction).count() == 1


def test_buyer_who_never_comes_back_still_gets_the_sparks(db, paypal):
    txn = start_checkout(db)
    notify(db, "CHECKOUT.ORDER.APPROVED",
           {"id": ORDER_ID, "status": "APPROVED", "purchase_units": [{"custom_id": str(txn.purchase_id)}]})
    db.refresh(txn)
    assert txn.status == PaymentStatus.COMPLETED and balance(db) == 22000


def test_amount_that_does_not_match_the_pack_is_not_credited(db, paypal):
    start_checkout(db)
    paypal.capture_value = "0.01"
    with pytest.raises(ValueError):
        asyncio.run(PaymentService(db, 1).capture_paypal_order(ORDER_ID))
    assert balance(db) == 0
    assert db.query(PaymentTransaction).one().status == PaymentStatus.PENDING


def test_declined_card_fails_the_attempt_without_credit(db, paypal):
    start_checkout(db)
    paypal.capture_error = "INSTRUMENT_DECLINED"
    result = asyncio.run(PaymentService(db, 1).capture_paypal_order(ORDER_ID))
    assert result["status"] == "declined"
    assert db.query(PaymentTransaction).one().status == PaymentStatus.FAILED
    assert balance(db) == 0


def test_pending_capture_is_credited_when_paypal_confirms_it(db, paypal):
    start_checkout(db)
    paypal.capture_status = "PENDING"
    assert asyncio.run(PaymentService(db, 1).capture_paypal_order(ORDER_ID))["status"] == "pending"
    assert balance(db) == 0
    paypal.capture_status = "COMPLETED"
    notify(db, "PAYMENT.CAPTURE.COMPLETED", paypal.capture())
    assert balance(db) == 22000


def test_cancel_frees_the_attempt(db, paypal):
    start_checkout(db)
    assert PaymentService(db, 1).cancel_paypal_order(ORDER_ID)["status"] == "cancelled"
    assert db.query(PaymentTransaction).one().status == PaymentStatus.EXPIRED


def test_another_users_order_is_not_found(db, paypal):
    start_checkout(db)
    with pytest.raises(ValueError):
        asyncio.run(PaymentService(db, 99).capture_paypal_order(ORDER_ID))


def test_admin_refund_and_its_notification_remove_the_sparks_once(db, paypal):
    start_checkout(db)
    asyncio.run(PaymentService(db, 1).capture_paypal_order(ORDER_ID))
    txn = db.query(PaymentTransaction).one()
    result = asyncio.run(PaymentService(db).create_refund(txn.id))
    assert result["sparks_removed"] == 22000
    notify(db, "PAYMENT.CAPTURE.REFUNDED", {
        "id": "REFUND-1", "status": "COMPLETED", "amount": {"value": "25.00"},
        "seller_payable_breakdown": {"total_refunded_amount": {"value": "25.00"}},
        "links": [{"rel": "up", "href": f"https://api.sandbox.paypal.com/v2/payments/captures/{CAPTURE_ID}"}],
    })
    db.refresh(txn)
    assert txn.status == PaymentStatus.REFUNDED and balance(db) == 0
    assert db.query(BalanceTransaction).count() == 2


def test_refund_after_spending_leaves_a_negative_balance(db, paypal):
    start_checkout(db)
    asyncio.run(PaymentService(db, 1).capture_paypal_order(ORDER_ID))
    row = db.query(UserBalance).one()
    row.balance = row.balance_sparks = Decimal(2000)  # spent 20,000 of 22,000
    db.commit()
    notify(db, "PAYMENT.CAPTURE.REVERSED", {
        "id": "REV-1", "amount": {"value": "25.00"},
        "links": [{"rel": "up", "href": f"https://api.sandbox.paypal.com/v2/payments/captures/{CAPTURE_ID}"}],
    })
    assert balance(db) == -20000
    assert db.query(PaymentTransaction).one().status == PaymentStatus.DISPUTED


def test_partial_refunds_remove_sparks_in_proportion(db, paypal):
    start_checkout(db)
    asyncio.run(PaymentService(db, 1).capture_paypal_order(ORDER_ID))
    up = [{"rel": "up", "href": f"https://api.sandbox.paypal.com/v2/payments/captures/{CAPTURE_ID}"}]
    notify(db, "PAYMENT.CAPTURE.REFUNDED", {"id": "R1", "amount": {"value": "10.00"}, "links": up,
                                            "seller_payable_breakdown": {"total_refunded_amount": {"value": "10.00"}}})
    assert balance(db) == 22000 - 8800
    notify(db, "PAYMENT.CAPTURE.REFUNDED", {"id": "R2", "amount": {"value": "15.00"}, "links": up,
                                            "seller_payable_breakdown": {"total_refunded_amount": {"value": "25.00"}}})
    assert balance(db) == 0
    assert db.query(PaymentTransaction).one().status == PaymentStatus.REFUNDED


def test_unverified_notification_changes_nothing(db, paypal):
    start_checkout(db)
    paypal.signature_ok = False
    with pytest.raises(ValueError):
        notify(db, "PAYMENT.CAPTURE.COMPLETED", paypal.capture())
    assert balance(db) == 0 and db.query(PaymentWebhookEvent).count() == 0


def test_notification_without_signature_headers_is_rejected(db, paypal):
    body = json.dumps({"id": "WH-x", "event_type": "PAYMENT.CAPTURE.COMPLETED", "resource": {}}).encode()
    with pytest.raises(ValueError):
        asyncio.run(PaymentService(db).handle_paypal_webhook(body, {}))


def test_repeated_notification_is_processed_once(db, paypal):
    start_checkout(db)
    capture = paypal.capture()
    assert notify(db, "PAYMENT.CAPTURE.COMPLETED", capture, event_id="WH-same")["status"] == "processed"
    assert notify(db, "PAYMENT.CAPTURE.COMPLETED", capture, event_id="WH-same")["status"] == "already_processed"
    assert balance(db) == 22000


def test_stored_notification_keeps_no_payer_details(db, paypal):
    event = {"id": "WH-1", "event_type": "CHECKOUT.ORDER.APPROVED", "resource": {
        "id": ORDER_ID, "status": "APPROVED",
        "payer": {"email_address": "buyer@example.test", "name": {"given_name": "Ada"}},
        "purchase_units": [{"custom_id": "abc", "amount": {"value": "25.00"},
                            "shipping": {"address": {"address_line_1": "1 Main St"}}}]}}
    stored = json.dumps(PaymentService._trim_paypal_event(event))
    assert "buyer@example.test" not in stored and "Ada" not in stored and "Main St" not in stored
    assert "abc" in stored


def test_amount_conversions_are_exact():
    assert cents_to_value(2500) == "25.00" and cents_to_value(1005) == "10.05"
    assert value_to_cents("25.00") == 2500 and value_to_cents("10.5") == 1050 and value_to_cents("7") == 700


def test_manual_claim_form_is_hidden_once_checkout_is_automated(db, paypal, monkeypatch):
    from app.core.config import get_settings

    monkeypatch.setattr(get_settings(), "paypal_me_url", "https://paypal.me/someone")
    config = PaymentService(db).get_payment_config()
    assert config["automated"] and config["provider"] == "paypal"
    assert not config["manual_enabled"] and config["paypal_me_url"] == ""


def test_return_address_must_be_one_of_our_sites():
    from fastapi import HTTPException

    from app.api.billing import _safe_return_url

    assert _safe_return_url("http://localhost:3000/billing?paypal=return", "x").startswith("http://localhost")
    with pytest.raises(HTTPException):
        _safe_return_url("https://evil.example/steal", "x")


def test_checkout_page_flow_returns_the_order_id_without_return_urls(db, paypal):
    result = asyncio.run(PaymentService(db, 1).create_checkout(
        pack_id=2, user_email="buyer@example.test", success_url="https://sightlab.org/billing",
        cancel_url="https://sightlab.org/billing", flow="sdk",
    ))
    body = paypal.calls[0][2]
    assert result["order_id"] == ORDER_ID
    assert "payment_source" not in body
    assert body["application_context"]["shipping_preference"] == "NO_SHIPPING"
    assert "return_url" not in body["application_context"]
    asyncio.run(PaymentService(db, 1).capture_paypal_order(ORDER_ID))
    assert balance(db) == 22000


def test_redirect_flow_still_sends_return_urls(db, paypal):
    start_checkout(db)
    context = paypal.calls[0][2]["payment_source"]["paypal"]["experience_context"]
    assert context["return_url"] == "https://sightlab.org/billing?paypal=return"


def test_payment_config_exposes_the_public_client_id_only_for_paypal(db, paypal, monkeypatch):
    from app.core.config import get_settings

    monkeypatch.setattr(get_settings(), "paypal_client_id", "public-client-id")
    assert PaymentService(db).get_payment_config()["paypal_client_id"] == "public-client-id"
