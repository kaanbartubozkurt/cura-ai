"""Payment service for spark pack purchases."""
import logging
import uuid
from datetime import datetime, timedelta
from decimal import Decimal

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.payment import (
    PaymentStatus,
    PaymentTransaction,
    PaymentWebhookEvent,
    SparkPack,
)
from app.models.user import User
from app.services.billing_service import BillingService
from app.services.payment_gateway import get_payment_gateway

logger = logging.getLogger(__name__)

try:
    import sentry_sdk
except ImportError:
    sentry_sdk = None  # type: ignore[assignment]


class FraudCheckError(Exception):
    """Raised when a fraud guardrail is triggered."""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


class PaymentService:
    """Handles spark pack checkout, webhook processing, and refunds."""

    def __init__(self, db: Session, user_id: int | None = None):
        self.db = db
        self.user_id = user_id

    # --- Packs ---

    def list_packs(self) -> list[SparkPack]:
        """List active spark packs sorted by sort_order."""
        return (
            self.db.query(SparkPack)
            .filter(SparkPack.is_active.is_(True))
            .order_by(SparkPack.sort_order)
            .all()
        )

    # --- Checkout ---

    def _check_fraud_guardrails(self, pack: SparkPack) -> None:
        """Raise on new-account cooldown or purchase velocity violations.

        Admin users are exempt from all checks.
        """
        user = self.db.query(User).filter(User.id == self.user_id).first()
        if not user:
            raise ValueError("User not found")

        # Admins are exempt
        if user.role.value == "admin":
            return

        # 2a — New account cooldown: < 24h old + pack > $20
        account_age = datetime.utcnow() - user.created_at
        if account_age < timedelta(hours=24) and pack.price_cents > 2000:
            if sentry_sdk:
                sentry_sdk.capture_message(
                    f"New-account cooldown triggered: user_id={self.user_id} "
                    f"account_age={account_age} pack_price={pack.price_cents}",
                    level="warning",
                )
            raise FraudCheckError(
                "New accounts must wait 24 hours before purchasing packs over $20",
                status_code=403,
            )

        # 2b — Purchase velocity: max 3 transactions in 60 min
        one_hour_ago = datetime.utcnow() - timedelta(hours=1)
        recent_count = (
            self.db.query(func.count(PaymentTransaction.id))
            .filter(
                PaymentTransaction.user_id == self.user_id,
                PaymentTransaction.status.in_([
                    PaymentStatus.PENDING,
                    PaymentStatus.COMPLETED,
                ]),
                PaymentTransaction.created_at >= one_hour_ago,
            )
            .scalar()
        )
        if recent_count >= 3:
            if sentry_sdk:
                sentry_sdk.capture_message(
                    f"Purchase velocity limit hit: user_id={self.user_id} "
                    f"({recent_count} purchases in last 60min)",
                    level="warning",
                )
            raise FraudCheckError(
                "Too many purchases in the last hour. Please try again later.",
                status_code=429,
            )

    async def create_checkout(
        self,
        pack_id: int,
        user_email: str,
        success_url: str,
        cancel_url: str,
        ip_address: str | None = None,
        flow: str = "redirect",
    ) -> dict:
        """Create a checkout session and return the checkout URL (and the provider's order id)."""
        if self.user_id is None:
            raise ValueError("user_id is required for checkout")

        pack = self.db.query(SparkPack).filter(
            SparkPack.id == pack_id, SparkPack.is_active.is_(True)
        ).first()
        if not pack:
            raise ValueError(f"Pack {pack_id} not found or inactive")

        # Fraud guardrails
        self._check_fraud_guardrails(pack)

        gateway = get_payment_gateway()
        purchase_id = uuid.uuid4()

        # Create pending transaction
        txn = PaymentTransaction(
            purchase_id=purchase_id,
            user_id=self.user_id,
            provider=gateway.name,
            amount_cents=pack.price_cents,
            currency=pack.currency,
            pack_id=pack.id,
            status=PaymentStatus.PENDING,
            ip_address=ip_address,
        )
        self.db.add(txn)
        self.db.commit()
        self.db.refresh(txn)

        try:
            extra = {"flow": flow} if gateway.name == self.PAYPAL else {}
            result = await gateway.create_checkout_session(
                pack=pack,
                purchase_id=purchase_id,
                user_id=self.user_id,
                user_email=user_email,
                success_url=success_url,
                cancel_url=cancel_url,
                **extra,
            )
        except Exception:
            # Nothing was charged; don't let the attempt count against the hourly limit.
            txn.status = PaymentStatus.FAILED
            self.db.commit()
            raise

        # Update transaction with session info
        txn.provider_session_id = result.provider_session_id
        self.db.commit()

        # For mock gateway, auto-complete so sparks are credited immediately
        from app.services.payment_gateway import MockPaymentGateway

        if isinstance(gateway, MockPaymentGateway):
            webhook_event = PaymentWebhookEvent(
                provider="mock",
                event_type="order_created",
                provider_event_id=f"mock_evt_{purchase_id.hex[:12]}",
                payload={"data": {"id": f"mock_order_{purchase_id.hex[:8]}"}},
            )
            self.db.add(webhook_event)
            self.db.flush()

            self._handle_order_created(
                data={"data": {"id": f"mock_order_{purchase_id.hex[:8]}"}},
                custom_data={
                    "purchase_id": str(purchase_id),
                    "user_id": str(self.user_id),
                },
                webhook_event=webhook_event,
            )

        return {
            "checkout_url": result.checkout_url,
            "purchase_id": str(purchase_id),
            "order_id": result.provider_session_id,
        }

    # --- Manual PayPal claims (interim flow while LS approval is pending) ---

    MANUAL_PROVIDER = "paypal_manual"

    def get_payment_config(self) -> dict:
        """What purchase flows are available in this environment."""
        from app.core.config import get_settings
        from app.services.payment_gateway import PaymentsNotConfiguredError

        settings = get_settings()
        try:
            provider = get_payment_gateway().name
            automated = True
        except PaymentsNotConfiguredError:
            provider = None
            automated = False

        # The manual paypal.me claim form is only a fallback for when no
        # automated checkout is configured.
        manual = bool(settings.paypal_me_url) and not automated
        paypal = provider == self.PAYPAL
        return {
            "automated": automated,
            "provider": provider,
            # Public by design: PayPal's buttons on our checkout page need it.
            "paypal_client_id": settings.paypal_client_id if paypal else None,
            "manual_enabled": manual,
            "paypal_me_url": settings.paypal_me_url if manual else "",
        }

    def create_manual_claim(
        self,
        pack_id: int,
        payer_reference: str,
        ip_address: str | None = None,
    ) -> dict:
        """Record a user's claim that they paid for a pack via PayPal.

        Creates a PENDING transaction that an admin must approve before any
        sparks are credited. The PayPal transaction ID is stored in
        provider_payment_id (unique), so the same payment can't be claimed
        twice.
        """
        if self.user_id is None:
            raise ValueError("user_id is required")

        from app.core.config import get_settings

        if not get_settings().paypal_me_url:
            raise ValueError("Manual PayPal purchases are not enabled")

        pack = self.db.query(SparkPack).filter(
            SparkPack.id == pack_id, SparkPack.is_active.is_(True)
        ).first()
        if not pack:
            raise ValueError(f"Pack {pack_id} not found or inactive")

        self._check_fraud_guardrails(pack)

        reference = payer_reference.strip()
        if len(reference) < 8:
            raise ValueError("Please provide the full PayPal transaction ID")

        duplicate = self.db.query(PaymentTransaction).filter(
            PaymentTransaction.provider_payment_id == reference
        ).first()
        if duplicate:
            raise ValueError(
                "This PayPal transaction ID has already been submitted"
            )

        txn = PaymentTransaction(
            purchase_id=uuid.uuid4(),
            user_id=self.user_id,
            provider=self.MANUAL_PROVIDER,
            provider_payment_id=reference,
            amount_cents=pack.price_cents,
            currency=pack.currency,
            pack_id=pack.id,
            status=PaymentStatus.PENDING,
            ip_address=ip_address,
        )
        self.db.add(txn)
        self.db.commit()
        self.db.refresh(txn)

        user = self.db.query(User).filter(User.id == self.user_id).first()
        logger.info(
            "Manual PayPal claim submitted: user=%s pack=%s amount=%s ref=%s",
            self.user_id, pack.name, pack.price_cents, reference,
        )
        if sentry_sdk:
            sentry_sdk.capture_message(
                f"Manual PayPal claim awaiting review: {user.email if user else self.user_id} "
                f"paid ${pack.price_cents / 100:.2f} for {pack.name} "
                f"(txn ref {reference}) — approve in Admin → Payments",
                level="warning",
            )

        return {
            "id": txn.id,
            "purchase_id": str(txn.purchase_id),
            "status": txn.status.value,
        }

    def list_manual_claims(
        self, status: str | None = None, skip: int = 0, limit: int = 50
    ) -> dict:
        """List manual PayPal claims with user/pack context (admin)."""
        query = (
            self.db.query(PaymentTransaction)
            .filter(PaymentTransaction.provider == self.MANUAL_PROVIDER)
            .order_by(PaymentTransaction.created_at.desc())
        )
        if status:
            query = query.filter(PaymentTransaction.status == PaymentStatus(status))

        total = query.count()
        items = query.offset(skip).limit(limit).all()

        pending_count = (
            self.db.query(func.count(PaymentTransaction.id))
            .filter(
                PaymentTransaction.provider == self.MANUAL_PROVIDER,
                PaymentTransaction.status == PaymentStatus.PENDING,
            )
            .scalar()
        )

        user_ids = {t.user_id for t in items}
        pack_ids = {t.pack_id for t in items}
        users = {
            u.id: u.email
            for u in self.db.query(User).filter(User.id.in_(user_ids)).all()
        } if user_ids else {}
        packs = {
            p.id: p
            for p in self.db.query(SparkPack).filter(SparkPack.id.in_(pack_ids)).all()
        } if pack_ids else {}

        return {
            "items": [
                {
                    "id": t.id,
                    "user_id": t.user_id,
                    "user_email": users.get(t.user_id, ""),
                    "pack_name": packs[t.pack_id].name if t.pack_id in packs else "Unknown",
                    "sparks_amount": (
                        packs[t.pack_id].sparks_amount + packs[t.pack_id].bonus_sparks
                        if t.pack_id in packs else 0
                    ),
                    "amount_cents": t.amount_cents,
                    "currency": t.currency,
                    "payer_reference": t.provider_payment_id,
                    "status": t.status.value,
                    "created_at": t.created_at.isoformat(),
                    "completed_at": t.completed_at.isoformat() if t.completed_at else None,
                }
                for t in items
            ],
            "total": total,
            "pending_count": pending_count or 0,
        }

    def _get_pending_manual_claim(self, txn_id: int) -> PaymentTransaction:
        txn = self.db.query(PaymentTransaction).filter(
            PaymentTransaction.id == txn_id,
            PaymentTransaction.provider == self.MANUAL_PROVIDER,
        ).first()
        if not txn:
            raise ValueError(f"Manual claim {txn_id} not found")
        if txn.status != PaymentStatus.PENDING:
            raise ValueError(
                f"Claim {txn_id} is {txn.status.value}, not pending"
            )
        return txn

    def approve_manual_claim(self, txn_id: int, admin_id: int) -> dict:
        """Approve a manual claim: credit sparks and mark COMPLETED."""
        txn = self._get_pending_manual_claim(txn_id)

        pack = self.db.query(SparkPack).filter(SparkPack.id == txn.pack_id).first()
        if not pack:
            raise ValueError(f"Pack {txn.pack_id} not found")

        total_sparks = Decimal(pack.sparks_amount + pack.bonus_sparks)
        billing = BillingService(self.db, txn.user_id)
        balance_txn = billing.add_credits(
            amount=total_sparks,
            description=(
                f"Purchased {pack.name} pack via PayPal "
                f"({pack.sparks_amount:,} + {pack.bonus_sparks:,} bonus sparks)"
            ),
            created_by=admin_id,
        )

        txn.status = PaymentStatus.COMPLETED
        txn.balance_txn_id = balance_txn.id
        txn.completed_at = datetime.utcnow()
        self.db.commit()

        logger.info(
            "Manual claim approved: claim=%d user=%d sparks=%s by admin=%d",
            txn_id, txn.user_id, total_sparks, admin_id,
        )
        return {"status": "approved", "sparks_credited": int(total_sparks)}

    def reject_manual_claim(self, txn_id: int, admin_id: int) -> dict:
        """Reject a manual claim: mark FAILED, nothing credited."""
        txn = self._get_pending_manual_claim(txn_id)
        txn.status = PaymentStatus.FAILED
        self.db.commit()

        logger.info(
            "Manual claim rejected: claim=%d user=%d by admin=%d",
            txn_id, txn.user_id, admin_id,
        )
        return {"status": "rejected"}

    # --- Webhook processing ---

    def handle_webhook(
        self, provider: str, payload: bytes, signature: str
    ) -> dict:
        """Process an incoming payment webhook."""
        from app.core.config import get_settings

        settings = get_settings()
        gateway = get_payment_gateway()

        # Verify signature and parse
        data = gateway.verify_webhook(
            payload, signature, settings.lemon_squeezy_webhook_secret
        )

        # Extract event metadata
        event_name = data.get("meta", {}).get("event_name", "unknown")
        custom_data = data.get("meta", {}).get("custom_data", {})
        event_id = str(
            data.get("meta", {}).get("webhook_id")
            or data.get("data", {}).get("id", f"evt_{uuid.uuid4().hex[:12]}")
        )

        # Store raw event (idempotency: skip if already processed)
        existing = self.db.query(PaymentWebhookEvent).filter(
            PaymentWebhookEvent.provider_event_id == event_id
        ).first()
        if existing and existing.processed:
            logger.info("Webhook %s already processed, skipping", event_id)
            return {"status": "already_processed"}

        webhook_event = existing or PaymentWebhookEvent(
            provider=provider,
            event_type=event_name,
            provider_event_id=event_id,
            payload=data,
        )
        if not existing:
            self.db.add(webhook_event)
            self.db.flush()

        # Dispatch by event type
        try:
            if event_name == "order_created":
                self._handle_order_created(data, custom_data, webhook_event)
            elif event_name == "order_refunded":
                self._handle_order_refunded(data, custom_data, webhook_event)
            elif event_name in (
                "subscription_created",
                "subscription_updated",
                "subscription_cancelled",
                "subscription_expired",
                "subscription_payment_success",
                "subscription_payment_failed",
            ):
                self._dispatch_subscription_event(
                    event_name, data, custom_data, webhook_event,
                )
            else:
                logger.info("Unhandled webhook event: %s", event_name)

            webhook_event.processed = True
            self.db.commit()
            return {"status": "processed", "event": event_name}

        except Exception as e:
            webhook_event.processing_error = str(e)
            self.db.commit()
            logger.exception("Webhook processing error for %s", event_id)
            if sentry_sdk:
                sentry_sdk.capture_exception(e)
            raise

    def _handle_order_created(
        self, data: dict, custom_data: dict, webhook_event: PaymentWebhookEvent
    ) -> None:
        """Complete a purchase: PENDING → COMPLETED, credit sparks."""
        purchase_id_str = custom_data.get("purchase_id")
        if not purchase_id_str:
            raise ValueError("Webhook missing purchase_id in custom_data")

        purchase_id = uuid.UUID(purchase_id_str)
        txn = self.db.query(PaymentTransaction).filter(
            PaymentTransaction.purchase_id == purchase_id
        ).first()
        if not txn:
            raise ValueError(f"No transaction found for purchase_id={purchase_id}")

        if txn.status == PaymentStatus.COMPLETED:
            logger.info("Transaction %s already completed", purchase_id)
            return

        # Extract provider payment ID from LS payload
        order_data = data.get("data", {})
        provider_payment_id = str(order_data.get("id", ""))

        # Load the pack to get spark amounts
        pack = self.db.query(SparkPack).filter(SparkPack.id == txn.pack_id).first()
        if not pack:
            raise ValueError(f"Pack {txn.pack_id} not found")

        total_sparks = Decimal(pack.sparks_amount + pack.bonus_sparks)

        # Credit sparks
        billing = BillingService(self.db, txn.user_id)
        balance_txn = billing.add_credits(
            amount=total_sparks,
            description=f"Purchased {pack.name} pack ({pack.sparks_amount:,} + {pack.bonus_sparks:,} bonus sparks)",
        )

        # Update transaction
        txn.status = PaymentStatus.COMPLETED
        txn.provider_payment_id = provider_payment_id
        txn.balance_txn_id = balance_txn.id
        txn.webhook_event_id = webhook_event.id
        txn.completed_at = datetime.utcnow()
        self.db.commit()

        logger.info(
            "Purchase completed: user=%d pack=%s sparks=%s purchase_id=%s",
            txn.user_id, pack.name, total_sparks, purchase_id,
        )

    def _handle_order_refunded(
        self, data: dict, custom_data: dict, webhook_event: PaymentWebhookEvent
    ) -> None:
        """Handle refund: reverse sparks."""
        purchase_id_str = custom_data.get("purchase_id")
        if not purchase_id_str:
            raise ValueError("Webhook missing purchase_id in custom_data")

        purchase_id = uuid.UUID(purchase_id_str)
        txn = self.db.query(PaymentTransaction).filter(
            PaymentTransaction.purchase_id == purchase_id
        ).first()
        if not txn:
            raise ValueError(f"No transaction found for purchase_id={purchase_id}")

        pack = self.db.query(SparkPack).filter(SparkPack.id == txn.pack_id).first()
        if not pack:
            raise ValueError(f"Pack {txn.pack_id} not found")

        total_sparks = Decimal(pack.sparks_amount + pack.bonus_sparks)

        # Reverse credits via adjustment
        from app.models.billing import BalanceTransaction, TransactionType, UserBalance

        balance = (
            self.db.query(UserBalance)
            .filter(UserBalance.user_id == txn.user_id)
            .first()
        )
        if balance:
            balance.balance -= total_sparks
            balance.balance_sparks -= total_sparks
            self.db.flush()

        adjustment = BalanceTransaction(
            user_id=txn.user_id,
            amount=-total_sparks,
            amount_sparks=-total_sparks,
            transaction_type=TransactionType.ADJUSTMENT,
            description=f"Refund: {pack.name} pack",
        )
        self.db.add(adjustment)

        txn.status = PaymentStatus.REFUNDED
        txn.refunded_amount_cents = txn.amount_cents
        txn.webhook_event_id = webhook_event.id
        self.db.commit()

        logger.info(
            "Refund processed: user=%d pack=%s sparks=%s purchase_id=%s",
            txn.user_id, pack.name, total_sparks, purchase_id,
        )

    def _dispatch_subscription_event(
        self,
        event_name: str,
        data: dict,
        custom_data: dict,
        webhook_event: PaymentWebhookEvent,
    ) -> None:
        """Route subscription webhooks to SubscriptionService."""
        from app.services.subscription_service import SubscriptionService

        sub_svc = SubscriptionService(self.db)

        if event_name == "subscription_created":
            sub_svc.handle_subscription_created(data, custom_data, webhook_event)
        elif event_name == "subscription_updated":
            sub_svc.handle_subscription_updated(data, webhook_event)
        elif event_name == "subscription_cancelled":
            sub_svc.handle_subscription_cancelled(data, webhook_event)
        elif event_name == "subscription_expired":
            sub_svc.handle_subscription_expired(data, webhook_event)
        elif event_name == "subscription_payment_success":
            sub_svc.handle_subscription_payment_success(data, webhook_event)
        elif event_name == "subscription_payment_failed":
            sub_svc.handle_subscription_payment_failed(data, webhook_event)

    # --- PayPal Checkout (#167) ---

    PAYPAL = "paypal"
    # Capture failures where the buyer can simply try again with another card or account.
    DECLINED_ERRORS = {"INSTRUMENT_DECLINED", "TRANSACTION_REFUSED", "PAYER_ACTION_REQUIRED",
                       "PAYER_CANNOT_PAY", "MAX_NUMBER_OF_PAYMENT_ATTEMPTS_EXCEEDED"}

    def _paypal_gateway(self):
        from app.services.payment_gateway import PayPalGateway

        gateway = get_payment_gateway()
        if not isinstance(gateway, PayPalGateway):
            raise ValueError("PayPal checkout is not configured")
        return gateway

    def _pack_sparks(self, txn: PaymentTransaction) -> tuple[SparkPack, Decimal]:
        pack = self.db.query(SparkPack).filter(SparkPack.id == txn.pack_id).first()
        if not pack:
            raise ValueError(f"Pack {txn.pack_id} not found")
        return pack, Decimal(pack.sparks_amount + pack.bonus_sparks)

    def _locked(self, txn: PaymentTransaction) -> PaymentTransaction:
        """Re-read a purchase under a row lock so concurrent completions run one at a time."""
        return (
            self.db.query(PaymentTransaction)
            .filter(PaymentTransaction.id == txn.id)
            .with_for_update()
            .populate_existing()
            .one()
        )

    def _outcome(self, txn: PaymentTransaction, status: str | None = None, **extra) -> dict:
        pack = self.db.query(SparkPack).filter(SparkPack.id == txn.pack_id).first()
        return {
            "status": status or txn.status.value,
            "purchase_id": str(txn.purchase_id),
            "pack_name": pack.name if pack else "Unknown",
            "sparks": (pack.sparks_amount + pack.bonus_sparks) if pack else 0,
            "amount_cents": txn.amount_cents,
            "currency": txn.currency,
            "payment_reference": txn.provider_payment_id,
            **extra,
        }

    def _complete_purchase(
        self,
        txn: PaymentTransaction,
        provider_payment_id: str,
        webhook_event: PaymentWebhookEvent | None = None,
        fee_cents: int | None = None,
    ) -> bool:
        """Credit the pack's sparks exactly once. Returns False if it was already credited.

        The row lock serializes the buyer's return and PayPal's notification;
        the status is set in the same commit as the credit, so the second one
        always sees COMPLETED.
        """
        txn = self._locked(txn)
        if txn.status in (PaymentStatus.COMPLETED, PaymentStatus.REFUNDED, PaymentStatus.DISPUTED):
            self.db.commit()
            return False
        pack, total_sparks = self._pack_sparks(txn)

        txn.status = PaymentStatus.COMPLETED
        txn.provider_payment_id = provider_payment_id
        txn.completed_at = datetime.utcnow()
        if webhook_event is not None:
            txn.webhook_event_id = webhook_event.id
        balance_txn = BillingService(self.db, txn.user_id).add_credits(
            amount=total_sparks,
            description=f"Purchased {pack.name} pack ({pack.sparks_amount:,} + {pack.bonus_sparks:,} bonus sparks)",
        )
        txn.balance_txn_id = balance_txn.id
        self.db.commit()

        logger.info("Purchase completed: user=%d pack=%s sparks=%s purchase_id=%s provider=%s",
                    txn.user_id, pack.name, total_sparks, txn.purchase_id, txn.provider)
        fee = f", PayPal fee ${fee_cents / 100:.2f}" if fee_cents is not None else ""
        self._alert(f"💸 New purchase: {pack.name} pack, ${txn.amount_cents / 100:.2f} "
                    f"(user #{txn.user_id}{fee}). {int(total_sparks):,} sparks credited.")
        return True

    def _alert(self, message: str) -> None:
        from app.core.config import get_settings
        from app.services.discord_alerts import send_alert

        try:
            send_alert(message, get_settings())
        except Exception:
            logger.warning("Payment Discord alert failed", exc_info=True)

    @staticmethod
    def _first_capture(order: dict) -> dict | None:
        for unit in order.get("purchase_units") or []:
            captures = (unit.get("payments") or {}).get("captures") or []
            if captures:
                return captures[0]
        return None

    def _apply_capture(
        self, txn: PaymentTransaction, capture: dict | None,
        webhook_event: PaymentWebhookEvent | None = None,
    ) -> dict:
        """Act on a PayPal capture: credit, wait, or mark failed."""
        from app.services.payment_gateway import value_to_cents

        if capture is None:
            return self._outcome(txn, "pending")
        status = capture.get("status")
        if status in ("COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"):
            amount = capture.get("amount") or {}
            paid = value_to_cents(amount.get("value"))
            if paid != txn.amount_cents or (amount.get("currency_code") or txn.currency) != txn.currency:
                msg = (f"PayPal capture {capture.get('id')} for purchase {txn.purchase_id} is "
                       f"{amount.get('value')} {amount.get('currency_code')}, expected "
                       f"{txn.amount_cents / 100:.2f} {txn.currency}; no sparks credited")
                logger.error(msg)
                self._alert(f"⚠️ {msg}. Check it in PayPal.")
                raise ValueError("Payment amount does not match the pack price")
            breakdown = capture.get("seller_receivable_breakdown") or {}
            fee = (breakdown.get("paypal_fee") or {}).get("value")
            self._complete_purchase(txn, capture["id"], webhook_event,
                                    fee_cents=value_to_cents(fee) if fee else None)
            return self._outcome(self._locked(txn))
        if status == "PENDING":
            reason = (capture.get("status_details") or {}).get("reason")
            logger.info("PayPal capture pending: purchase=%s reason=%s", txn.purchase_id, reason)
            return self._outcome(txn, "pending", reason=reason)
        # DECLINED or FAILED: nothing was charged.
        txn = self._locked(txn)
        if txn.status == PaymentStatus.PENDING:
            txn.status = PaymentStatus.FAILED
        self.db.commit()
        return self._outcome(txn, "declined")

    def _paypal_txn_for_order(self, order_id: str) -> PaymentTransaction:
        query = self.db.query(PaymentTransaction).filter(
            PaymentTransaction.provider == self.PAYPAL,
            PaymentTransaction.provider_session_id == order_id,
        )
        if self.user_id is not None:
            query = query.filter(PaymentTransaction.user_id == self.user_id)
        txn = query.first()
        if not txn:
            raise ValueError("We couldn't find this PayPal payment on your account. If you paid, your sparks "
                             "will be added automatically within a few minutes.")
        return txn

    async def capture_paypal_order(self, order_id: str) -> dict:
        """The buyer is back from PayPal: capture the order and credit the sparks."""
        from app.services.payment_gateway import PayPalError

        txn = self._paypal_txn_for_order(order_id)
        if txn.status in (PaymentStatus.COMPLETED, PaymentStatus.REFUNDED, PaymentStatus.DISPUTED):
            return self._outcome(txn)
        gateway = self._paypal_gateway()
        try:
            order = await gateway.capture_order(order_id)
        except PayPalError as e:
            if e.name in self.DECLINED_ERRORS:
                return self._apply_capture(txn, {"status": "DECLINED"})
            if e.name == "ORDER_NOT_APPROVED":
                return self._outcome(txn, "not_approved")
            raise
        return self._apply_capture(txn, self._first_capture(order))

    def cancel_paypal_order(self, order_id: str) -> dict:
        """The buyer cancelled on PayPal. Nothing was charged; free up their attempt."""
        txn = self._locked(self._paypal_txn_for_order(order_id))
        if txn.status == PaymentStatus.PENDING:
            txn.status = PaymentStatus.EXPIRED
        self.db.commit()
        return self._outcome(txn, "cancelled" if txn.status == PaymentStatus.EXPIRED else None)

    def _reverse_to_refunded_total(
        self, txn: PaymentTransaction, refunded_total_cents: int, final_status: PaymentStatus,
        reason: str,
    ) -> int:
        """Take back the sparks for money PayPal returned, up to ``refunded_total_cents`` in all.

        Driven by PayPal's running total, so the admin refund call and the
        refund notification can both arrive without reversing twice. The
        balance may go negative (sparks already spent); new jobs then need a
        top-up first. Returns the sparks removed now.
        """
        from app.models.billing import BalanceTransaction, TransactionType, UserBalance

        txn = self._locked(txn)
        already = txn.refunded_amount_cents or 0
        refunded_total_cents = min(refunded_total_cents, txn.amount_cents)
        if refunded_total_cents <= already:
            self.db.commit()
            return 0
        pack, total_sparks = self._pack_sparks(txn)

        def reversed_for(cents: int) -> Decimal:
            if cents >= txn.amount_cents:
                return total_sparks
            return (total_sparks * cents / txn.amount_cents).quantize(Decimal("1"))

        sparks = reversed_for(refunded_total_cents) - reversed_for(already)
        balance = self.db.query(UserBalance).filter(UserBalance.user_id == txn.user_id).first()
        if balance:
            balance.balance -= sparks
            balance.balance_sparks -= sparks
        self.db.add(BalanceTransaction(
            user_id=txn.user_id,
            amount=-sparks,
            amount_sparks=-sparks,
            transaction_type=TransactionType.ADJUSTMENT,
            description=f"{reason}: {pack.name} pack",
        ))
        txn.refunded_amount_cents = refunded_total_cents
        if refunded_total_cents >= txn.amount_cents:
            txn.status = final_status
        self.db.commit()

        left = balance.balance_sparks if balance else Decimal(0)
        logger.info("%s: user=%d pack=%s sparks=-%s refunded_total=%d", reason, txn.user_id, pack.name,
                    sparks, refunded_total_cents)
        self._alert(f"↩️ {reason}: {pack.name} pack, ${refunded_total_cents / 100:.2f} of "
                    f"${txn.amount_cents / 100:.2f} (user #{txn.user_id}). {int(sparks):,} sparks removed"
                    + (f"; balance is now {left:,.0f} sparks." if left < 0 else "."))
        return int(sparks)

    @staticmethod
    def _trim_paypal_event(event: dict) -> dict:
        """What we keep of a PayPal notification: ids, statuses and amounts, no payer details."""
        resource = event.get("resource") or {}
        keep = {k: resource.get(k) for k in ("id", "status", "custom_id", "invoice_id", "amount",
                                              "seller_receivable_breakdown", "seller_payable_breakdown",
                                              "status_details", "intent") if k in resource}
        units = resource.get("purchase_units")
        if units:
            keep["purchase_units"] = [{"custom_id": u.get("custom_id"), "amount": u.get("amount")} for u in units]
        links = [link for link in resource.get("links") or [] if link.get("rel") == "up"]
        if links:
            keep["links"] = links
        return {"id": event.get("id"), "event_type": event.get("event_type"),
                "resource_type": event.get("resource_type"), "create_time": event.get("create_time"),
                "resource": keep}

    def _paypal_txn_by_purchase(self, purchase_id: str | None) -> PaymentTransaction | None:
        if not purchase_id:
            return None
        try:
            key = uuid.UUID(purchase_id)
        except ValueError:
            return None
        return self.db.query(PaymentTransaction).filter(PaymentTransaction.purchase_id == key).first()

    @staticmethod
    def _capture_id_from_links(resource: dict) -> str | None:
        for link in resource.get("links") or []:
            if link.get("rel") == "up" and "/captures/" in link.get("href", ""):
                return link["href"].rstrip("/").rsplit("/", 1)[-1]
        return None

    async def handle_paypal_webhook(self, payload: bytes, headers) -> dict:
        """A notification from PayPal: verify it with PayPal, then act on it once."""
        from app.services.payment_gateway import value_to_cents

        gateway = self._paypal_gateway()
        event = await gateway.verify_notification(payload, headers)
        event_id = str(event.get("id") or "")
        event_type = event.get("event_type", "unknown")
        if not event_id:
            raise ValueError("PayPal event has no id")

        existing = self.db.query(PaymentWebhookEvent).filter(
            PaymentWebhookEvent.provider_event_id == event_id
        ).first()
        if existing and existing.processed:
            return {"status": "already_processed"}
        webhook_event = existing or PaymentWebhookEvent(
            provider=self.PAYPAL, event_type=event_type, provider_event_id=event_id,
            payload=self._trim_paypal_event(event),
        )
        if not existing:
            # Committed first, so a processing error below can still be recorded on it.
            self.db.add(webhook_event)
            self.db.commit()

        resource = event.get("resource") or {}
        try:
            if event_type == "CHECKOUT.ORDER.APPROVED":
                # The buyer approved but may never come back to SightLab: capture it ourselves.
                units = resource.get("purchase_units") or [{}]
                txn = self._paypal_txn_by_purchase(units[0].get("custom_id"))
                if txn and txn.status in (PaymentStatus.PENDING, PaymentStatus.EXPIRED):
                    from app.services.payment_gateway import PayPalError

                    try:
                        order = await gateway.capture_order(resource["id"])
                        self._apply_capture(txn, self._first_capture(order), webhook_event)
                    except PayPalError as e:
                        if e.name not in self.DECLINED_ERRORS:
                            raise
                        self._apply_capture(txn, {"status": "DECLINED"}, webhook_event)
            elif event_type == "PAYMENT.CAPTURE.COMPLETED":
                txn = self._paypal_txn_by_purchase(resource.get("custom_id"))
                if txn:
                    self._apply_capture(txn, resource, webhook_event)
            elif event_type in ("PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.DECLINED"):
                txn = self._paypal_txn_by_purchase(resource.get("custom_id"))
                if txn:
                    self._apply_capture(txn, {"status": "DECLINED"}, webhook_event)
            elif event_type in ("PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED"):
                capture_id = self._capture_id_from_links(resource)
                txn = self.db.query(PaymentTransaction).filter(
                    PaymentTransaction.provider_payment_id == capture_id
                ).first() if capture_id else self._paypal_txn_by_purchase(resource.get("custom_id"))
                if txn:
                    total = ((resource.get("seller_payable_breakdown") or {}).get("total_refunded_amount")
                             or resource.get("amount") or {}).get("value")
                    reversal = event_type.endswith("REVERSED")
                    self._reverse_to_refunded_total(
                        txn, value_to_cents(total),
                        PaymentStatus.DISPUTED if reversal else PaymentStatus.REFUNDED,
                        "PayPal reversal (dispute or chargeback)" if reversal else "Refund",
                    )
            else:
                logger.info("Unhandled PayPal event: %s", event_type)

            stored = self.db.query(PaymentWebhookEvent).filter(
                PaymentWebhookEvent.provider_event_id == event_id).one()
            stored.processed = True
            stored.processing_error = None
            self.db.commit()
            return {"status": "processed", "event": event_type}
        except Exception as e:
            self.db.rollback()
            stored = self.db.query(PaymentWebhookEvent).filter(
                PaymentWebhookEvent.provider_event_id == event_id).one()
            stored.processing_error = str(e)[:2000]
            self.db.commit()
            logger.exception("PayPal webhook processing error for %s (%s)", event_id, event_type)
            if sentry_sdk:
                sentry_sdk.capture_exception(e)
            raise

    # --- Purchase history ---

    def get_purchases(self, skip: int = 0, limit: int = 50) -> dict:
        """Get paginated purchase history for current user."""
        if self.user_id is None:
            raise ValueError("user_id is required")

        query = (
            self.db.query(PaymentTransaction)
            .filter(PaymentTransaction.user_id == self.user_id)
            .order_by(PaymentTransaction.created_at.desc())
        )
        total = query.count()
        items = query.offset(skip).limit(limit).all()

        # Enrich with pack names
        pack_ids = {t.pack_id for t in items}
        packs = {
            p.id: p
            for p in self.db.query(SparkPack).filter(SparkPack.id.in_(pack_ids)).all()
        }

        return {
            "items": [
                {
                    "id": t.id,
                    "purchase_id": str(t.purchase_id),
                    "pack_name": packs[t.pack_id].name if t.pack_id in packs else "Unknown",
                    "sparks_amount": (
                        packs[t.pack_id].sparks_amount + packs[t.pack_id].bonus_sparks
                        if t.pack_id in packs
                        else 0
                    ),
                    "amount_cents": t.amount_cents,
                    "refunded_amount_cents": t.refunded_amount_cents or 0,
                    "currency": t.currency,
                    "provider": t.provider,
                    "payment_reference": t.provider_payment_id if t.status != PaymentStatus.PENDING else None,
                    "status": t.status.value,
                    "created_at": t.created_at.isoformat(),
                    "completed_at": t.completed_at.isoformat() if t.completed_at else None,
                }
                for t in items
            ],
            "total": total,
        }

    # --- Admin ---

    def get_all_purchases(self, skip: int = 0, limit: int = 50) -> dict:
        """Get all purchases (admin)."""
        from app.models.user import User

        query = (
            self.db.query(PaymentTransaction)
            .order_by(PaymentTransaction.created_at.desc())
        )
        total = query.count()
        items = query.offset(skip).limit(limit).all()

        # Get user emails and pack names
        user_ids = {t.user_id for t in items}
        pack_ids = {t.pack_id for t in items}
        users = {
            u.id: u.email
            for u in self.db.query(User).filter(User.id.in_(user_ids)).all()
        }
        packs = {
            p.id: p
            for p in self.db.query(SparkPack).filter(SparkPack.id.in_(pack_ids)).all()
        }

        return {
            "items": [
                {
                    "id": t.id,
                    "purchase_id": str(t.purchase_id),
                    "user_id": t.user_id,
                    "user_email": users.get(t.user_id, ""),
                    "pack_name": packs[t.pack_id].name if t.pack_id in packs else "Unknown",
                    "sparks_amount": (
                        packs[t.pack_id].sparks_amount + packs[t.pack_id].bonus_sparks
                        if t.pack_id in packs else 0
                    ),
                    "amount_cents": t.amount_cents,
                    "refunded_amount_cents": t.refunded_amount_cents or 0,
                    "currency": t.currency,
                    "provider": t.provider,
                    "payment_reference": t.provider_payment_id,
                    "refundable": t.status == PaymentStatus.COMPLETED and t.provider == "paypal"
                    and bool(t.provider_payment_id),
                    "status": t.status.value,
                    "created_at": t.created_at.isoformat(),
                    "completed_at": t.completed_at.isoformat() if t.completed_at else None,
                }
                for t in items
            ],
            "total": total,
        }

    def get_webhook_events(self, skip: int = 0, limit: int = 50) -> dict:
        """Get raw webhook events (admin)."""
        query = (
            self.db.query(PaymentWebhookEvent)
            .order_by(PaymentWebhookEvent.created_at.desc())
        )
        total = query.count()
        items = query.offset(skip).limit(limit).all()

        return {
            "items": [
                {
                    "id": e.id,
                    "provider": e.provider,
                    "event_type": e.event_type,
                    "provider_event_id": e.provider_event_id,
                    "processed": e.processed,
                    "processing_error": e.processing_error,
                    "created_at": e.created_at.isoformat(),
                }
                for e in items
            ],
            "total": total,
        }

    async def create_refund(self, payment_id: int) -> dict:
        """Issue a refund for a payment (admin)."""
        txn = self.db.query(PaymentTransaction).filter(
            PaymentTransaction.id == payment_id
        ).first()
        if not txn:
            raise ValueError(f"Payment {payment_id} not found")
        if txn.status != PaymentStatus.COMPLETED:
            raise ValueError(f"Cannot refund payment in status {txn.status.value}")
        if not txn.provider_payment_id:
            raise ValueError("No provider payment ID — cannot refund")

        gateway = get_payment_gateway()
        if txn.provider == self.PAYPAL:
            result = await gateway.create_refund(txn.provider_payment_id, None)
            if not result.success:
                raise ValueError(f"Refund failed: {result.error}")
            # Take the sparks back now; the REFUNDED notification that follows
            # sees the same running total and changes nothing.
            removed = self._reverse_to_refunded_total(txn, txn.amount_cents, PaymentStatus.REFUNDED,
                                                      "Refund")
            return {"status": "refunded", "payment_id": payment_id, "sparks_removed": removed}

        result = await gateway.create_refund(txn.provider_payment_id, txn.amount_cents)
        if not result.success:
            raise ValueError(f"Refund failed: {result.error}")

        # The actual balance reversal happens via the order_refunded webhook.
        # But for mock gateway, apply immediately.
        from app.services.payment_gateway import MockPaymentGateway

        if isinstance(gateway, MockPaymentGateway):
            pack = self.db.query(SparkPack).filter(SparkPack.id == txn.pack_id).first()
            if pack:
                total_sparks = Decimal(pack.sparks_amount + pack.bonus_sparks)
                from app.models.billing import (
                    BalanceTransaction,
                    TransactionType,
                    UserBalance,
                )

                balance = (
                    self.db.query(UserBalance)
                    .filter(UserBalance.user_id == txn.user_id)
                    .first()
                )
                if balance:
                    balance.balance -= total_sparks
                    balance.balance_sparks -= total_sparks
                    self.db.flush()

                adj = BalanceTransaction(
                    user_id=txn.user_id,
                    amount=-total_sparks,
                    amount_sparks=-total_sparks,
                    transaction_type=TransactionType.ADJUSTMENT,
                    description=f"Refund: {pack.name} pack (admin)",
                )
                self.db.add(adj)

            txn.status = PaymentStatus.REFUNDED
            txn.refunded_amount_cents = txn.amount_cents
            self.db.commit()

        return {"status": "refunded", "payment_id": payment_id}

    # --- Reconciliation ---

    def reconcile_stale_transactions(self) -> dict:
        """Expire PENDING transactions older than 24h. Returns summary.

        Manual PayPal claims are excluded — they stay PENDING until an admin
        approves or rejects them.
        """
        cutoff = datetime.utcnow() - timedelta(hours=24)
        stale = (
            self.db.query(PaymentTransaction)
            .filter(
                PaymentTransaction.status == PaymentStatus.PENDING,
                PaymentTransaction.provider != self.MANUAL_PROVIDER,
                PaymentTransaction.created_at < cutoff,
            )
            .all()
        )

        expired_count = 0
        for txn in stale:
            txn.status = PaymentStatus.EXPIRED
            expired_count += 1

        if expired_count > 0:
            self.db.commit()
            logger.warning("Expired %d stale PENDING transactions", expired_count)
            if sentry_sdk:
                sentry_sdk.capture_message(
                    f"Payment reconciliation: expired {expired_count} stale "
                    f"PENDING transaction(s) older than 24h",
                    level="warning",
                )
        else:
            logger.info("Payment reconciliation: no stale transactions found")

        return {"expired": expired_count}

    # --- Admin analytics ---

    def get_margins(
        self, start_date: datetime | None = None, end_date: datetime | None = None
    ) -> dict:
        """Compute revenue vs COGS margins for completed payments."""
        from app.models.billing import UsageRecord

        query = self.db.query(PaymentTransaction).filter(
            PaymentTransaction.status == PaymentStatus.COMPLETED,
        )
        if start_date:
            query = query.filter(PaymentTransaction.completed_at >= start_date)
        if end_date:
            query = query.filter(PaymentTransaction.completed_at <= end_date)

        completed = query.all()

        # Aggregate revenue by user
        user_revenue: dict[int, int] = {}
        for txn in completed:
            user_revenue[txn.user_id] = user_revenue.get(txn.user_id, 0) + txn.amount_cents

        total_revenue_cents = sum(user_revenue.values())

        # Aggregate COGS (raw provider costs) by user
        usage_query = self.db.query(
            UsageRecord.user_id,
            func.sum(UsageRecord.raw_cost).label("total_raw_cost"),
        ).group_by(UsageRecord.user_id)
        if start_date:
            usage_query = usage_query.filter(UsageRecord.created_at >= start_date)
        if end_date:
            usage_query = usage_query.filter(UsageRecord.created_at <= end_date)

        user_cogs: dict[int, float] = {}
        for row in usage_query.all():
            user_cogs[row.user_id] = float(row.total_raw_cost or 0)

        # Convert COGS from dollars to cents for comparison
        total_cogs_cents = int(sum(user_cogs.values()) * 100)

        # Build per-user breakdown
        all_user_ids = set(user_revenue.keys()) | set(user_cogs.keys())
        users_map = {}
        if all_user_ids:
            users_map = {
                u.id: u.email
                for u in self.db.query(User).filter(User.id.in_(all_user_ids)).all()
            }

        by_user = []
        for uid in all_user_ids:
            rev = user_revenue.get(uid, 0)
            cogs_dollars = user_cogs.get(uid, 0)
            cogs_cents = int(cogs_dollars * 100)
            margin_ratio = rev / cogs_cents if cogs_cents > 0 else None
            status = "ok"
            if margin_ratio is not None:
                if margin_ratio < 1.3:
                    status = "critical"
                elif margin_ratio < 1.5:
                    status = "warning"

            by_user.append({
                "user_id": uid,
                "email": users_map.get(uid, ""),
                "revenue_cents": rev,
                "cogs_cents": cogs_cents,
                "margin_ratio": round(margin_ratio, 2) if margin_ratio else None,
                "status": status,
            })

        blended_margin = (
            round(total_revenue_cents / total_cogs_cents, 2)
            if total_cogs_cents > 0
            else None
        )

        return {
            "total_revenue_cents": total_revenue_cents,
            "total_cogs_cents": total_cogs_cents,
            "blended_margin": blended_margin,
            "by_user": sorted(by_user, key=lambda x: x["revenue_cents"], reverse=True),
        }

    def get_abandoned_checkouts(
        self,
        skip: int = 0,
        limit: int = 50,
        start_date: datetime | None = None,
        end_date: datetime | None = None,
    ) -> dict:
        """Get abandoned/expired checkout analytics."""
        # Abandoned items
        query = (
            self.db.query(PaymentTransaction)
            .filter(
                PaymentTransaction.status.in_([
                    PaymentStatus.PENDING,
                    PaymentStatus.EXPIRED,
                ])
            )
            .order_by(PaymentTransaction.created_at.desc())
        )
        if start_date:
            query = query.filter(PaymentTransaction.created_at >= start_date)
        if end_date:
            query = query.filter(PaymentTransaction.created_at <= end_date)

        total = query.count()
        items = query.offset(skip).limit(limit).all()

        # Enrich with user emails and pack names
        user_ids = {t.user_id for t in items}
        pack_ids = {t.pack_id for t in items}
        users_map = {
            u.id: u.email
            for u in self.db.query(User).filter(User.id.in_(user_ids)).all()
        } if user_ids else {}
        packs_map = {
            p.id: p.name
            for p in self.db.query(SparkPack).filter(SparkPack.id.in_(pack_ids)).all()
        } if pack_ids else {}

        # Conversion rate over the period
        status_filter = []
        if start_date:
            status_filter.append(PaymentTransaction.created_at >= start_date)
        if end_date:
            status_filter.append(PaymentTransaction.created_at <= end_date)

        completed_count = (
            self.db.query(func.count(PaymentTransaction.id))
            .filter(
                PaymentTransaction.status == PaymentStatus.COMPLETED,
                *status_filter,
            )
            .scalar()
        )
        total_attempts = (
            self.db.query(func.count(PaymentTransaction.id))
            .filter(
                PaymentTransaction.status.in_([
                    PaymentStatus.COMPLETED,
                    PaymentStatus.PENDING,
                    PaymentStatus.EXPIRED,
                ]),
                *status_filter,
            )
            .scalar()
        )
        conversion_rate = (
            round(completed_count / total_attempts, 3)
            if total_attempts > 0
            else None
        )

        return {
            "items": [
                {
                    "user_email": users_map.get(t.user_id, ""),
                    "pack_name": packs_map.get(t.pack_id, "Unknown"),
                    "amount_cents": t.amount_cents,
                    "status": t.status.value,
                    "created_at": t.created_at.isoformat(),
                }
                for t in items
            ],
            "total": total,
            "conversion_rate": conversion_rate,
        }
