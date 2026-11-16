'use client';

import ImageDeleteWarning from './ImageDeleteWarning';
import { clearDeleting, markDeleting } from '@/lib/deletingImages';

import { useMobileSheet } from '@/hooks/useMobileSheet';
import LibraryImage from '@/components/LibraryImage';

import Link from 'next/link';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import {
  FileText,
  FolderMinus,
  FolderOpen,
  FolderPlus,
  Image as ImageIcon,
  Info,
  LayoutGrid,
  MinusCircle,
  PanelRightClose,
  Play,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { billingApi, clustersApi, foldersApi, imagesApi, jobsApi, settingsApi } from '@/lib/api';
import { useModelCatalog } from '@/hooks/useModelCatalog';
import { cn } from '@/lib/utils';
import type { ClusterRunParams, Image, ScopeStats } from '@/types';
import ModelPicker from './ModelPicker';

/** Organizing actions the library inspector offers. Creation lives in Tools. */
export type InspectorTool =
  | 'Describe'
  | 'Cluster'
  | 'Add to folder'
  | 'Remove from folder'
  | 'Exclude from cluster'
  | 'Delete';
/** Actions the image drawer can hand off: inspector tools plus links into Tools. */
export type ImageAction = InspectorTool | 'Edit' | 'Ask Vision';

export const thumbnail = (image: Image) => {
  if (image.thumbnail_url) return image.thumbnail_url;
  const uri = image.thumbnail_uri_small || image.thumbnail_uri_medium;
  return uri ? imagesApi.getThumbnailUrl(uri.split('/').pop()!) : imagesApi.getImageUrl(image.object_key);
};

const field = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm';
const DESCRIBED = new Set(['described', 'embedded', 'clustered']);
const EMBEDDED = new Set(['embedded', 'clustered']);
const TOOL_TITLES: Record<InspectorTool, string> = {
  Describe: 'Describe these images',
  Cluster: 'Cluster these images',
  'Add to folder': 'Add to folder',
  'Remove from folder': 'Remove from this folder',
  'Exclude from cluster': 'Exclude from cluster',
  Delete: 'Delete from library',
};

const n = (value: number) => value.toLocaleString();
const pct = (part: number, whole: number) => `${Math.round((part / Math.max(whole, 1)) * 100)}%`;
const formatBytes = (bytes: number) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes >= 1e6 ? `${Math.round(bytes / 1e6)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
const formatDate = (value: string | null) =>
  value ? new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const plural = (count: number, word: string) => `${n(count)} ${word}${count === 1 ? '' : 's'}`;

function Label({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {children}
      </span>
      {right}
    </div>
  );
}

function Section({ label, right, children }: { label: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2.5">
      <Label right={right}>{label}</Label>
      {children}
    </section>
  );
}

function Meter({ label, value, total, tone = 'selection' }: { label: string; value: number; total: number; tone?: 'selection' | 'success' | 'warning' }) {
  return (
    <div>
      <div className="mb-1.5 flex justify-between text-xs">
        <span>{label}</span>
        <span className="font-mono text-[11.5px] tabular-nums text-muted-foreground">
          {n(value)} / {n(total)}
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded bg-muted">
        <div
          className={cn('h-1 rounded', tone === 'success' ? 'bg-success' : tone === 'warning' ? 'bg-warning' : 'bg-selection')}
          style={{ width: pct(value, total) }}
        />
      </div>
    </div>
  );
}

function Kpis({ items }: { items: [string, string][] }) {
  return (
    <div className="grid grid-cols-3 rounded-lg border border-border">
      {items.map(([value, label], i) => (
        <div key={label} className={cn('px-2.5 py-2', i > 0 && 'border-l border-border')}>
          <p className="text-[17px] font-semibold tabular-nums tracking-tight">{value}</p>
          <p className="text-[11.5px] text-muted-foreground">{label}</p>
        </div>
      ))}
    </div>
  );
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="space-y-1.5">
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-3 text-[12.5px]">
          <dt className="whitespace-nowrap text-muted-foreground">{label}</dt>
          <dd className="min-w-0 text-right tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Chips({ items }: { items: { tag: string; count?: number }[] }) {
  if (!items.length) return <p className="text-xs text-muted-foreground">No tags yet</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map(({ tag, count }) => (
        <span key={tag} className="rounded-md bg-muted px-2 py-0.5 text-xs">
          {tag}
          {count != null && <span className="ml-1.5 font-mono text-[10.5px] text-muted-foreground">{count}</span>}
        </span>
      ))}
    </div>
  );
}

const SWATCHES = ['bg-[#5b7cfa]', 'bg-[#22b8cf]', 'bg-[#94d82d]', 'bg-[#fcc419]', 'bg-[#f06595]', 'bg-[#a78bfa]', 'bg-[#ff922b]', 'bg-[#20c997]'];

function Breakdown({ rows, rest, restLabel, hrefFor }: { rows: { id: number; name: string; count: number }[]; rest: number; restLabel: string; hrefFor: (id: number) => string }) {
  const total = rows.reduce((sum, row) => sum + row.count, 0) + rest;
  if (!total) return null;
  return (
    <>
      <div className="flex h-2 gap-0.5 overflow-hidden rounded">
        {rows.map((row, i) => (
          <i key={row.id} className={SWATCHES[i % SWATCHES.length]} style={{ flex: row.count }} />
        ))}
        {rest > 0 && <i className="bg-muted" style={{ flex: rest }} />}
      </div>
      <ul className="space-y-1">
        {rows.map((row, i) => (
          <li key={row.id} className="flex items-center gap-2 text-[12.5px]">
            <span className={cn('h-2 w-2 shrink-0 rounded-sm', SWATCHES[i % SWATCHES.length])} />
            <Link href={hrefFor(row.id)} className="truncate hover:underline">{row.name}</Link>
            <span className="ml-auto font-mono text-[11.5px] tabular-nums text-muted-foreground">{row.count}</span>
          </li>
        ))}
        {rest > 0 && (
          <li className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
            <span className="h-2 w-2 shrink-0 rounded-sm bg-muted ring-1 ring-border" />
            {restLabel}
            <span className="ml-auto font-mono text-[11.5px] tabular-nums">{rest}</span>
          </li>
        )}
      </ul>
    </>
  );
}

function Attention({ text, action, onAction }: { text: string; action?: string; onAction?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-danger/25 bg-danger/5 px-2.5 py-1.5 text-xs text-danger">
      <span>{text}</span>
      {action && onAction && (
        <button onClick={onAction} className="font-medium text-foreground hover:underline">
          {action}
        </button>
      )}
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2 rounded-md bg-muted px-2.5 py-2 text-xs text-muted-foreground">
      <Info className="mt-px h-3.5 w-3.5 shrink-0" />
      <p>{children}</p>
    </div>
  );
}

function ScopeOverview({ stats, folderId, clusterId, onClusterFolder, onSelectStatus }: {
  stats: ScopeStats;
  folderId?: number;
  clusterId?: number;
  onClusterFolder?: () => void;
  onSelectStatus: (statuses: string[]) => void;
}) {
  const problems = [
    stats.failed && `${n(stats.failed)} failed`,
    stats.not_described && `${n(stats.not_described)} not described`,
    stats.pending && `${n(stats.pending)} processing`,
  ].filter(Boolean).join(' · ');
  const landscapeShare = pct(stats.orientation.landscape, stats.total);
  const portraitShare = pct(stats.orientation.portrait, stats.total);
  return (
    <>
      <Kpis
        items={
          clusterId
            ? [[n(stats.total), 'images'], [n(stats.folder_count), 'folders'], [n(stats.cluster_count), 'other clusters']]
            : folderId
              ? [[n(stats.total), 'images'], [n(stats.cluster_count), 'clusters'], [formatBytes(stats.total_bytes), 'on disk']]
              : [[n(stats.total), 'images'], [n(stats.folder_count), 'folders'], [n(stats.cluster_count), 'clusters']]
        }
      />
      <Section label="Processing">
        <Meter label="Tagged" value={stats.tagged} total={stats.total} tone="success" />
        <Meter label="Described" value={stats.described} total={stats.total} tone="success" />
        {!clusterId && <Meter label="In a cluster" value={stats.in_cluster} total={stats.total} />}
        {problems && (
          <Attention
            text={problems}
            action={stats.not_described ? 'Show not described' : stats.failed ? 'Show failed' : undefined}
            onAction={() => onSelectStatus(stats.not_described ? ['not_described'] : ['failed'])}
          />
        )}
      </Section>
      {folderId && onClusterFolder && (
        <Section label="Clustering">
          <p className="text-xs text-muted-foreground">
            Group this folder&apos;s images by similarity. New clusters are added next to your existing ones.
          </p>
          <button
            onClick={onClusterFolder}
            className="flex h-[34px] w-full items-center justify-center gap-2 rounded-md bg-primary text-[13px] font-medium text-primary-foreground hover:opacity-90"
          >
            <LayoutGrid className="h-4 w-4" />
            Cluster this folder…
          </button>
        </Section>
      )}
      {!clusterId && stats.in_cluster > 0 && (
        <Section label={folderId ? 'Clusters in this folder' : 'Largest clusters'}>
          <Breakdown
            rows={stats.clusters}
            rest={Math.max(0, stats.total - stats.in_cluster)}
            restLabel="Not in a cluster"
            hrefFor={(id) => `/clusters/${id}`}
          />
        </Section>
      )}
      {clusterId && (
        <Section label="In your folders">
          <Breakdown
            rows={stats.folders}
            rest={Math.max(0, stats.total - stats.in_folder)}
            restLabel="Not in a folder"
            hrefFor={(id) => `/images/folder/${id}`}
          />
        </Section>
      )}
      {!folderId && !clusterId && (
        <Section label="Organization">
          <Meter label="In at least one folder" value={stats.in_folder} total={stats.total} />
          <p className="text-xs text-muted-foreground">{n(stats.total - stats.in_folder)} images are not in any folder.</p>
        </Section>
      )}
      <Section label={clusterId ? 'Defining tags' : 'Top tags'}>
        <Chips items={stats.top_tags.slice(0, 8)} />
      </Section>
      <Section label="About">
        <Facts
          rows={[
            ['Source', `${n(stats.sources.upload)} uploads · ${n(stats.sources.generated)} generated · ${n(stats.sources.edited)} edited`],
            ['Orientation', `${portraitShare} portrait · ${landscapeShare} landscape`],
            ['Added', stats.first_added ? `${formatDate(stats.first_added)} – ${formatDate(stats.last_added)}` : '—'],
            ...(folderId && stats.in_other_folders != null ? [['Also in other folders', plural(stats.in_other_folders, 'image')] as [string, ReactNode]] : []),
            ...(!folderId && !clusterId ? [['Added last 7 / 30 days', `${n(stats.added_7d)} / ${n(stats.added_30d)}`] as [string, ReactNode]] : []),
            ...(!clusterId ? [] : [['Size on disk', formatBytes(stats.total_bytes)] as [string, ReactNode]]),
          ]}
        />
      </Section>
    </>
  );
}

function SelectionOverview({ images, onSelectOnly, onOpenImage }: { images: Image[]; onSelectOnly: (ids: number[]) => void; onOpenImage?: (image: Image) => void }) {
  const described = images.filter((i) => DESCRIBED.has(i.status)).length;
  const failed = images.filter((i) => i.status === 'failed');
  const tags = useMemo(() => {
    const counts = new Map<string, number>();
    images.forEach((image) => new Set(image.metadata?.tags ?? []).forEach((tag) => counts.set(tag, (counts.get(tag) ?? 0) + 1)));
    return Array.from(counts, ([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count).slice(0, 8);
  }, [images]);
  const generated = images.filter((i) => i.source === 'generated').length;
  const edited = images.filter((i) => i.source === 'edited').length;
  const bytes = images.reduce((sum, i) => sum + (i.file_size ?? 0), 0);

  if (images.length === 1) {
    const [image] = images;
    return (
      <>
        <button type="button" onClick={() => onOpenImage?.(image)} className="block w-full overflow-hidden rounded-md bg-muted">
          <LibraryImage src={thumbnail(image)} alt="" className="max-h-64 w-full object-contain" />
        </button>
        <Facts
          rows={[
            ['Status', <span key="s" className={cn('capitalize', image.status === 'failed' ? 'text-danger' : DESCRIBED.has(image.status) ? 'text-success' : 'text-warning')}>{image.status}</span>],
            ['Size', `${image.width && image.height ? `${image.width} × ${image.height}` : '—'}${image.file_size ? ` · ${formatBytes(image.file_size)}` : ''}`],
            ['Source', `${image.source === 'upload' ? 'Upload' : image.source} · ${formatDate(image.created_at)}`],
            ['File', <span key="f" className="block truncate">{image.original_filename || `Image ${image.id}`}</span>],
          ]}
        />
        <Section label="Tags">
          <Chips items={(image.metadata?.tags ?? []).slice(0, 12).map((tag) => ({ tag }))} />
        </Section>
        <Section label="Description">
          <p className="line-clamp-5 text-[12.5px] text-muted-foreground">
            {image.metadata?.description_long || 'Not described yet.'}
          </p>
          {onOpenImage && (
            <button onClick={() => onOpenImage(image)} className="text-[12.5px] font-medium text-selection hover:underline">
              Open full details
            </button>
          )}
        </Section>
      </>
    );
  }

  return (
    <>
      <div className="flex items-center gap-1">
        {images.slice(0, 6).map((image) => (
          <LibraryImage key={image.id} src={thumbnail(image)} alt="" className="h-10 w-10 rounded object-cover" />
        ))}
        {images.length > 6 && <span className="ml-1 text-xs text-muted-foreground">+{images.length - 6}</span>}
      </div>
      <Section label="Processing">
        <Meter label="Described" value={described} total={images.length} tone="success" />
        {failed.length > 0 && (
          <Attention text={`${plural(failed.length, 'image')} failed`} action="Select only these" onAction={() => onSelectOnly(failed.map((i) => i.id))} />
        )}
      </Section>
      <Section label="Shared tags">
        <Chips items={tags} />
      </Section>
      <Section label="About">
        <Facts
          rows={[
            ['Source', `${n(images.length - generated - edited)} uploads · ${n(generated)} generated · ${n(edited)} edited`],
            ['Total size', bytes ? formatBytes(bytes) : '—'],
          ]}
        />
      </Section>
    </>
  );
}

function ActionButton({ icon: Icon, label, shortcut, onClick, danger, disabled, title }: { icon: LucideIcon; label: string; shortcut: string; onClick: () => void; danger?: boolean; disabled?: boolean; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'flex h-[34px] w-full items-center gap-2 rounded-md border border-border px-2.5 text-[13px] font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50',
        danger && 'text-danger'
      )}
    >
      <Icon className={cn('h-4 w-4', danger ? 'text-danger' : 'text-muted-foreground')} />
      {label}
      <kbd className="ml-auto rounded border border-border px-1.5 font-mono text-[10.5px] text-muted-foreground">{shortcut}</kbd>
    </button>
  );
}

type ClusterMethod = 'hdbscan' | 'kmeans' | 'graph';
const METHODS: { key: ClusterMethod; label: string; hint: string }[] = [
  { key: 'hdbscan', label: 'HDBSCAN', hint: 'Finds the number of groups' },
  { key: 'kmeans', label: 'K-Means', hint: 'Up to a maximum you set' },
  { key: 'graph', label: 'Graph', hint: 'Groups by similarity links' },
];

export default function Inspector({
  title,
  total,
  images,
  tool,
  onTool,
  onClear,
  folderId,
  hasBatchRunning,
  onDispatched,
  onDismiss,
  onHide,
  clusterId,
  overview,
  onSelectIds,
  onSelectStatus,
  onOpenImage,
  shortcutsEnabled = true,
}: {
  clusterId?: number;
  overview?: ReactNode;
  title: string;
  total: number;
  images: Image[];
  tool: InspectorTool | null;
  onTool: (tool: InspectorTool | null) => void;
  onClear: () => void;
  folderId?: number;
  hasBatchRunning: boolean;
  onDispatched: () => void;
  onDismiss?: () => void;
  onHide?: () => void;
  /** Replace the selection with these ids. */
  onSelectIds: (ids: number[]) => void;
  /** Filter the grid to these images (['failed'] or ['not_described']) and enter select mode. */
  onSelectStatus: (statuses: string[]) => void;
  onOpenImage?: (image: Image) => void;
  shortcutsEnabled?: boolean;
}) {
  const sheet = useMobileSheet(!!onDismiss, () => onDismiss?.());
  const [swipeY, setSwipeY] = useState(0);
  const router = useRouter();
  const client = useQueryClient();
  const { data: catalog } = useModelCatalog();
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [describeAll, setDescribeAll] = useState(false);
  // Vision model for this describe run; empty = the default from Settings.
  const [describeModel, setDescribeModel] = useState('');
  const [method, setMethod] = useState<ClusterMethod>('hdbscan');
  const [minSize, setMinSize] = useState(5);
  const [maxClusters, setMaxClusters] = useState(8);
  const folderScope = tool === 'Cluster' && !images.length && !!folderId;

  const { data: stats } = useQuery({
    queryKey: ['scope-stats', folderId ?? null, clusterId ?? null],
    queryFn: () => imagesApi.getScopeStats({ folder_id: folderId, cluster_id: clusterId }),
    enabled: !images.length || folderScope,
  });
  const { data: folders } = useQuery({
    queryKey: ['folders', 'inspector'],
    queryFn: () => foldersApi.list({ limit: 200 }),
    enabled: tool === 'Add to folder',
  });
  const { data: visionCosts } = useQuery({
    queryKey: ['vision-costs', 'inspector'],
    queryFn: billingApi.getVisionCosts,
    enabled: tool === 'Describe',
  });
  const { data: providerConfig } = useQuery({
    queryKey: ['provider-config'],
    queryFn: settingsApi.getProviderConfig,
    enabled: tool === 'Describe',
  });
  const { data: clusteringConfig } = useQuery({
    queryKey: ['clustering-config'],
    queryFn: settingsApi.getClusteringConfig,
    enabled: tool === 'Cluster',
  });

  const missing = images.filter((i) => !DESCRIBED.has(i.status));
  const describeTargets = describeAll ? images : missing;
  const clusterCount = folderScope ? (stats?.embedded ?? 0) : images.filter((i) => EMBEDDED.has(i.status)).length;
  const clusterTotal = folderScope ? (stats?.total ?? total) : images.length;

  useEffect(() => {
    setName('');
    setFolder('');
    // Default to the missing ones; if everything is described, re-describe all.
    setDescribeAll(tool === 'Describe' && missing.length === 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);
  useEffect(() => {
    if (tool !== 'Cluster') return;
    const saved = clusteringConfig as { method?: string; hdbscan_min_cluster_size?: number; kmeans_max_clusters?: number } | undefined;
    setMethod((['hdbscan', 'kmeans', 'graph'].includes(saved?.method ?? '') ? saved!.method : 'hdbscan') as ClusterMethod);
    // Small sets need a smaller minimum, or HDBSCAN leaves everything unclustered.
    setMinSize(Math.max(2, Math.min(saved?.hdbscan_min_cluster_size ?? 15, Math.round(clusterCount / 6) || 2)));
    setMaxClusters(Math.max(2, Math.min(saved?.kmeans_max_clusters ?? 50, Math.floor(clusterCount / 3) || 2)));
  }, [tool, clusteringConfig, clusterCount]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && tool) {
        e.stopImmediatePropagation();
        onTool(null);
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [tool, onTool]);

  // Single-key shortcuts for the selection actions.
  useEffect(() => {
    if (!images.length || tool || !shortcutsEnabled) return;
    const key = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const map: Record<string, InspectorTool | undefined> = {
        d: 'Describe',
        c: images.length >= 2 ? 'Cluster' : undefined,
        f: 'Add to folder',
        r: folderId ? 'Remove from folder' : undefined,
        e: clusterId ? 'Exclude from cluster' : undefined,
        Delete: 'Delete',
        Backspace: 'Delete',
      };
      const next = map[e.key.length === 1 ? e.key.toLowerCase() : e.key];
      if (next) {
        e.preventDefault();
        onTool(next);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [images.length, tool, shortcutsEnabled, folderId, clusterId, onTool]);

  const invalid =
    (tool === 'Describe' && (hasBatchRunning || !describeTargets.length)) ||
    (tool === 'Cluster' && clusterCount < 2) ||
    (tool === 'Add to folder' && !folder && !name.trim()) ||
    (tool !== 'Cluster' && !!tool && !images.length);

  const dispatch = () => {
    if (!tool || invalid) return;
    const action = tool;
    const ids = (action === 'Describe' ? describeTargets : images).map((i) => i.id);
    const params: ClusterRunParams =
      method === 'hdbscan' ? { method, hdbscan_min_cluster_size: minSize }
        : method === 'kmeans' ? { method, kmeans_max_clusters: maxClusters }
          : { method };
    onTool(null);
    onClear();
    onDispatched();
    const notice = toast.loading(
      action === 'Describe' ? `Describing ${plural(ids.length, 'image')}` : action === 'Cluster' ? `Clustering ${plural(clusterCount, 'image')}` : `${TOOL_TITLES[action]}…`,
      { action: { label: 'View Jobs', onClick: () => router.push('/jobs') } }
    );
    void (async () => {
      switch (action) {
        case 'Describe':
          await jobsApi.reprocessSelected(ids, describeModel || undefined);
          break;
        case 'Cluster':
          await clustersApi.clusterImages(folderScope ? { folder_id: folderId, params } : { image_ids: ids, params });
          break;
        case 'Add to folder': {
          const id = name.trim() ? (await foldersApi.create({ name: name.trim() })).id : Number(folder);
          await foldersApi.addImages(id, ids);
          break;
        }
        case 'Remove from folder':
          await foldersApi.removeImages(folderId!, ids);
          break;
        case 'Exclude from cluster':
          await Promise.all(ids.map((id) => clustersApi.excludeImage(clusterId!, id)));
          break;
        case 'Delete':
          markDeleting(ids);
          await imagesApi.batchDelete(ids);
          break;
      }
      const background = action === 'Describe' || action === 'Cluster' || action === 'Delete';
      toast.success(
        action === 'Describe' ? 'Describe job started' : action === 'Cluster' ? 'Clustering started. New clusters appear in Clusters when it finishes.' : `${TOOL_TITLES[action]}: done`,
        { id: notice, ...(background ? { action: { label: 'View Jobs', onClick: () => router.push('/jobs') } } : {}) }
      );
      await client.invalidateQueries();
    })().catch((error: Error) => {
      if (action === 'Delete') clearDeleting();
      toast.error(`${TOOL_TITLES[action]} failed: ${error.message}`, { id: notice });
    });
  };

  const defaultVisionModel = providerConfig?.fal_vision_model || catalog?.defaults.vision_model;
  const visionModel = describeModel || defaultVisionModel;
  const languageCost = visionModel ? visionCosts?.costs.fal?.[visionModel] : undefined;
  const cost = tool === 'Describe' && languageCost ? languageCost.total * describeTargets.length : undefined;
  const ScopeIcon = clusterId ? LayoutGrid : folderId ? FolderOpen : ImageIcon;
  const heading = tool ? TOOL_TITLES[tool] : images.length === 1 ? 'Image' : images.length ? `${n(images.length)} selected` : title;
  const submitLabel =
    tool === 'Describe' ? `Describe ${plural(describeTargets.length, 'image')}`
      : tool === 'Cluster' ? `Cluster ${plural(clusterCount, 'image')}`
        : tool === 'Add to folder' ? 'Add to folder'
          : tool === 'Remove from folder' ? `Remove ${plural(images.length, 'image')}`
            : tool === 'Exclude from cluster' ? `Exclude ${plural(images.length, 'image')}`
              : `Delete ${plural(images.length, 'image')}`;

  return (
    <aside
      ref={sheet}
      role={onDismiss ? 'dialog' : undefined}
      aria-modal={onDismiss ? true : undefined}
      aria-label="Inspector"
      className="flex h-full min-h-[500px] w-full flex-col border-l border-border bg-background"
    >
      <header
        onTouchStart={(e) => setSwipeY(e.touches[0].clientY)}
        onTouchEnd={(e) => {
          if (e.changedTouches[0].clientY - swipeY > 80 && window.innerWidth < 768) onDismiss?.();
        }}
        className="flex items-center justify-between gap-2 border-b border-border p-4"
      >
        <h2 className="flex min-w-0 flex-1 items-center gap-2 font-medium">
          {!images.length && !tool && <ScopeIcon className="h-4 w-4 shrink-0 text-muted-foreground" />}
          <span className="truncate">{heading}</span>
        </h2>
        <div className="flex shrink-0 items-center gap-1">
          {tool ? (
            <button aria-label="Close tool" onClick={() => onTool(null)} className="rounded p-1 hover:bg-accent">
              <X className="h-4 w-4" />
            </button>
          ) : images.length ? (
            <button onClick={onClear} className="rounded px-1.5 py-1 text-[13px] hover:bg-accent">
              Clear
            </button>
          ) : (
            <span className="font-mono text-[11px] text-muted-foreground">
              {clusterId ? 'Cluster' : folderId ? 'Folder' : 'Library'}
            </span>
          )}
          {onDismiss && (
            <button aria-label="Close inspector" onClick={onDismiss} className="rounded p-1 hover:bg-accent">
              <X className="h-4 w-4" />
            </button>
          )}
          {onHide && (
            <button
              type="button"
              aria-label="Hide inspector"
              title="Hide inspector"
              aria-expanded={true}
              onClick={onHide}
              className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <PanelRightClose className="h-4 w-4" />
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 space-y-5 overflow-y-auto p-4 text-[13px]">
        {!tool && !images.length && (
          <>
            {overview}
            {stats ? (
              <ScopeOverview
                stats={stats}
                folderId={folderId}
                clusterId={clusterId}
                onClusterFolder={folderId ? () => onTool('Cluster') : undefined}
                onSelectStatus={onSelectStatus}
              />
            ) : (
              <p className="text-muted-foreground">{n(total)} images in this view</p>
            )}
          </>
        )}

        {!tool && !!images.length && (
          <SelectionOverview images={images} onSelectOnly={onSelectIds} onOpenImage={onOpenImage} />
        )}

        {tool === 'Describe' && (
          <>
            <Note>
              <b className="font-medium text-foreground">{n(images.length - missing.length)} of {n(images.length)}</b> already have tags and a description.
            </Note>
            <fieldset className="space-y-1.5">
              <legend className="mb-1.5 text-[12.5px] font-medium">Which images</legend>
              {[
                { all: false, label: 'Only images not described yet', hint: plural(missing.length, 'image') },
                { all: true, label: `All ${n(images.length)} selected`, hint: 'Replaces existing tags and descriptions' },
              ].map((option) => (
                <label key={String(option.all)} className={cn('flex cursor-pointer gap-2 rounded-md border px-2.5 py-2', describeAll === option.all ? 'border-foreground ring-1 ring-foreground' : 'border-border')}>
                  <input type="radio" name="describe-scope" className="mt-0.5" checked={describeAll === option.all} onChange={() => setDescribeAll(option.all)} />
                  <span className="flex flex-col">
                    {option.label}
                    <span className="text-[11.5px] text-muted-foreground">{option.hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <div className="space-y-1.5">
              <span className="text-[12.5px] font-medium">Vision model</span>
              <ModelPicker
                models={(catalog?.language ?? [])
                  .filter((m) => m.capabilities.includes('vision'))
                  .map((m) => ({
                    id: m.id,
                    label: m.id === defaultVisionModel ? `${m.label} (default)` : m.label,
                    provider: m.vendor,
                    cost: visionCosts?.costs.fal?.[m.id]?.total,
                  }))}
                value={visionModel ?? ''}
                onChange={(id) => setDescribeModel(id === defaultVisionModel ? '' : id)}
              />
              <p className="text-[11.5px] text-muted-foreground">
                If a model declines or fails some images, select the failed ones and try another model.
              </p>
            </div>
            <Facts rows={[['Steps', 'Tag → describe → embed']]} />
            <Note>
              {hasBatchRunning
                ? 'A describe job is already running. Wait for it to finish before starting another.'
                : 'Runs in the background as a Job. Clusters don’t change; cluster these images again afterwards to regroup them.'}
            </Note>
          </>
        )}

        {tool === 'Cluster' && (
          <>
            <Note>
              <b className="font-medium text-foreground">{n(clusterCount)} of {n(clusterTotal)} images</b> will be clustered.
              {clusterTotal - clusterCount > 0 && ` ${n(clusterTotal - clusterCount)} have no embedding yet (not described or failed) and are skipped.`}
            </Note>
            <fieldset className="space-y-1.5">
              <legend className="mb-1.5 text-[12.5px] font-medium">Method</legend>
              <div className="grid grid-cols-1 gap-1.5">
                {METHODS.map((m) => (
                  <label key={m.key} className={cn('flex cursor-pointer gap-2 rounded-md border px-2.5 py-2', method === m.key ? 'border-foreground ring-1 ring-foreground' : 'border-border')}>
                    <input type="radio" name="cluster-method" className="mt-0.5" checked={method === m.key} onChange={() => setMethod(m.key)} />
                    <span className="flex flex-col">
                      {m.label}
                      <span className="text-[11.5px] text-muted-foreground">{m.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            {method === 'hdbscan' && (
              <label className="block space-y-1.5">
                <span className="text-[12.5px] font-medium">Minimum images per cluster</span>
                <input id="cluster-min-size" type="number" min={2} max={Math.max(2, clusterCount)} value={minSize} onChange={(e) => setMinSize(Math.max(2, Number(e.target.value) || 2))} className={field} />
              </label>
            )}
            {method === 'kmeans' && (
              <label className="block space-y-1.5">
                <span className="text-[12.5px] font-medium">Maximum clusters</span>
                <input id="cluster-max" type="number" min={2} max={50} value={maxClusters} onChange={(e) => setMaxClusters(Math.max(2, Math.min(50, Number(e.target.value) || 2)))} className={field} />
              </label>
            )}
            <Note>
              The new clusters appear on the Clusters page next to your existing ones. <b className="font-medium text-foreground">Existing clusters stay.</b> Titles and summaries are written automatically. Other settings (UMAP, selection method) come from Settings.
            </Note>
          </>
        )}

        {tool === 'Add to folder' && (
          <>
            <label className="block space-y-2">
              <span>Existing folder</span>
              <select
                className={field}
                value={folder}
                onChange={(e) => {
                  setFolder(e.target.value);
                  setName('');
                }}
              >
                <option value="">Choose folder</option>
                {folders?.items.filter((f) => f.id !== folderId).map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-2">
              <span>Or create a new folder</span>
              <input id="new-folder-name" className={field} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
          </>
        )}
        {tool === 'Remove from folder' && (
          <p>Remove {plural(images.length, 'image')} from this folder? They stay in your library and in other folders.</p>
        )}
        {tool === 'Exclude from cluster' && (
          <p>Exclude {plural(images.length, 'image')} from this cluster? They stay in your library and folders.</p>
        )}
        {tool === 'Delete' && (
          <>
            <ImageDeleteWarning imageIds={images.map((image) => image.id)} />
            <p className="text-danger">
              Permanently delete {plural(images.length, 'image')} from the library, folders and clusters? This cannot be undone.
            </p>
          </>
        )}
      </div>

      {!tool && !!images.length && (
        <footer className="space-y-1.5 border-t border-border bg-background px-4 py-3">
          <ActionButton
            icon={FileText}
            label="Describe these images…"
            shortcut="D"
            onClick={() => onTool('Describe')}
            disabled={hasBatchRunning}
            title={hasBatchRunning ? 'A describe job is already running' : undefined}
          />
          <ActionButton
            icon={LayoutGrid}
            label="Cluster these images…"
            shortcut="C"
            onClick={() => onTool('Cluster')}
            disabled={images.length < 2}
            title={images.length < 2 ? 'Select at least 2 images' : undefined}
          />
          <ActionButton icon={FolderPlus} label="Add to folder…" shortcut="F" onClick={() => onTool('Add to folder')} />
          {folderId && <ActionButton icon={FolderMinus} label="Remove from this folder" shortcut="R" onClick={() => onTool('Remove from folder')} />}
          {clusterId && <ActionButton icon={MinusCircle} label="Exclude from cluster" shortcut="E" onClick={() => onTool('Exclude from cluster')} />}
          <ActionButton icon={Trash2} label="Delete from library…" shortcut="⌫" onClick={() => onTool('Delete')} danger />
        </footer>
      )}

      {tool && (
        <footer className="space-y-2 border-t border-border bg-background p-4">
          {cost != null && (
            <p className="text-xs text-warning">≈ {cost.toFixed(2)} sparks (typical image size)</p>
          )}
          <button
            disabled={!!invalid}
            onClick={dispatch}
            className={cn(
              'flex h-[34px] w-full items-center justify-center gap-2 rounded-md text-[13px] font-medium disabled:opacity-40',
              tool === 'Delete' ? 'bg-danger text-white' : 'bg-primary text-primary-foreground'
            )}
          >
            {(tool === 'Describe' || tool === 'Cluster') && <Play className="h-3.5 w-3.5" />}
            {submitLabel}
          </button>
          <button onClick={() => onTool(null)} className="flex h-[34px] w-full items-center justify-center rounded-md text-[13px] text-muted-foreground hover:bg-accent">
            Cancel
          </button>
        </footer>
      )}
    </aside>
  );
}
