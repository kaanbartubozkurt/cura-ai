'use client';

import { useEffect, useRef, useState } from 'react';
import LibraryImage from '@/components/LibraryImage';
import { sourceLabel, type SourceImage } from './SourceTray';

export const sourceIdentity = (source: SourceImage) =>
  `${source.type}:${source.id ?? source.previewUrl ?? source.key}`;
export const sourceColor = (index: number) =>
  `var(--source-${(index % 6) + 1})`;
const tokenPattern = /\uFFF0([^\uFFF1]+)\uFFF1/g;
export function translatePrompt(
  value: string,
  sources: SourceImage[],
  model: string
) {
  return value.replace(tokenPattern, (_, identity) => {
    const index = sources.findIndex(
      (source) => sourceIdentity(source) === identity
    );
    return index < 0 ? '[removed image]' : sourceLabel(model, index);
  });
}

export default function DescribeInput({
  sources,
  value,
  onChange,
  model,
  modelName,
  limit,
  onSources,
  onAdd,
  onUpload,
  onHover,
}: {
  sources: SourceImage[];
  value: string;
  onChange: (value: string) => void;
  model: string;
  modelName: string;
  limit: number;
  onSources: (sources: SourceImage[]) => void;
  onAdd: () => void;
  onUpload: (files: FileList) => void;
  onHover: (source: SourceImage | null) => void;
}) {
  const editor = useRef<HTMLDivElement>(null);
  const caret = useRef<Range>();
  const initialized = useRef(false);
  const dragging = useRef<number>();
  const [menu, setMenu] = useState(false);
  const [choice, setChoice] = useState(0);
  const [highlight, setHighlight] = useState<string>();

  function saveCaret() {
    const selection = window.getSelection();
    if (selection?.rangeCount && editor.current?.contains(selection.anchorNode))
      caret.current = selection.getRangeAt(0).cloneRange();
  }
  function emit() {
    const read = (node: Node): string => {
      if (node instanceof HTMLElement && node.dataset.source)
        return `\uFFF0${node.dataset.source}\uFFF1`;
      if (node.nodeName === 'BR') return '\n';
      if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
      return Array.from(node.childNodes).reduce((text, child) => {
        const block = child.nodeName === 'DIV' || child.nodeName === 'P';
        const boundary = block && text && !text.endsWith('\n') ? '\n' : '';
        const emptyBlock =
          block &&
          child.childNodes.length === 1 &&
          child.firstChild?.nodeName === 'BR';
        return text + boundary + (emptyBlock ? '' : read(child));
      }, '');
    };
    onChange(editor.current ? read(editor.current) : '');
    saveCaret();
  }
  function chip(source: SourceImage, index: number) {
    const element = document.createElement('span');
    element.dataset.source = sourceIdentity(source);
    element.contentEditable = 'false';
    element.tabIndex = 0;
    element.className =
      'mx-0.5 inline-flex items-center gap-1 rounded border px-1 align-middle text-xs';
    element.style.borderColor = sourceColor(index);
    element.style.color = sourceColor(index);
    if (source.previewUrl) {
      const image = document.createElement('img');
      image.src = source.previewUrl;
      image.alt = '';
      image.className = 'h-5 w-5 rounded object-cover';
      element.append(image);
    }
    element.append(document.createTextNode(String(index + 1)));
    element.setAttribute('aria-label', `Source ${index + 1}`);
    return element;
  }
  // Update existing chips in place so typing and the caret stay native to the editor.
  useEffect(() => {
    if (!initialized.current && editor.current) {
      initialized.current = true;
      let offset = 0;
      for (const match of Array.from(value.matchAll(tokenPattern))) {
        editor.current.append(
          document.createTextNode(value.slice(offset, match.index))
        );
        const index = sources.findIndex(
          (source) => sourceIdentity(source) === match[1]
        );
        editor.current.append(
          index < 0
            ? document.createTextNode('[removed image]')
            : chip(sources[index], index)
        );
        offset = match.index! + match[0].length;
      }
      if (value.slice(offset))
        editor.current.append(document.createTextNode(value.slice(offset)));
    }
    editor.current
      ?.querySelectorAll<HTMLElement>('[data-source]')
      .forEach((element) => {
        const index = sources.findIndex(
          (source) => sourceIdentity(source) === element.dataset.source
        );
        if (index < 0)
          element.replaceWith(document.createTextNode('[removed image]'));
        else {
          element.style.color = sourceColor(index);
          element.style.borderColor = sourceColor(index);
          element.lastChild!.textContent = String(index + 1);
          element.setAttribute('aria-label', `Source ${index + 1}`);
        }
      });
    emit();
    // Only source changes should normalize the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources]);

  function insert(source: SourceImage, removeAt = false) {
    const host = editor.current;
    if (!host) return;
    host.focus();
    const range =
      caret.current && host.contains(caret.current.startContainer)
        ? caret.current
        : document.createRange();
    if (!host.contains(range.startContainer)) {
      range.selectNodeContents(host);
      range.collapse(false);
    }
    if (
      removeAt &&
      range.startContainer.nodeType === Node.TEXT_NODE &&
      range.startOffset > 0 &&
      range.startContainer.textContent?.[range.startOffset - 1] === '@'
    )
      range.setStart(range.startContainer, range.startOffset - 1);
    range.deleteContents();
    const element = chip(source, sources.indexOf(source));
    range.insertNode(element);
    const space = document.createTextNode(' ');
    element.after(space);
    range.setStartAfter(space);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    setMenu(false);
    emit();
  }
  function hover(identity?: string) {
    setHighlight(identity);
    onHover(
      sources.find((source) => sourceIdentity(source) === identity) ?? null
    );
  }
  function move(index: number, target: number) {
    if (target < 0 || target >= sources.length) return;
    const next = [...sources];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item);
    onSources(next);
  }

  return (
    <div className="relative min-w-0 space-y-2">
      <div
        className="flex items-center gap-2 overflow-x-auto py-1"
        aria-label="Source attachments"
      >
        {sources.map((source, index) => (
          <div
            key={sourceIdentity(source)}
            draggable
            onDragStart={(event) => {
              dragging.current = index;
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', sourceIdentity(source));
            }}
            onDragEnd={() => {
              dragging.current = undefined;
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              if (dragging.current == null) return;
              event.preventDefault();
              event.stopPropagation();
              move(dragging.current, index);
              dragging.current = undefined;
            }}
            className={`group relative shrink-0 ${index >= limit ? 'opacity-40' : ''}`}
            onMouseEnter={() => hover(sourceIdentity(source))}
            onMouseLeave={(event) => {
              if (!event.currentTarget.contains(document.activeElement))
                hover();
            }}
            onFocus={() => hover(sourceIdentity(source))}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) hover();
            }}
          >
            <button
              type="button"
              aria-label={`Insert source ${index + 1}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => insert(source)}
              className={`relative h-[54px] w-[54px] overflow-hidden rounded-md border-2 ${highlight === sourceIdentity(source) ? 'ring-2 ring-ring' : ''}`}
              style={{ borderColor: sourceColor(index) }}
            >
              {source.previewUrl && (
                <LibraryImage
                  src={source.previewUrl}
                  alt=""
                  className="h-full w-full object-cover"
                />
              )}
              <span
                className="absolute bottom-0 left-0 rounded-tr px-1 text-[10px] text-white"
                style={{ background: sourceColor(index) }}
              >
                {index + 1}
              </span>
            </button>
            <button
              type="button"
              aria-label={`Remove source ${index + 1}`}
              onClick={() => {
                onSources(sources.filter((_, i) => i !== index));
                hover();
              }}
              className="absolute -right-1 -top-1 rounded-full bg-background px-1 text-xs opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
            >
              ×
            </button>
            <div className="flex justify-between text-[10px]">
              <button
                type="button"
                aria-label={`Move source ${index + 1} earlier`}
                disabled={!index}
                onClick={() => move(index, index - 1)}
              >
                ←
              </button>
              <button
                type="button"
                aria-label={`Move source ${index + 1} later`}
                disabled={index === sources.length - 1}
                onClick={() => move(index, index + 1)}
              >
                →
              </button>
            </div>
          </div>
        ))}
        <button
          type="button"
          onClick={onAdd}
          aria-label="Add from library"
          className="h-[54px] w-[54px] shrink-0 rounded-md border border-dashed text-xl"
        >
          +
        </button>
        <label className="relative flex h-[54px] shrink-0 cursor-pointer items-center rounded-md border border-dashed px-3 text-xs">
          Upload
          <input
            type="file"
            multiple
            accept="image/*"
            aria-label="Upload sources"
            className="absolute inset-0 w-full opacity-0"
            onChange={(event) => {
              if (event.target.files) onUpload(event.target.files);
              event.target.value = '';
            }}
          />
        </label>
      </div>
      <div
        ref={editor}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-haspopup="listbox"
        aria-autocomplete="list"
        aria-controls={menu ? 'source-reference-menu' : undefined}
        aria-activedescendant={
          menu && sources[choice] ? `source-option-${choice}` : undefined
        }
        data-empty={!value.trim()}
        aria-label="What should change? Type @ to reference an image"
        data-placeholder="What should change? Type @ to reference an image"
        className="describe-input min-h-[48px] whitespace-pre-wrap text-sm outline-none"
        onInput={(event) => {
          emit();
          if ((event.nativeEvent as InputEvent).data === '@') {
            setMenu(true);
            setChoice(0);
          } else if (menu) setMenu(false);
        }}
        onKeyUp={saveCaret}
        onMouseUp={saveCaret}
        onBlur={saveCaret}
        onMouseOver={(event) =>
          hover(
            (event.target as HTMLElement).closest<HTMLElement>('[data-source]')
              ?.dataset.source
          )
        }
        onMouseLeave={() => hover()}
        onFocusCapture={(event) =>
          hover((event.target as HTMLElement).dataset.source)
        }
        onBlurCapture={() => {
          hover();
          setMenu(false);
        }}
        onPaste={(event) => {
          event.preventDefault();
          const text = event.clipboardData.getData('text/plain');
          const selection = window.getSelection();
          if (selection?.rangeCount) {
            const range = selection.getRangeAt(0);
            range.deleteContents();
            const node = document.createTextNode(text);
            range.insertNode(node);
            range.setStartAfter(node);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
            emit();
          }
        }}
        onKeyDown={(event) => {
          if (!menu) return;
          if (
            ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(
              event.key
            )
          ) {
            event.preventDefault();
            if (event.key === 'Escape') setMenu(false);
            else if (event.key === 'ArrowDown')
              setChoice((choice + 1) % Math.max(1, sources.length));
            else if (event.key === 'ArrowUp')
              setChoice(
                (choice + sources.length - 1) % Math.max(1, sources.length)
              );
            else if (sources[choice]) insert(sources[choice], true);
          }
        }}
      />
      {menu && (
        <div
          id="source-reference-menu"
          role="listbox"
          aria-label="Reference an image"
          className="absolute bottom-full z-30 max-h-64 w-64 overflow-auto rounded-lg border bg-popover p-1 shadow-lg"
        >
          {!sources.length && <p className="p-2 text-xs">Add a source first</p>}
          {sources.map((source, index) => (
            <button
              type="button"
              id={`source-option-${index}`}
              role="option"
              aria-selected={choice === index}
              key={sourceIdentity(source)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => insert(source, true)}
              className={`flex w-full items-center gap-2 rounded p-2 text-sm ${choice === index ? 'bg-accent' : ''}`}
              style={{ color: sourceColor(index) }}
            >
              {source.previewUrl && (
                <LibraryImage
                  src={source.previewUrl}
                  alt=""
                  className="h-8 w-8 rounded object-cover"
                />
              )}{' '}
              {index + 1} · Source {index + 1}
            </button>
          ))}
        </div>
      )}
      {value.trim() && (
        <p
          className="truncate text-[11px] text-muted-foreground"
          title={translatePrompt(value, sources, model)}
        >
          Sent to {modelName}: &quot;{translatePrompt(value, sources, model)}
          &quot;
        </p>
      )}
    </div>
  );
}
