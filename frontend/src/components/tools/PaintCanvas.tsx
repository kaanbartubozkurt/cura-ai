'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Brush, Eraser, Eye, EyeOff, Redo2, Undo2 } from 'lucide-react';
import LibraryImage from '@/components/LibraryImage';
import type { Box } from './BoxCanvas';

const PAINT_COLOR = 'hsl(225 80% 55%)';

export interface PaintMask {
  dataUrl: string;
  percent: number;
}

const HISTORY = 20;

export default function PaintCanvas({ source, value, onChange, region, toolbarExtra }: {
  source?: string;
  region?: Box;
  value?: PaintMask;
  onChange: (value: PaintMask) => void;
  /** Extra controls at the end of the floating tool bar (e.g. Ideogram's precision box). */
  toolbarExtra?: ReactNode;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const undo = useRef<ImageData[]>([]);
  const redo = useRef<ImageData[]>([]);
  const [history, setHistory] = useState({ undo: 0, redo: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; x: number; y: number; scale: number; tx: number; ty: number }>();
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState(40);
  const [erase, setErase] = useState(false);
  const [visible, setVisible] = useState(true);
  const [dimensions, setDimensions] = useState({ width: 1, height: 1 });
  const viewport = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState({ width: 0, height: 0 });
  // Painting blocks page scrolling, so on phones the whole image must fit the space it has.
  const fitWidth = Math.min(area.width, area.height * dimensions.width / dimensions.height);

  useEffect(() => {
    if (!viewport.current) return;
    const observer = new ResizeObserver(([entry]) => setArea({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, [source]);


  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, dimensions.width, dimensions.height);
    if (!value?.dataUrl) return;
    let active = true;
    const image = new Image();
    image.onload = () => {
      if (!active) return;
      context.globalCompositeOperation = 'source-over';
      context.drawImage(image, 0, 0);
    };
    image.src = value.dataUrl;
    return () => { active = false; };
  }, [source, dimensions, value?.dataUrl]);

  useEffect(() => {
    undo.current = [];
    redo.current = [];
    setHistory({ undo: 0, redo: 0 });
    pointers.current.clear();
    pinch.current = undefined;
    setView({ scale: 1, x: 0, y: 0 });
  }, [source]);

  function snapshot() {
    const node = canvas.current;
    return node ? node.getContext('2d')!.getImageData(0, 0, node.width, node.height) : null;
  }
  const syncHistory = () => setHistory({ undo: undo.current.length, redo: redo.current.length });
  /** Remember the current paint before a change, so it can be undone. */
  function checkpoint() {
    const current = snapshot();
    if (!current) return;
    undo.current.push(current);
    if (undo.current.length > HISTORY) undo.current.shift();
    redo.current = [];
    syncHistory();
  }
  function restoreStroke() {
    const previous = undo.current.pop();
    if (previous) canvas.current?.getContext('2d')?.putImageData(previous, 0, 0);
    syncHistory();
  }
  function step(from: React.MutableRefObject<ImageData[]>, to: React.MutableRefObject<ImageData[]>) {
    const target = from.current.pop();
    const current = snapshot();
    if (!target || !current) return;
    to.current.push(current);
    canvas.current?.getContext('2d')?.putImageData(target, 0, 0);
    syncHistory();
    save();
  }
  const undoStep = () => step(undo, redo);
  const redoStep = () => step(redo, undo);
  function clearAll() {
    checkpoint();
    canvas.current?.getContext('2d')?.clearRect(0, 0, dimensions.width, dimensions.height);
    save();
  }
  /** Painted becomes unpainted and the other way round. */
  function invert() {
    const node = canvas.current;
    const context = node?.getContext('2d');
    if (!node || !context) return;
    checkpoint();
    context.fillStyle = PAINT_COLOR;
    const probe = document.createElement('canvas').getContext('2d')!;
    probe.fillStyle = PAINT_COLOR;
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b] = [0, 1, 2].map((i) => probe.getImageData(0, 0, 1, 1).data[i]);
    const pixels = context.getImageData(0, 0, node.width, node.height);
    for (let i = 0; i < pixels.data.length; i += 4) {
      const painted = pixels.data[i + 3] >= 128;
      pixels.data[i] = r;
      pixels.data[i + 1] = g;
      pixels.data[i + 2] = b;
      pixels.data[i + 3] = painted ? 0 : 255;
    }
    context.putImageData(pixels, 0, 0);
    save();
  }

  // Cmd/Ctrl+Z undoes, Shift+Cmd/Ctrl+Z (or Ctrl+Y) redoes, unless typing somewhere.
  useEffect(() => {
    if (!source) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === 'z' || key === 'y') {
        event.preventDefault();
        if (key === 'y' || event.shiftKey) redoStep();
        else undoStep();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, dimensions]);

  function finish(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.delete(event.pointerId);
    drawing.current = false;
    last.current = null;
    if (!pointers.current.size) { pinch.current = undefined; save(); }
  }

  function save() {
    const node = canvas.current;
    const context = node?.getContext('2d');
    if (!node || !context) return;
    const pixels = context.getImageData(0, 0, node.width, node.height);
    let selected = 0;
    for (let i = 3; i < pixels.data.length; i += 4) {
      if (pixels.data[i] >= 128) selected++;
    }
    onChange({ dataUrl: node.toDataURL('image/png'), percent: selected / (node.width * node.height) * 100 });
  }

  function paint(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current || !canvas.current) return;
    const node = canvas.current;
    const rect = node.getBoundingClientRect();
    const point = { x: (event.clientX - rect.left) * node.width / rect.width, y: (event.clientY - rect.top) * node.height / rect.height };
    const context = node.getContext('2d')!;
    context.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    context.strokeStyle = PAINT_COLOR;
    context.fillStyle = PAINT_COLOR;
    const radius = size * node.width / rect.width / 2;
    context.lineWidth = radius * 2;
    context.lineCap = 'round';
    context.beginPath();
    context.moveTo(last.current?.x ?? point.x, last.current?.y ?? point.y);
    context.lineTo(point.x, point.y);
    context.stroke();
    context.beginPath();
    context.arc(point.x, point.y, radius, 0, Math.PI * 2);
    context.fill();
    last.current = point;
  }

  return (
    <div className="flex min-h-[240px] flex-1 flex-col gap-2">
      {source && (
        <div
          role="toolbar"
          aria-label="Paint tools"
          className="mx-auto flex max-w-full flex-wrap items-center gap-1 rounded-[10px] border border-border bg-background/95 px-2 py-1 text-xs shadow-[0_8px_24px_-12px_rgb(0_0_0/0.35)]"
        >
          <div role="group" aria-label="Brush" className="inline-flex gap-0.5 rounded-md bg-muted p-0.5">
            {[false, true].map(mode => (
              <button
                key={String(mode)}
                aria-pressed={erase === mode}
                onClick={() => setErase(mode)}
                className={`flex items-center gap-1 rounded px-2 py-1 ${erase === mode ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground'}`}
              >
                {mode ? <Eraser className="h-3.5 w-3.5" /> : <Brush className="h-3.5 w-3.5" />}
                {mode ? 'Erase' : 'Brush'}
              </button>
            ))}
          </div>
          <span className="mx-1 h-5 w-px bg-border" />
          <label className="flex items-center gap-2 text-muted-foreground">Size
            <input aria-label="Brush size" type="range" min="2" max="160" value={size} onChange={event => setSize(Number(event.target.value))} className="w-24" />
            <span className="w-10 font-mono text-foreground">{size}px</span>
          </label>
          <span className="mx-1 h-5 w-px bg-border" />
          <button aria-label="Undo" title="Undo (Cmd/Ctrl+Z)" disabled={!history.undo} onClick={undoStep} className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"><Undo2 className="h-3.5 w-3.5" /></button>
          <button aria-label="Redo" title="Redo (Shift+Cmd/Ctrl+Z)" disabled={!history.redo} onClick={redoStep} className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"><Redo2 className="h-3.5 w-3.5" /></button>
          <button onClick={invert} title="Paint everything you haven't painted, and the other way round" className="rounded px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground">Invert</button>
          <button onClick={clearAll} disabled={!value?.percent} className="rounded px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40">Clear</button>
          <button aria-label={visible ? 'Hide painted area' : 'Show painted area'} title={visible ? 'Hide painted area' : 'Show painted area'} aria-pressed={!visible} onClick={() => setVisible(!visible)} className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground">
            {visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
          </button>
          {toolbarExtra && <><span className="mx-1 h-5 w-px bg-border" />{toolbarExtra}</>}
          <span className="mx-1 h-5 w-px bg-border" />
          <span className="font-mono text-selection">{(value?.percent ?? 0).toFixed(1)}% painted</span>
        </div>
      )}
      {source ? (
        <div ref={viewport} className="paint-viewport min-h-0 flex-1 overflow-hidden">
        <div className="paint-image relative mx-auto w-full max-w-[900px]" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, '--paint-width': `${fitWidth}px`, aspectRatio: `${dimensions.width}/${dimensions.height}`, width: `min(100%, ${55 * dimensions.width / dimensions.height}vh)` } as React.CSSProperties}>
          <LibraryImage src={source} alt="Base image to paint" className="absolute inset-0 h-full w-full" onLoad={event => {
            const image = event.currentTarget;
            setDimensions({ width: image.naturalWidth, height: image.naturalHeight });
          }} />
          {region && (
            <div className="pointer-events-none absolute z-10 border-2 border-primary" style={{ left: `${region.x_min * 100}%`, top: `${region.y_min * 100}%`, width: `${(region.x_max - region.x_min) * 100}%`, height: `${(region.y_max - region.y_min) * 100}%` }}>
              <span className="bg-background/90 px-1 text-xs">Precision area</span>
            </div>
          )}
          <canvas
            ref={canvas}
            width={dimensions.width}
            height={dimensions.height}
            aria-label="Paint the area to change"
            className="absolute inset-0 h-full w-full touch-none cursor-crosshair"
            style={{ opacity: visible ? 0.5 : 0, pointerEvents: visible ? 'auto' : 'none' }}
            onPointerDown={event => {
              if (event.button !== 0) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
              if (window.matchMedia('(max-width: 767px)').matches && pointers.current.size > 1) {
                if (drawing.current) restoreStroke();
                drawing.current = false;
                last.current = null;
                const [a, b] = Array.from(pointers.current.values());
                pinch.current = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, scale: view.scale, tx: view.x, ty: view.y };
                return;
              }
              if (pinch.current) return;
              checkpoint();
              drawing.current = true;
              last.current = null;
              paint(event);
            }}
            onPointerMove={event => {
              if (!pointers.current.has(event.pointerId)) return;
              pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
              const start = pinch.current;
              if (start && pointers.current.size >= 2) {
                const [a, b] = Array.from(pointers.current.values());
                setView({ scale: Math.max(1, Math.min(6, start.scale * Math.hypot(a.x - b.x, a.y - b.y) / start.distance)), x: start.tx + (a.x + b.x) / 2 - start.x, y: start.ty + (a.y + b.y) / 2 - start.y });
              } else if (!start) paint(event);
            }}
            onPointerUp={finish}
            onPointerCancel={finish}
            onLostPointerCapture={finish}
          />
        </div>
        </div>
      ) : <p className="text-sm text-muted-foreground">Add a base image, then paint the area to change.</p>}
    </div>
  );
}

/** Turn a saved black/white mask (white = edited) back into paint strokes, for Remix. */
export async function maskFromImage(url: string): Promise<PaintMask> {
  // Fetch as a blob so the canvas stays readable even when the file is served from another origin.
  const blob = await (await fetch(url)).blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d')!;
  context.fillStyle = PAINT_COLOR;
  context.fillRect(0, 0, 1, 1);
  const swatch = context.getImageData(0, 0, 1, 1).data;
  const r = swatch[0], g = swatch[1], b = swatch[2];
  context.clearRect(0, 0, 1, 1);
  context.drawImage(bitmap, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  let painted = 0;
  for (let i = 0; i < pixels.data.length; i += 4) {
    const on = pixels.data[i] > 127;
    if (on) painted++;
    pixels.data[i] = r;
    pixels.data[i + 1] = g;
    pixels.data[i + 2] = b;
    pixels.data[i + 3] = on ? 255 : 0;
  }
  context.putImageData(pixels, 0, 0);
  return { dataUrl: canvas.toDataURL('image/png'), percent: (painted / (canvas.width * canvas.height)) * 100 };
}

export async function maskFile(mask: PaintMask): Promise<File> {
  const image = new Image();
  image.src = mask.dataUrl;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d')!;
  // Canonical mask: white edits, black preserves, whatever color the strokes show in.
  context.drawImage(image, 0, 0);
  context.globalCompositeOperation = 'source-in';
  context.fillStyle = 'white';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.globalCompositeOperation = 'destination-over';
  context.fillStyle = 'black';
  context.fillRect(0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Could not export mask')), 'image/png'));
  return new File([blob], 'paint-mask.png', { type: 'image/png' });
}
