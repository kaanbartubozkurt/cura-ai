'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Search } from 'lucide-react';
import MarketingShell from '@/components/marketing/MarketingShell';
import ProgressiveImage from '@/components/ProgressiveImage';
import { billingApi, publicApi } from '@/lib/api';
import type { SampleEdit, SampleImage, SampleLibrary } from '@/types';

const ratio = (w?: number | null, h?: number | null) => (w && h ? w / h : 4 / 5);

/** The sample image with the most edits sharing one prompt: the "one photo, many models" example. */
function pickShowcase(data?: SampleLibrary): { image: SampleImage; prompt: string; edits: SampleEdit[] } | null {
  if (!data?.configured) return null;
  let best: { image: SampleImage; prompt: string; edits: SampleEdit[] } | null = null;
  for (const image of data.images) {
    const byPrompt = new Map<string, SampleEdit[]>();
    for (const edit of data.edits[String(image.id)] ?? []) {
      byPrompt.set(edit.prompt, [...(byPrompt.get(edit.prompt) ?? []), edit]);
    }
    for (const [prompt, edits] of Array.from(byPrompt.entries())) {
      const models = new Set(edits.map((e) => e.model));
      if (models.size >= 2 && (!best || models.size > new Set(best.edits.map((e) => e.model)).size)) {
        best = { image, prompt, edits: edits.filter((e, i) => edits.findIndex((x) => x.model === e.model) === i).slice(0, 4) };
      }
    }
  }
  return best;
}

export default function LandingPage() {
  const { data: sample } = useQuery({ queryKey: ['public', 'sample'], queryFn: publicApi.getSample, staleTime: 60_000 });
  const { data: packs } = useQuery({ queryKey: ['billing', 'packs'], queryFn: billingApi.getPacks, staleTime: 300_000 });
  const showcase = useMemo(() => pickShowcase(sample), [sample]);
  const libraryPreview = sample?.configured ? sample.images.slice(0, 9) : [];
  const described = sample?.images.find((i) => i.description);

  return (
    <MarketingShell>
      <section className="mx-auto max-w-6xl px-6 pb-10 pt-20 text-center sm:pt-24">
        <h1 className="mx-auto max-w-4xl text-4xl font-bold leading-[1.05] tracking-tight sm:text-6xl">
          Your image library.<br />Every AI model. One place.
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">
          SightLab describes and sorts your images, then lets you edit them with GPT Image, Nano Banana, FLUX and more,
          and remix any result with another model. Pay per use. Sparks never expire.
        </p>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <Link href="/login?mode=signup" className="rounded-full bg-primary px-7 py-3 font-medium text-primary-foreground hover:opacity-90">
            Start free with 500 sparks
          </Link>
          <Link href="/sample" className="rounded-full border border-border px-7 py-3 font-medium hover:bg-secondary">
            Browse the sample library
          </Link>
        </div>
      </section>

      {showcase && (
        <section aria-labelledby="compare" className="mx-auto max-w-6xl px-6 pb-20">
          <div className="rounded-2xl border border-border bg-secondary/30 p-4 sm:p-5">
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <h2 id="compare" className="text-sm font-semibold">One photo, one prompt, {showcase.edits.length} models</h2>
              <span className="rounded-full border border-border bg-background px-3 py-1 font-mono text-xs text-muted-foreground">
                &ldquo;{showcase.prompt}&rdquo;
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <Tile src={showcase.image.thumb} high={showcase.image.large} r={ratio(showcase.image.width, showcase.image.height)} label="Original" />
              {showcase.edits.map((edit) => (
                <Tile key={edit.id} src={edit.thumb} high={edit.large} r={ratio(edit.width, edit.height)} label={edit.model_label} />
              ))}
            </div>
            <p className="mt-4 text-sm text-muted-foreground">
              Keep the one you like in your library, or remix it with another model. No separate accounts, uploads or
              subscriptions per tool.
            </p>
          </div>
        </section>
      )}

      <section aria-labelledby="remix" className="border-y border-border bg-secondary/30">
        <div className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-20 lg:flex-row lg:items-center">
          <div className="lg:w-[38%]">
            <p className="text-xs font-semibold uppercase tracking-wider text-violet-600 dark:text-violet-400">Remix</p>
            <h2 id="remix" className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">Rerun any result on another model</h2>
            <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
              Every edit keeps its recipe: model, prompt, source images, mask and seed. One click opens it again, so
              trying a different model or a small tweak takes seconds, not a new setup.
            </p>
          </div>
          <div className="flex flex-1 flex-wrap items-center gap-4">
            {showcase && showcase.edits.length >= 2 ? (
              <>
                <div className="w-[38%] min-w-[140px] flex-1">
                  <Tile src={showcase.edits[0].thumb} high={showcase.edits[0].large} r={ratio(showcase.edits[0].width, showcase.edits[0].height)} label={`${showcase.edits[0].model_label} · first try`} />
                </div>
                <Recipe prompt={showcase.prompt} next={showcase.edits[1].model_label} />
                <div className="w-[38%] min-w-[140px] flex-1">
                  <Tile src={showcase.edits[1].thumb} high={showcase.edits[1].large} r={ratio(showcase.edits[1].width, showcase.edits[1].height)} label={`${showcase.edits[1].model_label} · remix`} />
                </div>
              </>
            ) : (
              <Recipe prompt="Make it night: wet street, neon reflections" next="another model" />
            )}
          </div>
        </div>
      </section>

      <section aria-labelledby="library" className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-20 lg:flex-row-reverse lg:items-center">
        <div className="lg:w-[38%]">
          <p className="text-xs font-semibold uppercase tracking-wider text-violet-600 dark:text-violet-400">Library</p>
          <h2 id="library" className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">Your library sorts itself</h2>
          <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
            Upload thousands of images. Each one gets a description and tags, similar images group into clusters, and
            search finds them by what&apos;s in them, not by file name. You pick which vision model describes them.
          </p>
          <Link href="/sample" className="mt-5 inline-flex items-center gap-1.5 font-medium hover:underline">
            Browse the sample library <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
        <div className="flex-1 rounded-2xl border border-border p-4">
          <div className="flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 text-muted-foreground">
            <Search className="h-4 w-4" aria-hidden="true" />
            <span className="text-sm">Search by what&apos;s in the image</span>
          </div>
          {sample?.configured && sample.clusters.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {sample.clusters.slice(0, 6).map((c) => (
                <span key={c.id} className="rounded-full border border-border bg-secondary/40 px-3 py-1 text-xs">{c.title} · {c.count}</span>
              ))}
            </div>
          )}
          {libraryPreview.length > 0 && (
            <div className="mt-3 columns-3 gap-2 sm:columns-4">
              {libraryPreview.map((image) => (
                <div key={image.id} className="mb-2 overflow-hidden rounded-md bg-muted" style={{ aspectRatio: ratio(image.width, image.height) }}>
                  <ProgressiveImage src={image.thumb} alt="" loading="lazy" className="h-full w-full object-cover" />
                </div>
              ))}
            </div>
          )}
          {described && (
            <div className="mt-2 border-t border-border pt-3 text-sm">
              <p className="font-medium">Description, written automatically</p>
              <p className="mt-1 line-clamp-3 leading-relaxed text-muted-foreground">{described.description}</p>
              {described.tags.length > 0 && <p className="mt-1 text-xs text-muted-foreground">Tags: {described.tags.slice(0, 6).join(', ')}</p>}
            </div>
          )}
        </div>
      </section>

      <section aria-labelledby="cloud" className="border-t border-border">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <h2 id="cloud" className="text-2xl font-bold tracking-tight sm:text-3xl">Nothing to install. No GPU needed.</h2>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            Unlike local setups such as ComfyUI or Stable Diffusion on your own machine, SightLab runs entirely on cloud
            services. Open it in a browser on a laptop, tablet or phone and every model is ready.
          </p>
          <div className="mt-8 grid gap-3 sm:grid-cols-3">
            {[
              ['No hardware', 'Models run on cloud GPUs, not your computer. No VRAM limits, no fans spinning.'],
              ['No setup', 'No Python, model downloads, node graphs or updates to manage. New models just appear.'],
              ['Your library goes with you', 'Images, descriptions and results are stored in the cloud and open from any device.'],
            ].map(([title, text]) => (
              <div key={title} className="rounded-xl border border-border p-5">
                <p className="font-semibold">{title}</p>
                <p className="mt-1.5 text-sm text-muted-foreground">{text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section aria-labelledby="pricing" className="bg-zinc-900 text-white">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <h2 id="pricing" className="text-3xl font-bold tracking-tight sm:text-4xl">One balance for every model</h2>
          <p className="mt-3 max-w-2xl text-lg text-zinc-300">
            Buy sparks once and use them on any model. No subscription, and sparks never expire. You see the cost
            before every run.
          </p>
          {packs && packs.length > 0 && (
            <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {packs.map((pack) => (
                <div key={pack.id} className="rounded-xl border border-zinc-700 p-5">
                  <p className="font-semibold">{pack.name}</p>
                  <p className="mt-2 font-mono text-3xl">${(pack.price_cents / 100).toFixed(0)}</p>
                  <p className="mt-1 text-sm text-zinc-300">{(pack.sparks_amount + pack.bonus_sparks).toLocaleString('en-US')} sparks</p>
                </div>
              ))}
            </div>
          )}
          <Link href="/pricing" className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-zinc-200 hover:text-white">
            See what each model costs <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      <section aria-labelledby="also" className="mx-auto max-w-6xl px-6 pt-20">
        <h2 id="also" className="text-xl font-semibold">Also in the studio</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {[
            ['Generate', 'Start from a prompt with the same models.'],
            ['Ask about an image', 'Tag, describe or ask anything with top vision models.'],
            ['Train a style', 'Turn a folder into a style you can generate with.'],
          ].map(([title, text]) => (
            <div key={title} className="rounded-xl border border-border p-5">
              <p className="font-semibold">{title}</p>
              <p className="mt-1.5 text-sm text-muted-foreground">{text}</p>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="faq" className="mx-auto max-w-6xl px-6 py-16">
        <h2 id="faq" className="text-xl font-semibold">Questions</h2>
        <div className="mt-2">
          {[
            ['Who owns my images and results?', 'You do. Your library is private to your account. An image is sent only to the model you choose, when you run it.'],
            ['Which models can I use?', 'For editing: GPT Image, Nano Banana, FLUX, Kling, Ideogram and more. For describing: several vision models. New models are added as they come out.'],
            ['Do I need a GPU or to install anything?', 'No. Everything runs on cloud services, so a browser is all you need, on any computer, tablet or phone. There is nothing to download or keep updated.'],
            ['How does pricing work?', 'Each run costs sparks, shown before you run it. Buy packs with PayPal or a card. No subscription, and sparks never expire.'],
          ].map(([q, a]) => (
            <details key={q} className="border-b border-border py-4">
              <summary className="cursor-pointer font-medium">{q}</summary>
              <p className="mt-2 leading-relaxed text-muted-foreground">{a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-24 text-center">
        <h2 className="text-3xl font-bold tracking-tight">Try every model on your own images</h2>
        <p className="mt-3 text-muted-foreground">500 free sparks on sign-up. No card needed.</p>
        <Link href="/login?mode=signup" className="mt-7 inline-block rounded-full bg-primary px-8 py-3 font-medium text-primary-foreground hover:opacity-90">
          Start free
        </Link>
      </section>
    </MarketingShell>
  );
}

function Tile({ src, high, r, label }: { src: string; high?: string; r: number; label: string }) {
  return (
    <figure className="space-y-2">
      <div className="overflow-hidden rounded-xl bg-muted" style={{ aspectRatio: r }}>
        <ProgressiveImage src={src} highSrc={high} alt={label} loading="lazy" className="h-full w-full object-cover" />
      </div>
      <figcaption className="text-sm font-medium">{label}</figcaption>
    </figure>
  );
}

function Recipe({ prompt, next }: { prompt: string; next: string }) {
  return (
    <div className="min-w-[200px] flex-1 space-y-2 rounded-xl border border-border bg-background p-4 text-sm">
      <p className="font-semibold">Recipe</p>
      <p className="text-muted-foreground">Prompt: <span className="text-foreground">{prompt}</span></p>
      <p className="text-muted-foreground">Sources: <span className="text-foreground">1 library photo</span></p>
      <span className="mt-1 inline-block rounded-full bg-primary px-3.5 py-1.5 font-medium text-primary-foreground">
        Remix with {next}
      </span>
    </div>
  );
}
