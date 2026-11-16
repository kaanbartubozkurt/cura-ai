'use client';

import { useFirstImagesTiming } from '@/lib/loadTimings';

import { useMobileSheet } from '@/hooks/useMobileSheet';
import LibraryThumbnail from '@/components/LibraryThumbnail';

import Link from 'next/link';
import { Suspense, useState, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useDeletingImages } from '@/lib/deletingImages';
import { useQuery, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { CheckSquare, FileText, FolderMinus, FolderPlus, LayoutGrid, Loader2, MinusCircle, PanelRightOpen, Trash2, X } from 'lucide-react';
import { imagesApi, jobsApi } from '@/lib/api';
import ImageDrawer from '@/components/ImageDrawer';
import Inspector, { type ImageAction, type InspectorTool } from '@/components/Inspector';
import { cn } from '@/lib/utils';
import type { Image, ImageListResponse } from '@/types';

type SourceKey = 'upload' | 'generated' | 'edited';
type Density = 'S' | 'M' | 'L';

const SOURCE_FILTERS: { key: SourceKey | null; label: string }[] = [
  { key: null, label: 'All' },
  { key: 'upload', label: 'Uploads' },
  { key: 'generated', label: 'Generated' },
  { key: 'edited', label: 'Edited' },
];

type StatusKey = 'not_described' | 'failed';
const STATUS_FILTERS: { key: StatusKey | null; label: string }[] = [
  { key: null, label: 'Any status' },
  { key: 'not_described', label: 'Not described' },
  { key: 'failed', label: 'Failed' },
];
// Not described = pending → tagged, plus failed images that never got a description.
const STATUS_PARAMS: Record<StatusKey, FetchParams> = {
  not_described: { max_status: 'tagged' },
  failed: { status: 'failed' },
};

const COLUMN_WIDTH: Record<Density, number> = { S: 150, M: 210, L: 300 };
const DENSITY_KEY = 'library-density';
const PAGE_SIZE = 60;
const NOT_DESCRIBED = new Set(['ingested', 'normalized', 'tagged']);

interface FetchParams {
  status?: string;
  min_status?: string;
  max_status?: string;
  source?: string;
  in_folder?: boolean;
  skip?: number;
  limit?: number;
}

interface ImageGridProps {
  title: string;
  queryKeyPrefix: string;
  fetchImages: (params: FetchParams) => Promise<ImageListResponse>;
  folderId?: number;
  clusterId?: number;
  inspectorOverview?: ReactNode;
  /** Show the All / Uploads / Generated / Edited filter (needs `source` support in fetchImages). */
  showSourceFilter?: boolean;
  /** Extra controls rendered next to the title, e.g. folder actions. */
  headerActions?: React.ReactNode;
  /** Rendered between the title row and the toolbar, e.g. a folder description. */
  subtitle?: React.ReactNode;
}

export default function ImageGrid(props: ImageGridProps) {
  return (
    <Suspense
      fallback={
        <div className="flex h-64 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <ImageGridContent {...props} />
    </Suspense>
  );
}

export function Segmented<T extends string | null>({
  options,
  value,
  onChange,
  label,
}: {
  options: { key: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex gap-0.5 rounded-lg bg-muted p-0.5">
      {options.map((o) => (
        <button
          key={o.label}
          onClick={() => onChange(o.key)}
          aria-pressed={value === o.key}
          className={cn(
            'h-7 whitespace-nowrap rounded-md px-2.5 text-[12.5px] font-medium transition-colors',
            value === o.key
              ? 'bg-background text-foreground shadow-sm dark:bg-accent'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Tile({
  image,
  selected,
  selecting,
  onOpen,
  onToggle,
}: {
  image: Image;
  selected: boolean;
  selecting: boolean;
  onOpen: () => void;
  onToggle: () => void;
}) {
  const thumb = image.thumbnail_uri_medium || image.thumbnail_uri_small;
  const src = image.thumbnail_url || (thumb ? imagesApi.getThumbnailUrl(thumb.split('/').pop()!) : null);
  const ratio = image.width && image.height ? image.width / image.height : 1;
  const flag =
    image.status === 'failed'
      ? { text: 'Failed', cls: 'text-danger' }
      : image.status === 'pending'
        ? { text: 'Processing', cls: 'text-muted-foreground' }
        : NOT_DESCRIBED.has(image.status)
          ? { text: 'Not described', cls: 'text-warning' }
          : null;
  const description = image.metadata?.description_long;
  const tags = image.metadata?.tags?.slice(0, 4) ?? [];

  return (
    <div
      data-load-card={src ? image.id : undefined}
      data-image-id={image.id}
      data-selecting={selecting}
      className={cn(
        'library-tile group relative h-full overflow-hidden rounded-md bg-muted',
        selected && 'outline outline-[3px] -outline-offset-[3px] outline-selection'
      )}
    >
      <button
        type="button"
        // In select mode a click anywhere on the image toggles it; Cmd/Ctrl/Shift-click enters select mode.
        onClick={(e) => (selecting || e.metaKey || e.ctrlKey || e.shiftKey ? onToggle() : onOpen())}
        className="block h-full w-full"
        aria-label={`${image.original_filename || `Image ${image.id}`}${selected ? ', selected' : ''}`}
      >
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <LibraryThumbnail
            image={image}
            alt=""
            loading="lazy"
            style={{ aspectRatio: ratio }}
            className={cn(
              'block h-full w-full object-cover transition-transform duration-200',
              selected && 'scale-[0.94] rounded'
            )}
          />
        ) : (
          <div
            style={{ aspectRatio: ratio }}
            className="grid h-full w-full place-items-center text-xs text-muted-foreground"
          >
            No preview
          </div>
        )}
      </button>
      {(image.source === 'generated' || image.source === 'edited') && (
        <span className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/45 px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider text-white backdrop-blur">
          {image.source}
        </span>
      )}
      {(description || tags.length > 0) && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 hidden bg-gradient-to-t from-black/85 via-black/60 to-transparent px-2.5 pb-2.5 pt-8 text-white opacity-0 transition-opacity group-hover:opacity-100 md:block">
          {description && <p className="line-clamp-3 text-xs leading-snug">{description}</p>}
          {tags.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1 overflow-hidden">
              {tags.map((tag) => (
                <span key={tag} className="max-w-full truncate rounded bg-white/20 px-1.5 py-0.5 text-[10.5px]">
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      {flag && (
        <span
          className={cn(
            'pointer-events-none absolute right-2 top-2 rounded bg-background px-1.5 py-0.5 text-[10.5px] font-medium',
            flag.cls
          )}
        >
          {flag.text}
        </span>
      )}
    </div>
  );
}

// Keep assignments and ratios for the current result sequence. Appending a page only
// adds to the shortest column; existing DOM nodes and reserved heights stay put.
export type GridItem = { id: number; width?: number | null; height?: number | null };

export function AppendOnlyGrid<T extends GridItem>({
  images,
  density,
  children,
  refreshRatios = false,
}: {
  images: T[];
  density: Density;
  children: (image: T) => ReactNode;
  refreshRatios?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const layout = useRef<{ count: number; density: Density; ids: number[]; columns: number[]; ratios: number[] }>({
    count: 0, density, ids: [], columns: [], ratios: [],
  });
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)');
    const update = () => setPhone(media.matches);
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const count = phone ? ({ S: 5, M: 3, L: 2 }[density]) : Math.max(1, Math.floor((width + 8) / (COLUMN_WIDTH[density] + 8)));
  const tileWidth = (width - (count - 1) * 8) / count;
  let current = layout.current;
  if (current.count !== count || current.density !== density ||
      current.ids.length > images.length || current.ids.some((id, i) => images[i]?.id !== id)) {
    current = { count, density, ids: [], columns: [], ratios: [] };
    layout.current = current;
  }
  if (refreshRatios) {
    current.ratios = current.ratios.map((ratio, i) => (
      images[i]?.width && images[i]?.height
        ? images[i].width! / images[i].height!
        : ratio
    ));
  }
  const heights = Array<number>(count).fill(0);
  current.columns.forEach((column, i) => { heights[column] += tileWidth / current.ratios[i] + 8; });
  for (let i = current.ids.length; i < images.length; i++) {
    const image = images[i];
    const ratio = image.width && image.height ? image.width / image.height : 1;
    const column = heights.indexOf(Math.min(...heights));
    current.ids.push(image.id);
    current.columns.push(column);
    current.ratios.push(ratio);
    heights[column] += tileWidth / ratio + 8;
  }
  return (
    <div ref={container} className="pb-24">
      {width > 0 && (
        <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}>
          {Array.from({ length: count }, (_, column) => (
            <div key={column} className="min-w-0">
              {images.map((image, i) => current.columns[i] === column ? (
                <div key={image.id} style={{ aspectRatio: current.ratios[i] }} className="mb-2 overflow-hidden rounded-md">
                  {children(image)}
                </div>
              ) : null)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ImageGridContent({
  title,
  queryKeyPrefix,
  fetchImages,
  folderId,
  clusterId,
  inspectorOverview,
  showSourceFilter = false,
  headerActions,
  subtitle,
}: ImageGridProps) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  useFirstImagesTiming(`${pathname}?${searchParams.toString()}`);
  const imageIdParam = searchParams.get('image_id');
  const entryTool = searchParams.get('tool');
  const sourceParam = searchParams.get('source') as SourceKey | null;
  const source = SOURCE_FILTERS.some((s) => s.key === sourceParam) ? sourceParam : null;

  const [inspectorHidden, setInspectorHidden] = useState(false);
  const [wide, setWide] = useState(false);
  const [mobileInspector, setMobileInspector] = useState(false);
  const [tool, setTool] = useState<InspectorTool | null>(null);
  const [toolImages, setToolImages] = useState<Image[] | null>(null);
  useEffect(() => {
    try {
      setInspectorHidden(localStorage.getItem('library-inspector-hidden') === 'true');
    } catch {}
    const media = window.matchMedia('(min-width: 1100px)');
    const update = () => setWide(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const stage = entryTool === 'Create' ? '/generate' : entryTool === 'Edit' ? '/edit' : entryTool === 'Ask Vision' ? '/vision?mode=custom' : null;
    if (stage) {
      router.replace(stage);
      return;
    }
    // Training moved out of the library; old links land on Models.
    if (entryTool === 'Train model') {
      router.replace('/models');
      return;
    }
    setTool(null);
    setToolImages(null);
  }, [entryTool, router]);

  const changeInspectorHidden = (hidden: boolean) => {
    setInspectorHidden(hidden);
    try {
      localStorage.setItem('library-inspector-hidden', String(hidden));
    } catch {}
  };

  useEffect(() => {
    if (wide && (tool || mobileInspector)) {
      setInspectorHidden(false);
      try {
        localStorage.setItem('library-inspector-hidden', 'false');
      } catch {}
      setMobileInspector(false);
    }
  }, [wide, tool, mobileInspector]);

  const inspectorVisible = wide && !inspectorHidden;
  const [openImage, setOpenImage] = useState<Image | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [density, setDensity] = useState<Density>('M');
  const [mobileMenu, setMobileMenu] = useState<'more' | 'actions' | null>(null);
  const sheetRef = useMobileSheet(!!mobileMenu, () => setMobileMenu(null));
  const inspectorRef = useMobileSheet(!wide && (mobileInspector || !!tool), () => { setMobileInspector(false); setTool(null); });
  const gesture = useRef<{ x: number; y: number; timer?: ReturnType<typeof setTimeout>; sweeping: boolean; suppress: boolean }>({ x: 0, y: 0, sweeping: false, suppress: false });
  useEffect(() => () => clearTimeout(gesture.current.timer), []);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(DENSITY_KEY) as Density | null;
      if (saved && saved in COLUMN_WIDTH) setDensity(saved);
    } catch {
      // keep default
    }
  }, []);

  const changeDensity = (d: Density) => {
    setDensity(d);
    try {
      localStorage.setItem(DENSITY_KEY, d);
    } catch {
      // ignore
    }
  };

  const [statusFilter, setStatusFilter] = useState<StatusKey | null>(null);
  const changeStatus = (next: StatusKey | null) => {
    setStatusFilter(next);
    setSelectedIds(new Set());
    setSelectedCache(new Map());
  };
  // Selected images that aren't loaded in the grid yet (from "Select all N").
  const [selectedCache, setSelectedCache] = useState<Map<number, Image>>(new Map());
  const [selectingAll, setSelectingAll] = useState(false);

  const changeSource = (s: SourceKey | null) => {
    const next = new URLSearchParams(searchParams.toString());
    if (s) next.set('source', s);
    else next.delete('source');
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
    setSelectedIds(new Set());
  };

  // Auto-open viewer when image_id is in URL params
  const hasOpenedLinked = useRef<number | null>(null);
  const { data: linkedImage } = useQuery({
    queryKey: ['images', Number(imageIdParam)],
    queryFn: () => imagesApi.get(Number(imageIdParam)),
    enabled: !!imageIdParam,
  });
  useEffect(() => {
    if (linkedImage && linkedImage.id !== hasOpenedLinked.current) {
      hasOpenedLinked.current = linkedImage.id;
      setOpenImage(linkedImage);
    }
  }, [linkedImage]);
  useEffect(() => {
    if (!imageIdParam) hasOpenedLinked.current = null;
  }, [imageIdParam]);

  const { data, isLoading, isError, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: [queryKeyPrefix, source, statusFilter],
      queryFn: ({ pageParam }) =>
        fetchImages({ ...(source ? { source } : {}), ...(statusFilter ? STATUS_PARAMS[statusFilter] : {}), skip: pageParam, limit: PAGE_SIZE }),
      initialPageParam: 0,
      getNextPageParam: (last, pages) => {
        const loaded = pages.reduce((n, p) => n + p.items.length, 0);
        return loaded < last.total && last.items.length > 0 ? loaded : undefined;
      },
    });

  const deleting = useDeletingImages();
  const images = useMemo(
    () => (data?.pages.flatMap((p) => p.items) ?? []).filter((image) => !deleting.has(image.id) && (!folderId || !source || image.source === source)),
    [data, deleting, folderId, source]
  );
  const total = data?.pages[0]?.total ?? 0;

  // Load the next page when the sentinel scrolls into view
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !isFetchingNextPage) fetchNextPage();
      },
      { rootMargin: '600px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const { data: jobs } = useQuery({
    queryKey: ['jobs'],
    queryFn: () => jobsApi.list({ limit: 50 }),
    refetchInterval: 5000,
  });
  const hasBatchRunning =
    jobs?.items.some(
      (j) =>
        (j.job_type === 'batch_reprocess' || j.job_type === 'batch_describe') &&
        (j.status === 'running' || j.status === 'pending')
    ) ?? false;

  const clearSelection = () => {
    setSelectedCache(new Map());
    setSelectedIds(new Set());
    setSelectMode(false);
    setToolImages(null);
  };

  const toggle = (id: number) => {
    setSelectMode(true);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const selectAllLoaded = () => {
    setSelectMode(true);
    setSelectedIds(new Set(images.map((i) => i.id)));
  };
  // Select every image matching the current filters, fetching pages not loaded yet.
  const selectAllMatching = async () => {
    setSelectMode(true);
    if (images.length >= total) {
      selectAllLoaded();
      return;
    }
    setSelectingAll(true);
    try {
      const all: Image[] = [];
      for (let skip = 0; skip < total; skip += 200) {
        const page = await fetchImages({
          ...(source ? { source } : {}),
          ...(statusFilter ? STATUS_PARAMS[statusFilter] : {}),
          skip,
          limit: 200,
        });
        all.push(...page.items);
        if (page.items.length < 200) break;
      }
      const matching = all.filter((image) => !deleting.has(image.id));
      setSelectedCache(new Map(matching.map((image) => [image.id, image])));
      setSelectedIds(new Set(matching.map((image) => image.id)));
    } finally {
      setSelectingAll(false);
    }
  };
  const selectStatuses = (statuses: string[]) => {
    changeStatus(statuses.length === 1 && statuses[0] === 'failed' ? 'failed' : 'not_described');
    setSelectMode(true);
  };

  const allLoadedSelected = images.length > 0 && images.every((img) => selectedIds.has(img.id)) && selectedIds.size >= total;
  const selecting = selectMode || selectedIds.size > 0;

  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !tool && !openImage) clearSelection();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selecting, openImage, tool]);

  useEffect(() => {
    if (selecting) document.body.classList.add('mobile-library-selecting');
    else document.body.classList.remove('mobile-library-selecting');
    return () => document.body.classList.remove('mobile-library-selecting');
  }, [selecting]);

  const navigateTool = (next: ImageAction | null, ids = toolImages ? toolImages.map(image => image.id) : Array.from(selectedIds)) => {
    const stage = next === 'Edit' ? '/edit' : next === 'Ask Vision' ? '/vision' : null;
    if (!stage) return false;
    const params = new URLSearchParams();
    if (next === 'Ask Vision') params.set('mode', 'custom');
    if (ids.length) params.set('sources', ids.join(','));
    router.push(params.size ? `${stage}?${params}` : stage);
    return true;
  };

  const mobileTool = (next: InspectorTool) => {
    setMobileMenu(null);
    setTool(next);
    setMobileInspector(true);
  };
  const dockButton =
    'flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-primary-foreground/90 transition-colors hover:bg-primary-foreground/10 hover:text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50';

  return (
    <div className="mobile-library flex items-start gap-5"
      onContextMenu={e => { if (window.innerWidth < 768 && (e.target as HTMLElement).closest('[data-image-id]')) e.preventDefault(); }}
      onPointerDown={e => {
        if (window.innerWidth >= 768 || !e.isPrimary) return;
        const tile = (e.target as HTMLElement).closest<HTMLElement>('[data-image-id]');
        if (!tile) return;
        const id = Number(tile.dataset.imageId);
        clearTimeout(gesture.current.timer);
        gesture.current = { x: e.clientX, y: e.clientY, sweeping: false, suppress: false };
        gesture.current.timer = setTimeout(() => {
          gesture.current.sweeping = true;
          gesture.current.suppress = true;
          setSelectMode(true);
          setSelectedIds(prev => new Set([...Array.from(prev), id]));
        }, 450);
      }}
      onPointerMove={e => {
        const g = gesture.current;
        if (Math.hypot(e.clientX - g.x, e.clientY - g.y) > 8) clearTimeout(g.timer);
        if (!g.sweeping) return;
        const tile = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-image-id]');
        if (tile) setSelectedIds(prev => new Set([...Array.from(prev), Number(tile.dataset.imageId)]));
      }}
      onPointerUp={() => { clearTimeout(gesture.current.timer); gesture.current.sweeping = false; }}
      onPointerCancel={() => { clearTimeout(gesture.current.timer); gesture.current.sweeping = false; }}
      onClickCapture={e => {
        if (gesture.current.suppress) { e.preventDefault(); e.stopPropagation(); gesture.current.suppress = false; }
      }}
    >
      <div className="min-w-0 flex-1 space-y-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className={`flex items-baseline gap-2 text-xl font-semibold tracking-tight ${title === 'All images' ? 'max-md:hidden' : ''}`}>
            {title}
            <span className="font-mono text-[13px] font-normal tabular-nums text-muted-foreground">
              {total}
            </span>
          </h1>
          <button className="md:hidden ml-auto min-h-10" onClick={() => selecting ? clearSelection() : setSelectMode(true)}>{selecting ? `Done · ${selectedIds.size}` : 'Select'}</button>
          {(headerActions || inspectorOverview) && <button className="md:hidden min-h-10" onClick={() => setMobileMenu('actions')}>Options</button>}
          {headerActions && (
            <div className="ml-auto hidden md:flex flex-wrap items-center gap-1.5">{headerActions}</div>
          )}
        </div>
        {subtitle}


        <div className="library-filters flex flex-wrap items-center gap-2">
          <button className="md:hidden min-h-10 rounded-full border border-border px-4" onClick={() => setDensity(density === 'L' ? 'M' : density === 'M' ? 'S' : 'L')}>Size · {({ S: 5, M: 3, L: 2 })[density]}</button>
          <div className={showSourceFilter ? '' : 'md:hidden'}>
            <Segmented label="Source" options={SOURCE_FILTERS} value={source} onChange={changeSource} />
          </div>
          <Segmented label="Status" options={STATUS_FILTERS} value={statusFilter} onChange={changeStatus} />
          <div className="ml-auto hidden md:flex items-center gap-1.5">
            {selecting && (
              <span className="px-1 text-[12.5px] font-medium tabular-nums text-selection">{selectedIds.size} selected</span>
            )}
            <button
              type="button"
              aria-pressed={selecting}
              onClick={() => (selecting ? clearSelection() : setSelectMode(true))}
              title={selecting ? 'Leave select mode (Esc)' : 'Select images (or Cmd/Shift-click an image)'}
              className={cn(
                'flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[12.5px] font-medium transition-colors',
                selecting
                  ? 'border-selection/40 bg-selection-soft text-selection'
                  : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
            >
              {selecting ? <X className="h-3.5 w-3.5" /> : <CheckSquare className="h-3.5 w-3.5" />}
              {selecting ? 'Done' : 'Select'}
            </button>
            {images.length > 0 && (
              <button
                onClick={() => (allLoadedSelected ? setSelectedIds(new Set()) : void selectAllMatching())}
                disabled={selectingAll}
                className="h-7 rounded-md px-2.5 text-[12.5px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                {selectingAll ? 'Selecting…' : allLoadedSelected ? 'Deselect all' : `Select all${total > images.length ? ` ${total.toLocaleString()}` : ''}`}
              </button>
            )}
            <Segmented
              label="Thumbnail size"
              options={(['S', 'M', 'L'] as Density[]).map((d) => ({ key: d, label: d }))}
              value={density}
              onChange={changeDensity}
            />
          </div>
        </div>

        {isLoading ? (
          <div className="flex h-64 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : isError ? (
          <div className="flex h-64 flex-col items-center justify-center gap-2 text-center">
            <p className="font-medium">Couldn&apos;t load these images</p>
            <p className="max-w-md text-sm text-muted-foreground">{error?.message}</p>
            <button
              onClick={() => refetch()}
              className="mt-1 rounded-md border border-input px-3 py-1.5 text-[13px] font-medium hover:bg-accent"
            >
              Try again
            </button>
          </div>
        ) : images.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center gap-1 text-center">
            <p className="font-medium">No images here</p>
            <p className="text-sm text-muted-foreground">
              {source || statusFilter
                ? 'Nothing matches these filters. Try a different source or status.'
                : 'Upload images or create some to start your library.'}
            </p>
          </div>
        ) : (
          <>
            <AppendOnlyGrid images={images} density={density}>
              {(image) => (
                <Tile
                  key={image.id}
                  image={image}
                  selected={selectedIds.has(image.id)}
                  selecting={selecting}
                  onOpen={() => setOpenImage(image)}
                  onToggle={() => toggle(image.id)}
                />
              )}
            </AppendOnlyGrid>

          </>
        )}

        <div ref={sentinelRef} className="flex h-10 items-center justify-center">
          {isFetchingNextPage && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
        </div>
        {selecting && (
          <div className="mobile-selection-bar md:hidden" role="toolbar" aria-label="Selection actions">
            <button disabled={!selectedIds.size || hasBatchRunning} onClick={() => mobileTool('Describe')}>Describe</button>
            <button disabled={selectedIds.size < 2} onClick={() => mobileTool('Cluster')}>Cluster</button>
            <button disabled={!selectedIds.size} onClick={() => mobileTool('Add to folder')}>Folder</button>
            <button disabled={!selectedIds.size} className="text-danger" onClick={() => mobileTool('Delete')}>Delete</button>
            <button onClick={() => setMobileMenu('more')}>More</button>
          </div>
        )}
        {mobileMenu && (
          <div className="md:hidden fixed inset-0 z-[60] bg-black/50" onClick={() => setMobileMenu(null)}>
            <section ref={sheetRef} role="dialog" aria-modal="true" aria-label="Library actions" className="mobile-sheet absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-2xl bg-background p-4 space-y-3" onClick={e => e.stopPropagation()}>
              <button className="min-h-10" onClick={() => setMobileMenu(null)}>Close</button>
              {mobileMenu === 'actions' ? <>{headerActions}{inspectorOverview}</> : <>
                <button className="block min-h-12" onClick={() => void selectAllMatching()}>Select all {total.toLocaleString()}</button>
                {folderId && <button className="block min-h-12" disabled={!selectedIds.size} onClick={() => mobileTool('Remove from folder')}>Remove from this folder</button>}
                {clusterId && <button className="block min-h-12" disabled={!selectedIds.size} onClick={() => mobileTool('Exclude from cluster')}>Exclude from cluster</button>}
              </>}
            </section>
          </div>
        )}
        {/* Compact fallback when the inspector is hidden. */}
        {selectedIds.size > 0 && !inspectorVisible && (
          <div
            role="toolbar"
            aria-label="Selection actions"
            className="hidden md:flex selection-actions fixed bottom-5 left-1/2 z-40 flex max-w-[calc(100vw-24px)] -translate-x-1/2 overflow-x-auto items-center gap-0.5 whitespace-nowrap rounded-xl bg-primary p-1.5 text-primary-foreground shadow-[0_18px_40px_-12px_rgb(0_0_0/0.45)]"
          >
            <button onClick={clearSelection} className={cn(dockButton, 'px-2')} aria-label="Clear selection">
              <X className="h-4 w-4" />
            </button>
            <span className="px-1.5 text-[13px] font-semibold tabular-nums">{selectedIds.size} selected</span>
            <span className="mx-1 h-5 w-px bg-primary-foreground/20" />
            <button
              onClick={() => setTool('Describe')}
              disabled={hasBatchRunning}
              title={hasBatchRunning ? 'A describe job is already running' : 'Tag, describe and embed these images'}
              className={dockButton}
            >
              <FileText className="h-4 w-4" />
              Describe
            </button>
            <button onClick={() => setTool('Cluster')} disabled={selectedIds.size < 2} className={dockButton}>
              <LayoutGrid className="h-4 w-4" />
              Cluster
            </button>
            <button onClick={() => setTool('Add to folder')} className={dockButton}>
              <FolderPlus className="h-4 w-4" />
              Add to folder
            </button>
            {folderId && (
              <button onClick={() => setTool('Remove from folder')} className={dockButton}>
                <FolderMinus className="h-4 w-4" />
                Remove from folder
              </button>
            )}
            {clusterId && (
              <button onClick={() => setTool('Exclude from cluster')} className={dockButton}>
                <MinusCircle className="h-4 w-4" />
                Exclude
              </button>
            )}
            <span className="mx-1 h-5 w-px bg-primary-foreground/20" />
            <button onClick={() => setTool('Delete')} className={dockButton}>
              <Trash2 className="h-4 w-4" />
              Delete
            </button>
          </div>
        )}

        {openImage && (
          <ImageDrawer
            key={openImage.id}
            image={openImage}
            images={images}
            onNavigate={setOpenImage}
            onTool={(next, image) => {
              if (next === 'Edit' || next === 'Ask Vision') {
                navigateTool(next, [image.id]);
                return;
              }
              setSelectMode(true);
              setSelectedIds(new Set([image.id]));
              setToolImages([image]);
              setTool(next);
              // Tool handoffs open the docked inspector on wide screens and the sheet on narrow screens.
              setMobileInspector(true);
              setOpenImage(null);
            }}
            onClose={() => {
              setOpenImage(null);
              const next = new URLSearchParams(searchParams.toString());
              next.delete('image_id');
              router.replace(next.size ? `${pathname}?${next}` : pathname);
            }}
          />
        )}
      </div>
      {(wide || tool || mobileInspector) && (
        <div
          ref={inspectorRef as React.RefObject<HTMLDivElement>}
          className={cn(
            'library-inspector sticky top-4 h-[calc(100vh-120px)] shrink-0',
            wide && 'overflow-hidden transition-[width] duration-[180ms] motion-reduce:transition-none',
            wide && inspectorHidden ? 'w-11' : 'w-[340px]',
            !wide && 'fixed inset-0 z-50 h-full w-full bg-background sm:left-auto sm:w-[340px]'
          )}
        >
          {wide && inspectorHidden ? (
            <aside
              aria-label="Inspector"
              className="flex h-full flex-col items-center gap-3 border-l border-border bg-background pt-4"
            >
              <button
                type="button"
                aria-label="Show inspector"
                title="Show inspector"
                aria-expanded={false}
                onClick={() => changeInspectorHidden(false)}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <PanelRightOpen className="h-4 w-4" />
              </button>
              <button
                type="button"
                aria-label="Show inspector"
                title="Show inspector"
                aria-expanded={false}
                onClick={() => changeInspectorHidden(false)}
                className="rounded px-1 py-1.5 text-xs tracking-wide text-muted-foreground hover:bg-accent hover:text-foreground [writing-mode:vertical-rl]"
              >
                Inspector
              </button>
            </aside>
          ) : (
            <Inspector
              onHide={wide ? () => changeInspectorHidden(true) : undefined}
              onDismiss={
                !wide
                  ? () => {
                      setMobileInspector(false);
                      setTool(null);
                      setToolImages(null);
                      const params = new URLSearchParams(searchParams.toString());
                      params.delete('tool');
                      router.replace(params.size ? `${pathname}?${params}` : pathname, { scroll: false });
                    }
                  : undefined
              }
              title={title}
              total={total}
              images={toolImages ?? Array.from(selectedIds).map(id => images.find(image => image.id === id) ?? selectedCache.get(id)).filter((image): image is Image => !!image)}
              tool={tool}
              onTool={(next) => {
                setTool(next);
                if (!next) {
                  setToolImages(null);
                  const params = new URLSearchParams(searchParams.toString());
                  params.delete('tool');
                  router.replace(params.size ? `${pathname}?${params}` : pathname, { scroll: false });
                }
              }}
              onClear={() => {
                clearSelection();
                setToolImages(null);
              }}
              folderId={folderId}
              clusterId={clusterId}
              overview={inspectorOverview}
              onSelectIds={(ids) => {
                setToolImages(null);
                setSelectMode(true);
                setSelectedIds(new Set(ids));
              }}
              onSelectStatus={selectStatuses}
              onOpenImage={setOpenImage}
              shortcutsEnabled={!openImage}
              hasBatchRunning={hasBatchRunning}
              onDispatched={() => {
                setMobileInspector(false);
                void queryClient.invalidateQueries({ queryKey: [queryKeyPrefix] });
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
