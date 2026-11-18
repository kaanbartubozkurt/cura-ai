'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Loader2, X } from 'lucide-react';
import MarketingShell from '@/components/marketing/MarketingShell';
import { AppendOnlyGrid } from '@/components/ImageGrid';
import ProgressiveImage from '@/components/ProgressiveImage';
import { publicApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { SampleImage, SampleLibrary } from '@/types';

/** Public, read-only sample library: what SightLab does to a library, without signing up. */
export default function SampleLibraryPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['public', 'sample'],
    queryFn: publicApi.getSample,
    staleTime: 60_000,
  });
  const [clusterId, setClusterId] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const images = useMemo(() => {
    if (!data) return [];
    const cluster = data.clusters.find((c) => c.id === clusterId);
    return cluster ? data.images.filter((i) => cluster.image_ids.includes(i.id)) : data.images;
  }, [data, clusterId]);
  const selected = data?.images.find((i) => i.id === selectedId) ?? null;

  return (
    <MarketingShell>
      <div className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Sample library</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {data?.configured
                ? `${data.images.length} images, described, tagged and grouped by SightLab. Click one to see its description and its edits by different models.`
                : 'What SightLab does to a library, without signing up.'}
            </p>
          </div>
          <Link href="/login?mode=signup" className="rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90">
            Start free with your own images
          </Link>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-24"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : !data?.configured || data.images.length === 0 ? (
          <div className="rounded-lg border border-border py-20 text-center text-muted-foreground">
            The sample library is being prepared. Check back soon.
          </div>
        ) : (
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
            <nav aria-label="Clusters" className="flex gap-2 overflow-x-auto pb-1 lg:w-56 lg:shrink-0 lg:flex-col lg:gap-1 lg:overflow-visible">
              <p className="hidden px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground lg:block">
                Clusters, made automatically
              </p>
              <ClusterButton active={clusterId === null} onClick={() => setClusterId(null)} label="All images" count={data.images.length} />
              {data.clusters.map((c) => (
                <ClusterButton key={c.id} active={clusterId === c.id} onClick={() => setClusterId(c.id)} label={c.title} count={c.count} />
              ))}
            </nav>

            <div className="min-w-0 flex-1">
              <AppendOnlyGrid key={clusterId ?? 'all'} images={images} density="M">
                {(image) => (
                  <button
                    type="button"
                    onClick={() => setSelectedId(image.id)}
                    aria-label={image.description || `Sample image ${image.id}`}
                    className={cn(
                      'block h-full w-full overflow-hidden rounded-md bg-muted outline-none ring-offset-2 focus-visible:ring-2 focus-visible:ring-selection',
                      selectedId === image.id && 'ring-2 ring-selection',
                    )}
                  >
                    <ProgressiveImage src={image.thumb} highSrc={image.large} alt="" loading="lazy" className="h-full w-full object-cover" />
                  </button>
                )}
              </AppendOnlyGrid>
            </div>

            {selected && (
              <>
                <div className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={() => setSelectedId(null)} aria-hidden="true" />
                <aside
                  aria-label="Selected image"
                  className="fixed inset-x-0 bottom-0 z-50 max-h-[85vh] overflow-y-auto rounded-t-xl border border-border bg-background p-4 lg:sticky lg:top-20 lg:z-auto lg:max-h-[calc(100vh-6rem)] lg:w-[360px] lg:shrink-0 lg:rounded-lg"
                >
                  <SelectedImage image={selected} data={data} onClose={() => setSelectedId(null)} />
                </aside>
              </>
            )}
          </div>
        )}
      </div>
    </MarketingShell>
  );
}

function ClusterButton({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex min-h-10 shrink-0 items-center justify-between gap-3 rounded-md px-3 text-left text-sm',
        active ? 'bg-selection-soft font-medium text-selection' : 'text-foreground hover:bg-accent',
      )}
    >
      <span className="truncate">{label}</span>
      <span className="text-xs text-muted-foreground">{count}</span>
    </button>
  );
}

function SelectedImage({ image, data, onClose }: { image: SampleImage; data: SampleLibrary; onClose: () => void }) {
  const edits = data.edits[String(image.id)] ?? [];
  const prompts = Array.from(new Set(edits.map((e) => e.prompt)));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-sm font-semibold">Image details</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="overflow-hidden rounded-md bg-muted" style={{ aspectRatio: image.width && image.height ? image.width / image.height : 1 }}>
        <ProgressiveImage src={image.thumb} highSrc={image.large} alt={image.description || ''} className="h-full w-full object-contain" />
      </div>
      {image.description && (
        <section className="space-y-1.5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Description, written automatically</h3>
          <p className="text-sm leading-relaxed">{image.description}</p>
        </section>
      )}
      {image.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {image.tags.map((tag) => (
            <span key={tag} className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">{tag}</span>
          ))}
        </div>
      )}
      {edits.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Edits of this image</h3>
          {prompts.length === 1 && <p className="font-mono text-xs text-muted-foreground">&ldquo;{prompts[0]}&rdquo;</p>}
          <div className="grid grid-cols-2 gap-2">
            {edits.map((edit) => (
              <figure key={edit.id} className="space-y-1" title={prompts.length > 1 ? edit.prompt : undefined}>
                <div className="overflow-hidden rounded bg-muted" style={{ aspectRatio: edit.width && edit.height ? edit.width / edit.height : 1 }}>
                  <ProgressiveImage src={edit.thumb} highSrc={edit.large} alt={`Edited with ${edit.model_label}`} loading="lazy" className="h-full w-full object-cover" />
                </div>
                <figcaption className="text-xs font-medium">{edit.model_label}</figcaption>
              </figure>
            ))}
          </div>
        </section>
      )}
      <Link href="/login?mode=signup" className="rounded-md bg-primary px-4 py-2.5 text-center text-sm font-medium text-primary-foreground hover:opacity-90">
        Try this on your own photos
      </Link>
      <p className="text-xs text-muted-foreground">Editing, remix and search need a free account: 500 sparks, no card.</p>
    </div>
  );
}
