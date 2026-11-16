'use client';

import LibraryImage from '@/components/LibraryImage';
import { AppendOnlyGrid } from '@/components/ImageGrid';
import ProgressiveImage from '@/components/ProgressiveImage';
import { useImagePixels } from '@/hooks/useImagePixels';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { imagesApi, foldersApi, clustersApi, generationApi } from '@/lib/api';
import { X, Loader2, ChevronLeft, ChevronRight, Maximize2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface PickedImage {
  type: 'gallery' | 'generated';
  id: number;
  previewUrl: string;
  fullUrl?: string;
  largeUrl?: string;
  width?: number;
  height?: number;
}

interface PickerItem {
  id: number;
  type: PickedImage['type'];
  thumbnail: string;
  small?: string;
  medium?: string;
  full: string;
  large?: string;
  width?: number;
  height?: number;
  search?: string;
}

function PickerThumbnail({ item }: { item: PickerItem }) {
  const { host, pixels } = useImagePixels(item.width ?? null, item.height ?? null);
  const variants = [
    { size: 200, url: item.small },
    { size: 400, url: item.medium },
    { size: 800, url: item.large },
  ].filter((variant) => variant.url);
  const high = variants.find((variant) => variant.size >= pixels) || variants[variants.length - 1];
  return (
    <span ref={host} className="block h-full w-full">
      <ProgressiveImage
        src={item.small || item.thumbnail}
        highSrc={pixels > 0 ? high?.url : undefined}
        alt=""
        loading="lazy"
        className="block h-full w-full object-contain"
      />
    </span>
  );
}

interface ImagePickerModalProps {
  open: boolean;
  onClose: () => void;
  onDone: (items: PickedImage[]) => void;
  alreadySelectedIds?: number[];
  alreadySelectedItems?: { type: PickedImage['type']; id: number }[];
  maxSelection?: number;
  startNumber?: number;
}

export default function ImagePickerModal({
  open,
  onClose,
  onDone,
  alreadySelectedIds = [],
  alreadySelectedItems,
  maxSelection = 3,
  startNumber = alreadySelectedIds.length + 1,
}: ImagePickerModalProps) {
  const [source, setSource] = useState<string>();
  const [search, setSearch] = useState('');
  const [folderPage, setFolderPage] = useState(0);
  const [clusterPage, setClusterPage] = useState(0);
  const [tab, setTab] = useState<'gallery' | 'generated'>('gallery');

  // Track selected items with their preview URLs
  const [selected, setSelected] = useState<PickedImage[]>([]);

  // Large preview of one image, stepping through the grid it was opened from
  const [preview, setPreview] = useState<{
    items: PickerItem[];
    index: number;
  } | null>(null);

  // Two-level browse: null = show folders/clusters, number = show images inside
  const [browseFolderId, setBrowseFolderId] = useState<number | null>(null);
  const [browseClusterId, setBrowseClusterId] = useState<number | null>(null);
  const [browseLabel, setBrowseLabel] = useState('');

  const [page, setPage] = useState(0);
  const limit = 40;

  const totalSelected = selected.length;
  const remaining = maxSelection - alreadySelectedIds.length - totalSelected;

  // Level 1: Folders and clusters
  const { data: foldersData, isLoading: foldersLoading } = useQuery({
    queryKey: ['picker-folders', folderPage],
    queryFn: () => foldersApi.list({ skip: folderPage * 40, limit: 40 }),
    enabled: open,
  });

  const { data: clustersData, isLoading: clustersLoading } = useQuery({
    queryKey: ['picker-clusters', clusterPage],
    queryFn: () => clustersApi.list({ skip: clusterPage * 40, limit: 40 }),
    enabled: open,
  });

  // Level 2: Images inside a folder or cluster
  const { data: folderImages, isLoading: folderImagesLoading } = useQuery({
    queryKey: ['picker-folder-images', browseFolderId, page],
    queryFn: () =>
      foldersApi.listImages(browseFolderId!, {
        skip: page * limit,
        limit,
        min_status: 'ingested',
      }),
    enabled: open && tab === 'gallery' && browseFolderId !== null,
  });

  const { data: clusterDetail, isLoading: clusterImagesLoading } = useQuery({
    queryKey: ['picker-cluster-images', browseClusterId, page],
    queryFn: () =>
      clustersApi.getImages(browseClusterId!, {
        skip: page * limit,
        limit: limit + 1,
      }),
    enabled: open && tab === 'gallery' && browseClusterId !== null,
  });

  const { data: libraryData, isLoading: libraryLoading } = useQuery({
    queryKey: ['picker-library', source, page],
    queryFn: () =>
      imagesApi.list({
        source,
        skip: page * limit,
        limit,
        min_status: 'ingested',
      }),
    enabled:
      open &&
      tab === 'gallery' &&
      browseFolderId === null &&
      browseClusterId === null,
  });
  useEffect(() => {
    if (open) {
      setSelected([]);
      setPreview(null);
    }
  }, [open]);

  // Generated tab
  const { data: generatedData, isLoading: generatedLoading } = useQuery({
    queryKey: ['picker-generated', page],
    queryFn: () =>
      generationApi.listImages({
        skip: page * limit,
        limit,
        status: 'completed',
      }),
    enabled: open && tab === 'generated',
  });

  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopImmediatePropagation();
        if (preview) setPreview(null);
        else onClose();
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const step = event.key === 'ArrowLeft' ? -1 : 1;
        setPreview(
          (current) =>
            current && {
              ...current,
              index: Math.min(
                current.items.length - 1,
                Math.max(0, current.index + step)
              ),
            }
        );
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [preview, open, onClose]);

  if (!open) return null;

  const current = preview?.items[preview.index];
  const isInsideCollection =
    browseFolderId !== null || browseClusterId !== null;

  const isAlreadySelected = (id: number, type: PickedImage['type']) =>
    alreadySelectedItems
      ? alreadySelectedItems.some(
          (item) => item.id === id && item.type === type
        )
      : alreadySelectedIds.includes(id);
  const isSelectedId = (id: number, type: PickedImage['type']) =>
    selected.some((s) => s.id === id && s.type === type) ||
    isAlreadySelected(id, type);

  const toggleImage = (
    id: number,
    type: 'gallery' | 'generated',
    thumbUrl: string,
    item?: PickerItem
  ) => {
    if (isAlreadySelected(id, type)) return;
    const existing = selected.find((s) => s.id === id && s.type === type);
    if (existing) {
      setSelected(selected.filter((s) => s !== existing));
    } else if (remaining > 0) {
      setSelected([
        ...selected,
        {
          type,
          id,
          previewUrl: thumbUrl,
          fullUrl: item?.full,
          largeUrl: item?.large,
          width: item?.width,
          height: item?.height,
        },
      ]);
    }
  };

  const handleDone = () => {
    onDone(selected);
    setSelected([]);
    onClose();
  };

  const goBack = () => {
    setBrowseFolderId(null);
    setBrowseClusterId(null);
    setBrowseLabel('');
    setPage(0);
  };

  const openFolder = (id: number, name: string) => {
    setBrowseFolderId(id);
    setBrowseLabel(name);
    setPage(0);
  };

  const openCluster = (id: number, name: string) => {
    setBrowseClusterId(id);
    setBrowseLabel(name);
    setPage(0);
  };

  // Build a thumbnail URL from a URI path
  const galleryThumbUrl = (uri: string | null | undefined) => {
    if (!uri) return '';
    return imagesApi.getThumbnailUrl(uri.split('/').pop() || '');
  };

  const generatedThumbUrl = (uri: string | null | undefined) => {
    if (!uri) return '';
    return generationApi.getThumbnailUrl(uri.split('/').pop() || '');
  };

  const renderTiles = (items: PickerItem[]) => (
    <AppendOnlyGrid
      density="M"
      images={items.filter(
          (item) =>
            !search ||
            `${item.id} ${item.search || ''}`
              .toLowerCase()
              .includes(search.toLowerCase())
        )}
    >
      {(item) => {
        const index = items.indexOf(item);
        const checked = isSelectedId(item.id, item.type);
        return (
          <div className="group relative h-full">
            <button
              onClick={() =>
                toggleImage(item.id, item.type, item.thumbnail, item)
              }
              disabled={!checked && remaining <= 0}
              aria-label={`${checked ? 'Unselect' : 'Select'} image ${item.id}`}
              aria-pressed={checked}
              className={cn(
                'relative h-full w-full rounded-md overflow-hidden border-2 transition-all',
                checked
                  ? 'border-primary ring-2 ring-primary/30'
                  : 'border-transparent hover:border-border',
                !checked && remaining <= 0 && 'opacity-40 cursor-not-allowed'
              )}
            >
              {item.thumbnail ? (
                <PickerThumbnail item={item} />
              ) : (
                <div className="w-full h-full bg-muted/30" />
              )}
              {checked && (
                <div className="absolute inset-0 bg-primary/20 flex items-center justify-center">
                  <span className="rounded-full bg-primary px-2 py-1 text-xs text-primary-foreground">
                    {selected.findIndex(
                      (source) =>
                        source.id === item.id && source.type === item.type
                    ) < 0
                      ? 'Added'
                      : startNumber +
                        selected.findIndex(
                          (source) =>
                            source.id === item.id && source.type === item.type
                        )}
                  </span>
                </div>
              )}
            </button>
            <button
              onClick={() => setPreview({ items, index })}
              aria-label={`View image ${item.id} large`}
              title="View large"
              className="absolute right-1.5 top-1.5 grid h-8 w-8 place-items-center rounded-md bg-black/65 text-white opacity-0 transition-opacity hover:bg-black/80 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
            >
              <Maximize2 className="h-4 w-4" />
            </button>
          </div>
        );
      }}
    </AppendOnlyGrid>
  );

  // Render image grid for level 2 (gallery images in folder/cluster)
  const renderImageGrid = (
    images: Array<{
      id: number;
      object_key: string;
      width?: number | null;
      height?: number | null;
      thumbnail_uri_small?: string | null;
      thumbnail_uri_medium?: string | null;
      thumbnail_uri_large?: string | null;
      filename?: string;
      description?: unknown;
      tags?: unknown;
    }>,
    total: number
  ) => (
    <>
      {renderTiles(
        images.map((img) => ({
          id: img.id,
          type: 'gallery' as const,
          search: JSON.stringify(img),
          thumbnail: galleryThumbUrl(
            img.thumbnail_uri_medium || img.thumbnail_uri_small
          ),
          full: imagesApi.getImageUrl(img.object_key.split('/').pop() || ''),
          small: galleryThumbUrl(img.thumbnail_uri_small),
          medium: galleryThumbUrl(img.thumbnail_uri_medium),
          large: galleryThumbUrl(img.thumbnail_uri_large),
          width: img.width ?? undefined,
          height: img.height ?? undefined,
        }))
      )}
      {total > limit && (
        <div className="flex justify-center gap-2 mt-4">
          <button
            onClick={() => setPage(Math.max(0, page - 1))}
            disabled={page === 0}
            className="px-3 py-1 text-sm border border-border rounded-lg disabled:opacity-50"
          >
            Previous
          </button>
          <span className="px-3 py-1 text-sm text-muted-foreground">
            Page {page + 1} of {Math.ceil(total / limit)}
          </span>
          <button
            onClick={() => setPage(page + 1)}
            disabled={(page + 1) * limit >= total}
            className="px-3 py-1 text-sm border border-border rounded-lg disabled:opacity-50"
          >
            Next
          </button>
        </div>
      )}
    </>
  );

  return (
    <>
      <div className="fixed inset-0 bg-black/70 z-50" onClick={onClose} />
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        onClick={onClose}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Select source images"
          className="mobile-modal bg-card rounded-xl shadow-xl max-w-6xl w-full max-h-[90vh] flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b border-border">
            <div className="flex items-center gap-3">
              {isInsideCollection && (
                <button
                  onClick={goBack}
                  className="p-1 hover:bg-muted rounded-lg transition-colors"
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
              )}
              <h3 className="font-semibold">
                {isInsideCollection ? browseLabel : 'Select Source Images'}
              </h3>
              <span className="text-sm text-muted-foreground">
                {totalSelected + alreadySelectedIds.length}/{maxSelection}{' '}
                selected
              </span>
            </div>
            <button
              autoFocus
              aria-label="Close picker"
              onClick={onClose}
              className="p-1 hover:bg-muted rounded-lg transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="flex min-h-0 flex-1 max-md:flex-col">
            <nav
              aria-label="Image collections"
              className="flex w-52 shrink-0 flex-col gap-1 overflow-y-auto border-r p-2 max-md:w-full max-md:flex-row max-md:overflow-x-auto max-md:border-b max-md:border-r-0"
            >
              {[
                { value: undefined, label: 'All images' },
                { value: 'upload', label: 'Uploads' },
                { value: 'generated', label: 'Generated' },
                { value: 'edited', label: 'Edited' },
              ].map((item) => (
                <button
                  key={item.label}
                  className={cn(
                    'shrink-0 rounded px-3 py-2 text-left text-xs',
                    tab === 'gallery' &&
                      !isInsideCollection &&
                      source === item.value &&
                      'bg-accent'
                  )}
                  onClick={() => {
                    goBack();
                    setTab('gallery');
                    setSource(item.value);
                  }}
                >
                  {item.label}
                </button>
              ))}
              <span className="shrink-0 px-3 py-2 text-xs text-muted-foreground">
                Folders
              </span>
              {foldersLoading ? (
                <span className="text-xs">Loading…</span>
              ) : (
                foldersData?.items.map((folder) => (
                  <button
                    key={folder.id}
                    className={cn(
                      'shrink-0 rounded px-3 py-2 text-left text-xs',
                      browseFolderId === folder.id && 'bg-accent'
                    )}
                    onClick={() => {
                      setTab('gallery');
                      setBrowseClusterId(null);
                      openFolder(folder.id, folder.name);
                    }}
                  >
                    {folder.name} ({folder.image_count})
                  </button>
                ))
              )}
              {foldersData && foldersData.total > 40 && (
                <div className="flex shrink-0 gap-2 px-3 text-xs">
                  {folderPage > 0 && (
                    <button
                      aria-label="Previous folders"
                      onClick={() => setFolderPage(folderPage - 1)}
                    >
                      ←
                    </button>
                  )}
                  {(folderPage + 1) * 40 < foldersData.total && (
                    <button onClick={() => setFolderPage(folderPage + 1)}>
                      More folders →
                    </button>
                  )}
                </div>
              )}
              <span className="shrink-0 px-3 py-2 text-xs text-muted-foreground">
                Clusters
              </span>
              {clustersLoading ? (
                <span className="text-xs">Loading…</span>
              ) : (
                clustersData?.items.map((cluster) => (
                  <button
                    key={cluster.id}
                    className={cn(
                      'shrink-0 rounded px-3 py-2 text-left text-xs',
                      browseClusterId === cluster.id && 'bg-accent'
                    )}
                    onClick={() => {
                      setTab('gallery');
                      setBrowseFolderId(null);
                      openCluster(
                        cluster.id,
                        cluster.display_name ||
                          cluster.summary_title ||
                          `Cluster ${cluster.id}`
                      );
                    }}
                  >
                    {cluster.display_name ||
                      cluster.summary_title ||
                      `Cluster ${cluster.id}`}{' '}
                    ({cluster.size})
                  </button>
                ))
              )}
              {clustersData && clustersData.total > 40 && (
                <div className="flex shrink-0 gap-2 px-3 text-xs">
                  {clusterPage > 0 && (
                    <button
                      aria-label="Previous clusters"
                      onClick={() => setClusterPage(clusterPage - 1)}
                    >
                      ←
                    </button>
                  )}
                  {(clusterPage + 1) * 40 < clustersData.total && (
                    <button onClick={() => setClusterPage(clusterPage + 1)}>
                      More clusters →
                    </button>
                  )}
                </div>
              )}
              <button
                className="shrink-0 rounded px-3 py-2 text-left text-xs"
                onClick={() => {
                  goBack();
                  setTab('generated');
                }}
              >
                Generation history
              </button>
            </nav>
            <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4">
              <input
                aria-label="Search this page"
                placeholder="Search this page…"
                className="mb-2 w-full rounded border bg-background px-3 py-2 text-sm"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <p className="mb-3 text-xs text-muted-foreground">
                Search filters the loaded page.
              </p>
              {(libraryLoading && !isInsideCollection && tab === 'gallery') ||
              (folderImagesLoading && browseFolderId != null) ||
              (clusterImagesLoading && browseClusterId != null) ||
              (generatedLoading && tab === 'generated') ? (
                <Loader2 className="mx-auto h-6 w-6 animate-spin" />
              ) : tab === 'generated' ? (
                <>
                  {renderTiles(
                    (generatedData?.items ?? []).map((img) => ({
                      id: img.id,
                      type: 'generated' as const,
                      thumbnail: generatedThumbUrl(
                        img.thumbnail_uri_medium || img.thumbnail_uri_small
                      ),
                      small: generatedThumbUrl(img.thumbnail_uri_small),
                      medium: generatedThumbUrl(img.thumbnail_uri_medium),
                      full: generationApi.getImageUrl(img.id),
                      width: img.width ?? undefined,
                      height: img.height ?? undefined,
                      search: img.prompt,
                    }))
                  )}
                  <div className="mt-4 flex justify-center gap-4 text-xs">
                    <button disabled={!page} onClick={() => setPage(page - 1)}>
                      Previous
                    </button>
                    <span>Page {page + 1}</span>
                    <button
                      disabled={
                        !generatedData ||
                        (page + 1) * limit >= generatedData.total
                      }
                      onClick={() => setPage(page + 1)}
                    >
                      Next
                    </button>
                  </div>
                </>
              ) : browseFolderId != null ? (
                renderImageGrid(
                  folderImages?.items ?? [],
                  folderImages?.total ?? 0
                )
              ) : browseClusterId != null ? (
                renderImageGrid(
                  (clusterDetail ?? []).slice(0, limit),
                  (clusterDetail?.length ?? 0) > limit
                    ? (page + 2) * limit
                    : (page + 1) * limit
                )
              ) : (
                renderImageGrid(
                  libraryData?.items ?? [],
                  libraryData?.total ?? 0
                )
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="mobile-modal-actions flex justify-end gap-3 p-4 border-t border-border">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm border border-border rounded-lg hover:bg-muted transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleDone}
              disabled={totalSelected === 0}
              className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors font-medium disabled:opacity-50"
            >
              Add {totalSelected} as sources
            </button>
          </div>
        </div>
      </div>

      {current && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Image preview"
          className="fixed inset-0 z-[60] flex flex-col bg-black text-white"
        >
          <div className="flex items-center justify-between p-3">
            <span className="text-sm text-white/70">
              {preview!.index + 1} of {preview!.items.length}
            </span>
            <button
              aria-label="Close preview"
              onClick={() => setPreview(null)}
              className="grid h-10 w-10 place-items-center rounded-md hover:bg-white/10"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="relative min-h-0 flex-1">
            {/* The thumbnail shows at once; the full image loads over it. */}
            {current.thumbnail && (
              <LibraryImage
                src={current.thumbnail}
                alt=""
                className="absolute inset-0 h-full w-full object-contain"
              />
            )}
            <LibraryImage
              key={current.full}
              src={current.full}
              alt={`Image ${current.id}`}
              className="absolute inset-0 h-full w-full object-contain"
            />
            <button
              aria-label="Previous image"
              disabled={preview!.index === 0}
              onClick={() =>
                setPreview({ ...preview!, index: preview!.index - 1 })
              }
              className="absolute left-2 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-black/50 hover:bg-black/70 disabled:opacity-30"
            >
              <ChevronLeft className="h-6 w-6" />
            </button>
            <button
              aria-label="Next image"
              disabled={preview!.index === preview!.items.length - 1}
              onClick={() =>
                setPreview({ ...preview!, index: preview!.index + 1 })
              }
              className="absolute right-2 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-black/50 hover:bg-black/70 disabled:opacity-30"
            >
              <ChevronRight className="h-6 w-6" />
            </button>
          </div>
          <div className="flex items-center justify-end gap-3 p-3 pb-[max(12px,env(safe-area-inset-bottom))]">
            {isAlreadySelected(current.id, current.type) ? (
              <span className="text-sm text-white/70">Already added</span>
            ) : (
              <button
                onClick={() =>
                  toggleImage(
                    current.id,
                    current.type,
                    current.thumbnail,
                    current
                  )
                }
                disabled={
                  !isSelectedId(current.id, current.type) && remaining <= 0
                }
                className="min-h-10 rounded-lg border border-white/30 px-4 text-sm hover:bg-white/10 disabled:opacity-40"
              >
                {isSelectedId(current.id, current.type) ? 'Unselect' : 'Select'}
              </button>
            )}
            <button
              onClick={() => {
                setPreview(null);
                handleDone();
              }}
              disabled={totalSelected === 0}
              className="min-h-10 rounded-lg bg-white px-4 text-sm font-medium text-black disabled:opacity-40"
            >
              Add {totalSelected} as sources
            </button>
          </div>
        </div>
      )}
    </>
  );
}
