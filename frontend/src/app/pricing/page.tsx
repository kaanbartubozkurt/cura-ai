'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import MarketingShell from '@/components/marketing/MarketingShell';
import { billingApi, publicApi } from '@/lib/api';
import type { ModelPrice } from '@/types';

const fmt = (n: number) => n.toLocaleString('en-US');

export default function PricingPage() {
  const { data: packs } = useQuery({ queryKey: ['billing', 'packs'], queryFn: billingApi.getPacks, staleTime: 300_000 });
  const { data: prices } = useQuery({ queryKey: ['public', 'prices'], queryFn: publicApi.getPrices, staleTime: 300_000 });
  const featured = packs?.find((p) => p.is_featured) ?? packs?.[1] ?? packs?.[0];
  const featuredSparks = featured ? featured.sparks_amount + featured.bonus_sparks : 0;
  const lowest = (rows?: ModelPrice[]) => (rows?.length ? rows[0].sparks : null);

  return (
    <MarketingShell>
      <section className="mx-auto max-w-6xl px-6 pb-12 pt-20 text-center">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">Pay for what you use</h1>
        <p className="mx-auto mt-4 max-w-2xl text-lg text-muted-foreground">
          Everything runs on <span className="font-medium text-foreground">sparks</span>, one balance for every model.
          Buy a pack when you need more. No subscription, and sparks never expire.
        </p>
        <p className="mx-auto mt-3 max-w-2xl text-sm font-medium text-emerald-600 dark:text-emerald-400">
          Every new account starts with 500 free sparks. No card needed.
        </p>
      </section>

      <section aria-labelledby="packs" className="mx-auto max-w-6xl px-6 pb-16">
        <h2 id="packs" className="text-center text-2xl font-bold tracking-tight">Spark packs</h2>
        <p className="mt-2 text-center text-sm text-muted-foreground">
          One-time payment with PayPal or any debit or credit card.
        </p>
        <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {(packs ?? []).map((p) => (
            <div key={p.id} className={`rounded-2xl border p-6 text-center ${p.is_featured ? 'border-violet-500 shadow-lg' : 'border-border'}`}>
              <h3 className="font-semibold">{p.name}</h3>
              <div className="mt-2 text-3xl font-bold">${(p.price_cents / 100).toFixed(0)}</div>
              <div className="mt-3 text-sm font-medium">{fmt(p.sparks_amount + p.bonus_sparks)} sparks</div>
              {p.bonus_sparks > 0 && (
                <div className="mt-1 text-xs text-muted-foreground">{fmt(p.sparks_amount)} + {fmt(p.bonus_sparks)} bonus</div>
              )}
            </div>
          ))}
        </div>
        <div className="mt-8 text-center">
          <Link href="/login?mode=signup" className="inline-block rounded-full bg-primary px-7 py-3 font-medium text-primary-foreground hover:opacity-90">
            Start free
          </Link>
        </div>
      </section>

      {prices && prices.edit.length > 0 && (
        <section aria-labelledby="costs" className="border-t border-border bg-secondary/30">
          <div className="mx-auto max-w-3xl px-6 py-16">
            <h2 id="costs" className="text-center text-2xl font-bold tracking-tight">What one edit costs, by model</h2>
            <p className="mt-2 text-center text-sm text-muted-foreground">
              Today&apos;s prices at each model&apos;s default settings. Larger sizes or extras cost more; the app shows the
              exact cost before every run.
            </p>
            <div className="mt-8 overflow-x-auto rounded-2xl border border-border bg-card">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="px-5 py-3 font-medium">Editing model</th>
                    <th className="px-5 py-3 text-right font-medium">Sparks per edit</th>
                    {featured && <th className="px-5 py-3 text-right font-medium">Edits with {featured.name}</th>}
                  </tr>
                </thead>
                <tbody>
                  {prices.edit.map((row) => (
                    <tr key={row.key} className="border-b border-border last:border-0">
                      <td className="px-5 py-3">{row.label}</td>
                      <td className="px-5 py-3 text-right font-mono">{fmt(row.sparks)}</td>
                      {featured && <td className="px-5 py-3 text-right font-mono">{fmt(Math.floor(featuredSparks / row.sparks))}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="mt-6 space-y-1.5 text-center text-sm text-muted-foreground">
              {lowest(prices.generate) !== null && <li>Generating an image from a prompt: from {fmt(lowest(prices.generate)!)} sparks.</li>}
              {lowest(prices.train) !== null && <li>Training a style from a folder: from {fmt(lowest(prices.train)!)} sparks.</li>}
              <li>Describing and tagging an image for your library: from about 1 spark with fast vision models; the largest models cost more.</li>
            </ul>
          </div>
        </section>
      )}

      <section className="mx-auto max-w-6xl px-6 py-20 text-center">
        <h2 className="text-2xl font-bold tracking-tight">Questions about pricing?</h2>
        <p className="mt-3 text-muted-foreground">
          Write to{' '}
          <a href="mailto:team@sightlab.org" className="underline hover:text-foreground">team@sightlab.org</a>
          {' '}and we&apos;ll help you pick the right pack.
        </p>
      </section>
    </MarketingShell>
  );
}
