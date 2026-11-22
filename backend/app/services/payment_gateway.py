"""Payment gateway abstraction with Lemon Squeezy implementation."""
import hashlib
import hmac
import logging
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass

import httpx

from app.core.config import get_settings
from app.models.payment import SparkPack, SubscriptionPlan

logger = logging.getLogger(__name__)

try:
    import sentry_sdk
except ImportError:
    sentry_sdk = None  # type: ignore[assignment]


@dataclass
class CheckoutResult:
    checkout_url: str
    provider_session_id: str | None = None


@dataclass
class RefundResult:
    success: bool
    provider_refund_id: str | None = None
    error: str | None = None


class PaymentGateway(ABC):
    """Abstract payment gateway interface."""

    # Stored in payment_transactions.provider for purchases made through it.
    name = "unknown"

    @abstractmethod
    async def create_checkout_session(
        self,
        pack: SparkPack,
        purchase_id: uuid.UUID,
        user_id: int,
        user_email: str,
        success_url: str,
        cancel_url: str,
    ) -> CheckoutResult:
        ...

    @abstractmethod
    def verify_webhook(self, payload: bytes, signature: str, secret: str) -> dict:
        ...

    @abstractmethod
    async def create_refund(
        self, provider_payment_id: str, amount_cents: int | None = None
    ) -> RefundResult:
        ...

    @abstractmethod
    async def create_subscription_checkout(
        self,
        plan: SubscriptionPlan,
        user_id: int,
        user_email: str,
        success_url: str,
        cancel_url: str,
    ) -> CheckoutResult:
        ...

    @abstractmethod
    async def cancel_subscription(
        self, provider_subscription_id: str
    ) -> dict:
        ...


class LemonSqueezyGateway(PaymentGateway):
    """Lemon Squeezy payment gateway."""

    BASE_URL = "https://api.lemonsqueezy.com/v1"
    name = "lemon_squeezy"

    def __init__(self, api_key: str, store_id: str):
        self.api_key = api_key
        self.store_id = store_id

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Accept": "application/vnd.api+json",
            "Content-Type": "application/vnd.api+json",
        }

    async def create_checkout_session(
        self,
        pack: SparkPack,
        purchase_id: uuid.UUID,
        user_id: int,
        user_email: str,
        success_url: str,
        cancel_url: str,
    ) -> CheckoutResult:
        if not pack.provider_variant_id:
            raise ValueError(
                f"Pack '{pack.name}' has no provider_variant_id configured. "
                "Set it in the spark_packs table to match a Lemon Squeezy variant."
            )

        payload = {
            "data": {
                "type": "checkouts",
                "attributes": {
                    "checkout_data": {
                        "email": user_email,
                        "custom": {
                            "purchase_id": str(purchase_id),
                            "user_id": str(user_id),
                        },
                    },
                    "product_options": {
                        "redirect_url": success_url,
                    },
                    "expires_at": None,
                },
                "relationships": {
                    "store": {
                        "data": {"type": "stores", "id": self.store_id}
                    },
                    "variant": {
                        "data": {
                            "type": "variants",
                            "id": pack.provider_variant_id,
                        }
                    },
                },
            }
        }

        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(
                    f"{self.BASE_URL}/checkouts",
                    json=payload,
                    headers=self._headers(),
                )
                resp.raise_for_status()
                data = resp.json()
        except httpx.HTTPStatusError as e:
            logger.error("LS checkout API error: %s %s", e.response.status_code, e.response.text)
            if sentry_sdk:
                sentry_sdk.capture_exception(e)
            raise
        except httpx.HTTPError as e:
            logger.error("LS checkout network error: %s", e)
            if sentry_sdk:
                sentry_sdk.capture_exception(e)
            raise

        checkout_url = data["data"]["attributes"]["url"]
        session_id = data["data"]["id"]
        return CheckoutResult(checkout_url=checkout_url, provider_session_id=session_id)

    def verify_webhook(self, payload: bytes, signature: str, secret: str) -> dict:
        computed = hmac.new(
            secret.encode(), payload, hashlib.sha256,
        ).hexdigest()
        if not hmac.compare_digest(computed, signature):
            raise ValueError("Invalid webhook signature")
        import json

        return json.loads(payload)

    async def create_refund(
        self, provider_payment_id: str, amount_cents: int | None = None
    ) -> RefundResult:
        payload = {
            "data": {
                "type": "orders",
                "id": provider_payment_id,
            }
        }

        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{self.BASE_URL}/orders/{provider_payment_id}/refund",
                json=payload,
                headers=self._headers(),
            )

        if resp.status_code in (200, 201):
            return RefundResult(
                success=True,
                provider_refund_id=provider_payment_id,
            )
        return RefundResult(
            success=False,
            error=f"Refund failed: {resp.status_code} {resp.text}",
        )


    async def create_subscription_checkout(
        self,
        plan: SubscriptionPlan,
        user_id: int,
        user_email: str,
        success_url: str,
        cancel_url: str,
    ) -> CheckoutResult:
        if not plan.provider_variant_id:
            raise ValueError(
                f"Plan '{plan.name}' has no provider_variant_id configured."
            )

        payload = {
            "data": {
                "type": "checkouts",
                "attributes": {
                    "checkout_data": {
                        "email": user_email,
                        "custom": {
                            "plan_id": str(plan.id),
                            "user_id": str(user_id),
                        },
                    },
                    "product_options": {
                        "redirect_url": success_url,
                    },
                    "expires_at": None,
                },
                "relationships": {
                    "store": {
                        "data": {"type": "stores", "id": self.store_id}
                    },
                    "variant": {
                        "data": {
                            "type": "variants",
                            "id": plan.provider_variant_id,
                        }
                    },
                },
            }
        }

        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(
                    f"{self.BASE_URL}/checkouts",
                    json=payload,
                    headers=self._headers(),
                )
                resp.raise_for_status()
                data = resp.json()
        except httpx.HTTPStatusError as e:
            logger.error("LS subscription checkout API error: %s %s", e.response.status_code, e.response.text)
            if sentry_sdk:
                sentry_sdk.capture_exception(e)
            raise
        except httpx.HTTPError as e:
            logger.error("LS subscription checkout network error: %s", e)
            if sentry_sdk:
                sentry_sdk.capture_exception(e)
            raise

        checkout_url = data["data"]["attributes"]["url"]
        session_id = data["data"]["id"]
        return CheckoutResult(checkout_url=checkout_url, provider_session_id=session_id)

    async def cancel_subscription(
        self, provider_subscription_id: str
    ) -> dict:
        payload = {
            "data": {
                "type": "subscriptions",
                "id": provider_subscription_id,
                "attributes": {"cancelled": True},
            }
        }

        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.patch(
                    f"{self.BASE_URL}/subscriptions/{provider_subscription_id}",
                    json=payload,
                    headers=self._headers(),
                )
                resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            logger.error("LS cancel subscription API error: %s %s", e.response.status_code, e.response.text)
            if sentry_sdk:
                sentry_sdk.capture_exception(e)
            raise
        except httpx.HTTPError as e:
            logger.error("LS cancel subscription network error: %s", e)
            if sentry_sdk:
                sentry_sdk.capture_exception(e)
            raise

        return {"success": True}


class MockPaymentGateway(PaymentGateway):
    """Mock gateway for local development without LS credentials."""

    name = "mock"

    async def create_checkout_session(
        self,
        pack: SparkPack,
        purchase_id: uuid.UUID,
        user_id: int,
        user_email: str,
        success_url: str,
        cancel_url: str,
    ) -> CheckoutResult:
        # Return the success URL directly for local testing
        mock_url = success_url
        logger.info(
            "Mock checkout: pack=%s purchase_id=%s user=%d → %s",
            pack.name, purchase_id, user_id, mock_url,
        )
        return CheckoutResult(
            checkout_url=mock_url,
            provider_session_id=f"mock_{purchase_id}",
        )

    def verify_webhook(self, payload: bytes, signature: str, secret: str) -> dict:
        import json

        return json.loads(payload)

    async def create_refund(
        self, provider_payment_id: str, amount_cents: int | None = None
    ) -> RefundResult:
        return RefundResult(success=True, provider_refund_id=provider_payment_id)

    async def create_subscription_checkout(
        self,
        plan: SubscriptionPlan,
        user_id: int,
        user_email: str,
        success_url: str,
        cancel_url: str,
    ) -> CheckoutResult:
        mock_url = success_url
        logger.info(
            "Mock subscription checkout: plan=%s user=%d → %s",
            plan.name, user_id, mock_url,
        )
        return CheckoutResult(
            checkout_url=mock_url,
            provider_session_id=f"mock_sub_{plan.id}_{user_id}",
        )

    async def cancel_subscription(
        self, provider_subscription_id: str
    ) -> dict:
        return {"success": True}


class PayPalError(RuntimeError):
    """A PayPal API call failed. ``name`` is PayPal's error name (e.g. INSTRUMENT_DECLINED)."""

    def __init__(self, message: str, status_code: int = 0, name: str = "", debug_id: str = ""):
        super().__init__(message)
        self.status_code = status_code
        self.name = name
        self.debug_id = debug_id


def cents_to_value(cents: int) -> str:
    """PayPal amounts are decimal strings: 2500 -> "25.00"."""
    return f"{cents // 100}.{cents % 100:02d}"


def value_to_cents(value: str | None) -> int:
    """"25.00" -> 2500 (exact, no float rounding)."""
    if not value:
        return 0
    whole, _, frac = str(value).partition(".")
    return int(whole or 0) * 100 + int((frac + "00")[:2])


class PayPalGateway(PaymentGateway):
    """PayPal Checkout with the Orders v2 REST API (#167).

    Flow: create an order for the pack (price from our database) → the buyer
    approves it on PayPal → we capture it when they come back, or when PayPal
    notifies us (CHECKOUT.ORDER.APPROVED) if they never come back. Requests
    carry a PayPal-Request-Id so retries never create a second order, capture
    or refund. Our purchase_id travels as the order's custom_id, which PayPal
    copies onto captures, so notifications can be matched to a purchase.
    """

    name = "paypal"
    SANDBOX_URL = "https://api-m.sandbox.paypal.com"
    LIVE_URL = "https://api-m.paypal.com"
    # Access tokens are cached per client id until shortly before they expire.
    _tokens: dict[str, tuple[str, float]] = {}

    def __init__(self, client_id: str, client_secret: str, webhook_id: str = "", mode: str = "sandbox"):
        self.client_id = client_id
        self.client_secret = client_secret
        self.webhook_id = webhook_id
        self.mode = "live" if mode == "live" else "sandbox"
        self.base_url = self.LIVE_URL if self.mode == "live" else self.SANDBOX_URL

    async def _token(self) -> str:
        import time

        cached = self._tokens.get(self.client_id)
        if cached and cached[1] > time.time() + 60:
            return cached[0]
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{self.base_url}/v1/oauth2/token",
                data={"grant_type": "client_credentials"},
                auth=(self.client_id, self.client_secret),
                headers={"Accept": "application/json"},
            )
        if resp.status_code != 200:
            # Never log the response body here: it can echo request details.
            raise PayPalError(f"PayPal authentication failed ({resp.status_code})", resp.status_code)
        data = resp.json()
        token = data["access_token"]
        self._tokens[self.client_id] = (token, time.time() + int(data.get("expires_in", 300)))
        return token

    async def _request(self, method: str, path: str, json_body: dict | None = None,
                       request_id: str | None = None) -> dict:
        headers = {
            "Authorization": f"Bearer {await self._token()}",
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        }
        if request_id:
            headers["PayPal-Request-Id"] = request_id
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.request(method, f"{self.base_url}{path}", json=json_body, headers=headers)
        if resp.status_code >= 400:
            try:
                err = resp.json()
            except ValueError:
                err = {}
            name = err.get("name", "")
            issue = ((err.get("details") or [{}])[0] or {}).get("issue", "")
            debug_id = err.get("debug_id", "")
            # Error names and debug ids only: PayPal's messages can include payer details.
            logger.warning("PayPal %s %s failed: %s %s %s debug_id=%s",
                           method, path.split("?")[0], resp.status_code, name, issue, debug_id)
            raise PayPalError(f"PayPal {name or 'error'} {issue}".strip(), resp.status_code,
                              issue or name, debug_id)
        return resp.json() if resp.content else {}

    async def create_checkout_session(
        self,
        pack: SparkPack,
        purchase_id: uuid.UUID,
        user_id: int,
        user_email: str,
        success_url: str,
        cancel_url: str,
        flow: str = "redirect",
    ) -> CheckoutResult:
        """Create the order. ``flow="redirect"`` sends the buyer to PayPal and back;
        ``flow="sdk"`` is for PayPal's buttons on our own checkout page (no return URLs)."""
        sparks = pack.sparks_amount + pack.bonus_sparks
        experience = {"brand_name": "SightLab", "user_action": "PAY_NOW", "shipping_preference": "NO_SHIPPING"}
        if flow == "redirect":
            experience.update({"return_url": success_url, "cancel_url": cancel_url})
        body = {
            "intent": "CAPTURE",
            "purchase_units": [{
                "reference_id": str(purchase_id),
                "custom_id": str(purchase_id),
                "invoice_id": str(purchase_id),
                "description": f"SightLab {pack.name} pack: {sparks:,} sparks",
                "amount": {"currency_code": pack.currency, "value": cents_to_value(pack.price_cents)},
            }],
        }
        if flow == "redirect":
            body["payment_source"] = {"paypal": {"experience_context": experience}}
        else:
            # The JS SDK picks the payment source (PayPal or card); this keeps the
            # brand name and stops PayPal from asking for a shipping address.
            body["application_context"] = experience
        order = await self._request("POST", "/v2/checkout/orders", body, request_id=f"order-{purchase_id}")
        approve = next((link["href"] for link in order.get("links", [])
                        if link.get("rel") in ("payer-action", "approve")), None)
        if flow == "sdk":
            return CheckoutResult(checkout_url=approve or "", provider_session_id=order["id"])
        if not approve:
            raise PayPalError("PayPal returned no approval link")
        return CheckoutResult(checkout_url=approve, provider_session_id=order["id"])

    async def capture_order(self, order_id: str) -> dict:
        """Capture an approved order. Capturing twice returns the order as it is."""
        try:
            return await self._request("POST", f"/v2/checkout/orders/{order_id}/capture", {},
                                       request_id=f"capture-{order_id}")
        except PayPalError as e:
            if e.name == "ORDER_ALREADY_CAPTURED":
                return await self.get_order(order_id)
            raise

    async def get_order(self, order_id: str) -> dict:
        return await self._request("GET", f"/v2/checkout/orders/{order_id}")

    async def verify_notification(self, payload: bytes, headers) -> dict:
        """Check a webhook with PayPal and return the event; raises ValueError if it isn't genuine."""
        import json

        if not self.webhook_id:
            raise ValueError("PAYPAL_WEBHOOK_ID is not configured")
        names = ("transmission_id", "transmission_time", "transmission_sig", "cert_url", "auth_algo")
        values = {n: headers.get(f"paypal-{n.replace('_', '-')}") for n in names}
        if not all(values.values()):
            raise ValueError("Missing PayPal signature headers")
        event = json.loads(payload)
        result = await self._request("POST", "/v1/notifications/verify-webhook-signature", {
            **values, "webhook_id": self.webhook_id, "webhook_event": event,
        })
        if result.get("verification_status") != "SUCCESS":
            raise ValueError("Invalid PayPal webhook signature")
        return event

    def verify_webhook(self, payload: bytes, signature: str, secret: str) -> dict:
        raise NotImplementedError("PayPal webhooks are verified with verify_notification()")

    async def create_refund(
        self, provider_payment_id: str, amount_cents: int | None = None
    ) -> RefundResult:
        """Refund a capture in full (amount_cents=None) or in part."""
        body: dict = {}
        if amount_cents is not None:
            body = {"amount": {"value": cents_to_value(amount_cents), "currency_code": "USD"}}
        try:
            refund = await self._request(
                "POST", f"/v2/payments/captures/{provider_payment_id}/refund", body,
                request_id=f"refund-{provider_payment_id}-{amount_cents or 'full'}",
            )
        except PayPalError as e:
            return RefundResult(success=False, error=str(e))
        return RefundResult(success=refund.get("status") in ("COMPLETED", "PENDING"),
                            provider_refund_id=refund.get("id"),
                            error=None if refund.get("status") != "FAILED" else "PayPal refund failed")

    async def get_capture(self, capture_id: str) -> dict:
        return await self._request("GET", f"/v2/payments/captures/{capture_id}")

    async def create_subscription_checkout(self, plan, user_id, user_email, success_url, cancel_url):
        raise ValueError("Monthly plans aren't available with PayPal yet")

    async def cancel_subscription(self, provider_subscription_id: str) -> dict:
        raise ValueError("Monthly plans aren't available with PayPal yet")


class PaymentsNotConfiguredError(RuntimeError):
    """No real payment gateway is configured and the mock is not allowed."""


def get_payment_gateway() -> PaymentGateway:
    """Factory: returns configured payment gateway.

    The mock gateway auto-completes purchases (credits sparks without any
    payment), so it is only returned in local dev or with an explicit
    PAYMENTS_ALLOW_MOCK opt-in. Cloud environments without Lemon Squeezy
    credentials raise PaymentsNotConfiguredError instead.
    """
    settings = get_settings()
    if settings.paypal_client_id and settings.paypal_client_secret:
        return PayPalGateway(
            client_id=settings.paypal_client_id,
            client_secret=settings.paypal_client_secret,
            webhook_id=settings.paypal_webhook_id,
            mode=settings.paypal_mode,
        )
    if settings.lemon_squeezy_api_key:
        return LemonSqueezyGateway(
            api_key=settings.lemon_squeezy_api_key,
            store_id=settings.lemon_squeezy_store_id,
        )
    if settings.environment == "local" or settings.payments_allow_mock:
        logger.warning("No Lemon Squeezy API key configured — using mock gateway")
        return MockPaymentGateway()
    raise PaymentsNotConfiguredError(
        "Automated payments are not configured in this environment"
    )
