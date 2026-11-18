'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ArrowLeft, CheckCircle2, Clock, Loader2, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { billingApi } from '@/lib/api';
import { loadPayPal, type PayPalButtonsInstance } from '@/lib/paypal';
import { cn } from '@/lib/utils';
import type { PayPalOutcome, SparkPack } from '@/types';

type Method = 'paypal' | 'card';
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const price = (cents: number, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
const detail = (err: unknown) => (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;

/** Review the order, pick PayPal or card, pay with PayPal's own buttons, see the receipt. */
export default function CheckoutPage() {
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const { data: packs } = useQuery({ queryKey: ['billing', 'packs'], queryFn: billingApi.getPacks });
  const { data: balance } = useQuery({ queryKey: ['billing', 'balance'], queryFn: billingApi.getBalance });
  const { data: config } = useQuery({ queryKey: ['billing', 'payment-config'], queryFn: billingApi.getPaymentConfig });

  const [packId, setPackId] = useState<number | null>(null);
  const [method, setMethod] = useState<Method>('paypal');
  const [outcome, setOutcome] = useState<PayPalOutcome | null>(null);
  const [paying, setPaying] = useState(false);
  const [buttonsError, setButtonsError] = useState<string | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const packRef = useRef<number | null>(null);

  useEffect(() => {
    if (!packs?.length || packId !== null) return;
    const wanted = Number(params.get('pack'));
    const chosen = packs.find((p) => p.id === wanted) ?? packs.find((p) => p.is_featured) ?? packs[0];
    setPackId(chosen.id);
  }, [packs, params, packId]);
  packRef.current = packId;
  const pack = packs?.find((p) => p.id === packId);

  // PayPal's button for the chosen method. The order is created when it's clicked,
  // so changing the pack doesn't need a new button.
  useEffect(() => {
    const clientId = config?.paypal_client_id;
    if (!clientId || !container.current || outcome) return;
    let buttons: PayPalButtonsInstance | null = null;
    let active = true;
    setButtonsError(null);
    loadPayPal(clientId).then((paypal) => {
      if (!active || !container.current) return;
      container.current.innerHTML = '';
      buttons = paypal.Buttons({
        fundingSource: method === 'card' ? paypal.FUNDING.CARD : paypal.FUNDING.PAYPAL,
        style: { layout: 'vertical', shape: 'rect', height: 48, label: 'pay' },
        createOrder: async () => {
          try {
            const origin = window.location.origin;
            const result = await billingApi.createCheckout(packRef.current!, `${origin}/billing`, `${origin}/billing`, 'sdk');
            return result.order_id!;
          } catch (err) {
            toast.error(detail(err) || 'Could not start the payment. Please try again.');
            throw err;
          }
        },
        onApprove: async ({ orderID }) => {
          setPaying(true);
          try {
            const result = await billingApi.capturePayPal(orderID);
            setOutcome(result);
            for (const key of ['balance', 'transactions', 'purchases']) {
              queryClient.invalidateQueries({ queryKey: ['billing', key] });
            }
          } catch (err) {
            toast.error(detail(err) || 'We could not confirm the payment yet. If you paid, your sparks will be added within a few minutes.');
          } finally {
            setPaying(false);
          }
        },
        onCancel: ({ orderID }) => {
          if (orderID) billingApi.cancelPayPal(orderID).catch(() => {});
          toast('Payment cancelled. Nothing was charged.');
        },
        onError: () => toast.error('PayPal had a problem with this payment. Nothing was charged; please try again.'),
      });
      if (!buttons.isEligible()) {
        setButtonsError(method === 'card'
          ? 'Card payments are not available here yet. Please use PayPal.'
          : 'PayPal is not available right now.');
        return;
      }
      buttons.render(container.current).catch(() => active && setButtonsError('PayPal did not load. Please refresh the page.'));
    }).catch(() => active && setButtonsError('PayPal did not load. Check your connection or ad blocker and refresh.'));
    return () => {
      active = false;
      buttons?.close().catch(() => {});
    };
  }, [config?.paypal_client_id, method, outcome, queryClient]);

  if (outcome) return <Result outcome={outcome} balance={balance?.available} onRetry={() => setOutcome(null)} />;

  const automatedPayPal = config && config.provider === 'paypal' && config.paypal_client_id;
  return (
    <div className="mx-auto w-full max-w-[920px] space-y-5">
      <div>
        <Link href="/billing" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Billing
        </Link>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">Checkout</h1>
      </div>

      <div className="flex flex-col gap-5 md:flex-row md:items-start">
        <section aria-labelledby="order" className="flex-1 space-y-4 rounded-lg border border-border p-5">
          <h2 id="order" className="text-sm font-semibold">Your order</h2>
          <fieldset className="space-y-2">
            <legend className="mb-2 text-xs text-muted-foreground">Spark pack</legend>
            {(packs ?? []).map((p: SparkPack) => (
              <label
                key={p.id}
                className={cn(
                  'flex min-h-[52px] cursor-pointer items-center gap-3 rounded-md border px-3 py-2',
                  p.id === packId ? 'border-selection bg-selection-soft' : 'border-border hover:bg-accent',
                )}
              >
                <input type="radio" name="pack" checked={p.id === packId} onChange={() => setPackId(p.id)} className="h-4 w-4 accent-[hsl(var(--selection))]" />
                <span className="flex-1">
                  <span className="block font-medium">{p.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {fmt(p.sparks_amount + p.bonus_sparks)} sparks{p.bonus_sparks > 0 && ` (incl. ${fmt(p.bonus_sparks)} bonus)`}
                  </span>
                </span>
                <span className="font-mono">{price(p.price_cents, p.currency)}</span>
              </label>
            ))}
          </fieldset>
          {pack && (
            <>
              <div className="space-y-1.5 border-t border-border pt-3 text-sm">
                <div className="flex justify-between"><span>Sparks</span><span className="font-mono">{fmt(pack.sparks_amount)}</span></div>
                {pack.bonus_sparks > 0 && <div className="flex justify-between text-selection"><span>Bonus</span><span className="font-mono">+{fmt(pack.bonus_sparks)}</span></div>}
                <div className="flex justify-between pt-1 text-base font-semibold"><span>Total</span><span className="font-mono">{price(pack.price_cents, pack.currency)} {pack.currency}</span></div>
              </div>
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                <li>One-time payment, no subscription. Sparks never expire.</li>
                <li>Use them on any model; you see the cost before each run.</li>
                {balance && <li>Your balance after: <span className="font-mono text-foreground">{fmt(balance.available + pack.sparks_amount + pack.bonus_sparks)}</span> sparks.</li>}
              </ul>
            </>
          )}
        </section>

        <section aria-labelledby="pay" className="flex-1 space-y-4 rounded-lg border border-border p-5">
          <h2 id="pay" className="text-sm font-semibold">Payment</h2>
          {!config ? (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          ) : !automatedPayPal ? (
            <p className="text-sm text-muted-foreground">Online payments aren&apos;t available yet. Please check back soon.</p>
          ) : (
            <>
              <div role="radiogroup" aria-label="Payment method" className="space-y-2">
                {([
                  ['paypal', 'PayPal', 'Log in to PayPal and pay with your balance, bank or saved card'],
                  ['card', 'Debit or credit card', 'No PayPal account needed'],
                ] as const).map(([value, label, hint]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={method === value}
                    onClick={() => setMethod(value)}
                    className={cn(
                      'flex min-h-14 w-full flex-col items-start rounded-md border px-3 py-2 text-left',
                      method === value ? 'border-selection bg-selection-soft' : 'border-border hover:bg-accent',
                    )}
                  >
                    <span className="font-medium">{label}</span>
                    <span className="text-xs text-muted-foreground">{hint}</span>
                  </button>
                ))}
              </div>
              {pack && (
                <p className="text-sm">
                  Pay <span className="font-mono font-semibold">{price(pack.price_cents, pack.currency)}</span> for {fmt(pack.sparks_amount + pack.bonus_sparks)} sparks:
                </p>
              )}
              {paying && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Confirming your payment…</p>
              )}
              {buttonsError && <p className="text-sm text-danger">{buttonsError}</p>}
              <div ref={container} className={cn('min-h-[56px]', paying && 'pointer-events-none opacity-50')} />
              <p className="flex items-start gap-2 text-xs text-muted-foreground">
                <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                Payments are processed by PayPal. SightLab never sees your card number or PayPal login. By paying you agree
                to the <Link href="/terms" className="underline">Terms</Link>.
              </p>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function Result({ outcome, balance, onRetry }: { outcome: PayPalOutcome; balance?: number; onRetry: () => void }) {
  if (outcome.status === 'completed') {
    return (
      <div className="mx-auto w-full max-w-[520px] space-y-5 py-6 text-center">
        <CheckCircle2 className="mx-auto h-12 w-12 text-success" aria-hidden="true" />
        <div>
          <h1 className="text-2xl font-semibold">Payment complete</h1>
          <p className="mt-1 text-muted-foreground">{fmt(outcome.sparks)} sparks were added to your balance.</p>
        </div>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5 rounded-lg border border-border p-4 text-left text-sm">
          <dt className="text-muted-foreground">Pack</dt><dd className="text-right">{outcome.pack_name} · {fmt(outcome.sparks)} sparks</dd>
          <dt className="text-muted-foreground">Paid</dt><dd className="text-right font-mono">{price(outcome.amount_cents, outcome.currency)} {outcome.currency}</dd>
          {outcome.payment_reference && (<><dt className="text-muted-foreground">PayPal ID</dt><dd className="text-right font-mono text-xs">{outcome.payment_reference}</dd></>)}
          {balance !== undefined && (<><dt className="text-muted-foreground">New balance</dt><dd className="text-right font-mono">{fmt(balance)} sparks</dd></>)}
        </dl>
        <p className="text-sm text-muted-foreground">PayPal emailed you a receipt. This purchase is also under Billing → Purchases.</p>
        <div className="flex flex-wrap justify-center gap-2">
          <Link href="/edit" className="rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90">Start creating</Link>
          <Link href="/billing" className="rounded-md border border-border px-5 py-2.5 text-sm font-medium hover:bg-accent">Back to Billing</Link>
        </div>
      </div>
    );
  }
  const pending = outcome.status === 'pending';
  return (
    <div className="mx-auto w-full max-w-[520px] space-y-4 py-6 text-center">
      {pending ? <Clock className="mx-auto h-12 w-12 text-warning" aria-hidden="true" /> : <AlertCircle className="mx-auto h-12 w-12 text-danger" aria-hidden="true" />}
      <h1 className="text-2xl font-semibold">{pending ? 'Payment pending' : "PayPal couldn't take this payment"}</h1>
      <p className="text-muted-foreground">
        {pending
          ? `PayPal is still reviewing this payment. Your ${fmt(outcome.sparks)} sparks are added automatically as soon as it clears.`
          : 'Nothing was charged. Try another card or your PayPal balance.'}
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        {!pending && <button type="button" onClick={onRetry} className="rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground">Try again</button>}
        <Link href="/billing" className="rounded-md border border-border px-5 py-2.5 text-sm font-medium hover:bg-accent">Back to Billing</Link>
      </div>
    </div>
  );
}
