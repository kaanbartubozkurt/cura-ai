'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Brush, Repeat2 } from 'lucide-react';
import { AppendOnlyGrid, Segmented } from '@/components/ImageGrid';
import ProgressiveImage from '@/components/ProgressiveImage';
import ImageHistoryPanel from '@/components/ImageHistoryPanel';
import { useImagePixels } from '@/hooks/useImagePixels';
import {
  authUrl,
  editApi,
  generationApi,
  historyApi,
  imagesApi,
} from '@/lib/api';
import type { GeneratedImage } from '@/types';
import type { SourceImage } from './SourceTray';
import { sourceColor } from './DescribeInput';

const preview = (image: GeneratedImage) => {
  const uri = image.thumbnail_uri_small || image.thumbnail_uri_medium;
  return uri ? editApi.getThumbnailUrl(uri.split('/').pop()!) : '';
};
function Thumbnail({
  image,
  density,
}: {
  image: GeneratedImage;
  density: 'S' | 'M' | 'L';
}) {
  const { host, pixels } = useImagePixels(image.width, image.height);
  const uri =
    pixels <= 400
      ? image.library_thumbnail_uri_medium || image.library_thumbnail_uri_large
      : image.library_thumbnail_uri_large;
  const high = uri
    ? imagesApi.getThumbnailUrl(uri.split('/').pop()!)
    : !image.library_image_id && pixels > 400 && density !== 'S'
      ? editApi.getImageUrl(image.id)
      : undefined;
  return (
    <span ref={host} className="block h-full w-full">
      <ProgressiveImage
        src={
          preview(image) ||
          (image.library_thumbnail_uri_medium
            ? imagesApi.getThumbnailUrl(
                image.library_thumbnail_uri_medium.split('/').pop()!
              )
            : 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/%3E')
        }
        highSrc={pixels > 0 ? high : undefined}
        alt={image.prompt}
        loading="lazy"
        className="h-full w-full object-cover"
      />
    </span>
  );
}
// Pending records have no output dimensions yet; use the requested shape.
function resultShape(image: GeneratedImage): GeneratedImage {
  if (image.width && image.height) return image;
  const params = image.generation_params ?? {};
  const size = params.image_size;
  if (size && typeof size === 'object' && 'width' in size && 'height' in size) {
    const { width, height } = size as { width: number; height: number };
    if (width > 0 && height > 0) return { ...image, width, height };
  }
  const presets: Record<string, string> = {
    square: '1:1',
    square_hd: '1:1',
    portrait_4_3: '3:4',
    portrait_16_9: '9:16',
    landscape_4_3: '4:3',
    landscape_16_9: '16:9',
  };
  const ratio =
    typeof params.aspect_ratio === 'string' && params.aspect_ratio !== 'auto'
      ? params.aspect_ratio
      : typeof size === 'string'
        ? presets[size]
        : undefined;
  const [width, height] = (ratio ?? '').split(':').map(Number);
  return width > 0 && height > 0 ? { ...image, width, height } : image;
}

interface StoredSource {
  type: 'gallery' | 'generated' | 'upload';
  id?: number;
  key?: string;
}
function storedSources(image: GeneratedImage): StoredSource[] {
  const refs = image.generation_params?.sources as
    | {
        ordered?: StoredSource[];
        image_ids?: number[];
        generated_ids?: number[];
        upload_keys?: string[];
      }
    | undefined;
  return refs?.ordered ?? [];
}

function Viewer({
  image,
  onClose,
  onStep,
  onUse,
  onDelete,
  onRemix,
  onPaintOn,
  label,
}: {
  image: GeneratedImage;
  onClose: () => void;
  onStep: (step: number) => void;
  onUse: (image: GeneratedImage) => void;
  onDelete: (id: number) => void;
  onRemix?: (id: number) => void;
  onPaintOn?: (image: GeneratedImage) => void;
  label: string;
}) {
  const { data: history } = useQuery({
    queryKey: ['image-history', image.library_image_id],
    queryFn: () => historyApi.get(image.library_image_id!),
    enabled: !!image.library_image_id,
  });
  const refs = storedSources(image);
  const { data: inputs } = useQuery({
    queryKey: ['edit-inputs', image.id],
    queryFn: () =>
      Promise.all(
        refs.map(async (source, index) => {
          if (source.type === 'gallery' && source.id) {
            try {
              const item = await imagesApi.get(source.id);
              return imagesApi.getImageUrl(item.object_key.split('/').pop()!);
            } catch {
              return null;
            }
          }
          if (source.type === 'upload')
            return authUrl(`/api/edit/images/${image.id}/sources/${index}`);
          return source.type === 'generated' && source.id
            ? generationApi.getImageUrl(source.id)
            : null;
        })
      ),
    enabled: !image.library_image_id,
  });
  const callbacks = useRef({ onClose, onStep });
  callbacks.current = { onClose, onStep };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') callbacks.current.onClose();
      if (event.key === 'ArrowLeft') callbacks.current.onStep(-1);
      if (event.key === 'ArrowRight') callbacks.current.onStep(1);
    };
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, []);
  const sources = history?.history?.inputs.filter(
    (input) => input.role !== 'mask'
  );
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Edited image viewer"
      className="fixed inset-0 z-50 flex flex-col bg-black/95 text-white"
    >
      <div className="flex items-center justify-between p-3">
        <span>Edited image #{image.id}</span>
        <div className="flex gap-3">
          <button aria-label="Previous result" onClick={() => onStep(-1)}>
            ←
          </button>
          <button aria-label="Next result" onClick={() => onStep(1)}>
            →
          </button>
          <button autoFocus aria-label="Close viewer" onClick={onClose}>
            ✕
          </button>
        </div>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_300px] max-md:grid-cols-1 max-md:overflow-y-auto">
        <div className="flex min-h-0 flex-col gap-3 p-3 max-md:min-h-[50vh]">
          <div className="flex min-h-0 flex-1 gap-3">
            {!!(sources?.length || inputs?.length) && (
              <div className="flex w-1/4 flex-col gap-2 overflow-y-auto">
                {sources
                  ? sources.map((source, index) => (
                      <div
                        key={index}
                        className="relative min-h-24 flex-1 overflow-hidden rounded border"
                        style={{ borderColor: sourceColor(index) }}
                      >
                        <ProgressiveImage
                          src={historyApi.inputUrl(
                            image.library_image_id!,
                            history!.history!.inputs.indexOf(source)
                          )}
                          alt={`Source ${index + 1}`}
                          className="h-full w-full object-contain"
                        />
                        <span className="absolute bottom-0 left-0 bg-black/70 px-1 text-xs">
                          {index + 1} · {source.label}
                        </span>
                      </div>
                    ))
                  : inputs?.map(
                      (url, index) =>
                        url && (
                          <div key={index} className="min-h-24 flex-1">
                            <ProgressiveImage
                              src={url}
                              alt={`Source ${index + 1}`}
                              className="h-full w-full object-contain"
                            />
                          </div>
                        )
                    )}
              </div>
            )}
            <div className="min-h-0 min-w-0 flex-1">
              <ProgressiveImage
                src={preview(image) || editApi.getImageUrl(image.id)}
                highSrc={editApi.getImageUrl(image.id)}
                alt={image.prompt}
                className="h-full w-full object-contain"
              />
            </div>
          </div>
        </div>
        <aside className="overflow-y-auto border-l border-white/20 bg-background p-4 text-foreground">
          <p className="mb-3 whitespace-pre-wrap text-sm">{image.prompt}</p>
          <p className="text-xs text-muted-foreground">
            {label} · {image.width} × {image.height}
          </p>
          <div className="my-4 flex flex-wrap gap-2 text-xs">
            {onRemix && (
              <button
                className="flex items-center gap-1.5 rounded bg-primary px-3 py-2 font-medium text-primary-foreground hover:opacity-90"
                onClick={() => {
                  onRemix(image.id);
                  onClose();
                }}
                title="Reopen Edit with the same sources, prompt and settings"
              >
                <Repeat2 className="h-3.5 w-3.5" />
                Remix
              </button>
            )}
            {onPaintOn && (
              <button
                className="flex items-center gap-1.5 rounded border px-3 py-2"
                onClick={() => {
                  onPaintOn(image);
                  onClose();
                }}
                title="Make this result the base and paint on it"
              >
                <Brush className="h-3.5 w-3.5" />
                Paint on this
              </button>
            )}
            <button
              className="rounded border px-3 py-2"
              onClick={() => {
                onUse(image);
                onClose();
              }}
            >
              + Use as source
            </button>
            {image.library_image_id && (
              <Link
                className="rounded border px-3 py-2"
                href={`/images?image_id=${image.library_image_id}`}
              >
                Open in library
              </Link>
            )}
            <button
              className="rounded border px-3 py-2 text-destructive"
              onClick={() => {
                onDelete(image.id);
                onClose();
              }}
            >
              Delete
            </button>
          </div>
          <details>
            <summary className="cursor-pointer text-sm">
              How it was made
            </summary>
            {image.library_image_id ? (
              <ImageHistoryPanel
                imageId={image.library_image_id}
                onOpen={(id) => {
                  window.location.href = `/images?image_id=${id}`;
                }}
              />
            ) : (
              <pre className="mt-2 whitespace-pre-wrap break-words text-xs">
                {JSON.stringify(image.generation_params, null, 2)}
              </pre>
            )}
          </details>
        </aside>
      </div>
    </div>
  );
}

export default function DescribeResults({
  images,
  onUse,
  onDelete,
  onRemix,
  onPaintOn,
  modelLabel,
}: {
  images: GeneratedImage[];
  onUse: (source: SourceImage) => void;
  onDelete: (id: number) => void;
  /** Reopen Edit with this result's sources, prompt and settings. */
  onRemix?: (id: number) => void;
  /** Paint an area: make this result the base (its paint starts empty). */
  onPaintOn?: (source: SourceImage) => void;
  modelLabel: (key: string) => string;
}) {
  const [density, setDensity] = useState<'S' | 'M' | 'L'>('M');
  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => {
    const saved = localStorage.getItem('library-density');
    if (saved === 'S' || saved === 'M' || saved === 'L') setDensity(saved);
  }, []);
  const visible = images
    .filter((image) => image.status !== 'failed')
    .map(resultShape)
    .sort((a, b) => b.id - a.id);
  const completed = visible.filter((image) => image.status === 'completed');
  const image = completed.find((item) => item.id === selected);
  const toSource = (image: GeneratedImage): SourceImage => ({
    type: 'generated',
    id: image.id,
    previewUrl: preview(image),
    fullUrl: editApi.getImageUrl(image.id),
    width: image.width ?? undefined,
    height: image.height ?? undefined,
  });
  function use(image: GeneratedImage) {
    onUse(toSource(image));
  }
  return (
    <div className="min-w-0 flex-1" aria-label="Edited results">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          Results · newest first
        </span>
        <Segmented
          label="Result density"
          options={(['S', 'M', 'L'] as const).map((key) => ({
            key,
            label: key,
          }))}
          value={density}
          onChange={(value) => {
            setDensity(value);
            localStorage.setItem('library-density', value);
          }}
        />
      </div>
      {!visible.length && (
        <p className="py-16 text-center text-sm text-muted-foreground">
          Add sources and describe what should change.
        </p>
      )}
      <AppendOnlyGrid images={visible} density={density} refreshRatios>
        {(image) => (
          <div
            className={`group relative h-full w-full bg-muted ${image.status !== 'completed' ? 'animate-[shimmer_1.3s_linear_infinite] bg-gradient-to-r from-muted via-accent to-muted bg-[length:220%_100%]' : ''}`}
          >
            {image.status === 'completed' ? (
              <>
                <button
                  className="h-full w-full"
                  aria-label={`Open edited image ${image.id}`}
                  onClick={() => setSelected(image.id)}
                >
                  <Thumbnail image={image} density={density} />
                </button>
                <span className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/65 px-1.5 py-0.5 text-[10px] text-white">
                  Edited
                </span>
                <div className="absolute bottom-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
                  {onPaintOn && (
                    <button
                      className="rounded bg-background/95 px-2 py-1 text-xs"
                      onClick={() => onPaintOn(toSource(image))}
                    >
                      Paint on this
                    </button>
                  )}
                  <button className="rounded bg-background/95 px-2 py-1 text-xs" onClick={() => use(image)}>
                    + Use as source
                  </button>
                </div>
              </>
            ) : (
              <span role="status" className="sr-only">
                Generating result
              </span>
            )}
          </div>
        )}
      </AppendOnlyGrid>
      {image && (
        <Viewer
          image={image}
          label={modelLabel(image.base_model)}
          onClose={() => setSelected(null)}
          onStep={(step) => {
            const index = completed.findIndex((item) => item.id === selected);
            setSelected(
              completed[(index + step + completed.length) % completed.length]
                ?.id ?? null
            );
          }}
          onUse={use}
          onDelete={onDelete}
          onRemix={onRemix}
          onPaintOn={onPaintOn ? (result) => onPaintOn(toSource(result)) : undefined}
        />
      )}
    </div>
  );
}
