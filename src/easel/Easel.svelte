<script lang="ts">
  import { onMount } from 'svelte';
  import {
    EaselHistory,
    addEaselItem,
    bringToFront,
    createEasel,
    removeEaselItem,
    sendToBack,
    snapBounds,
    updateEaselItem,
    type EaselDocument,
    type EaselItem,
    type EaselItemKind
  } from '../shared/easels';

  const STORAGE_KEY = 'arc_easels_v1';
  const PALETTE = ['#ffffff', '#a5b4fc', '#f472b6', '#34d399', '#fbbf24', '#60a5fa', '#f87171', '#1e1b2e'];

  let allDocs = $state<EaselDocument[]>([]);
  let activeId = $state<string>('');
  let doc = $state<EaselDocument>(createEasel('Untitled Easel'));
  let history = new EaselHistory(createEasel('Untitled Easel'));
  let canUndo = $state(false);
  let canRedo = $state(false);
  let tool = $state<EaselItemKind | 'select'>('select');
  let selectedId = $state<string | null>(null);
  let activeColor = $state('#a5b4fc');
  let activeFill = $state('#27273a');
  let strokeWidth = $state(2);
  let statusNotice = $state('');
  let guideX = $state<number | undefined>(undefined);
  let guideY = $state<number | undefined>(undefined);
  let drawingId = $state<string | null>(null);
  let startPt = { x: 0, y: 0 };
  let dragMode = $state<'none' | 'move' | 'resize' | 'draw' | 'freehand'>('none');
  let linkUrlInput = $state('');
  let showLinkPrompt = $state(false);
  let editingTextId = $state<string | null>(null);

  let selectedItem = $derived(doc.items.find((i) => i.id === selectedId) || null);
  let sortedItems = $derived([...doc.items].sort((a, b) => a.zIndex - b.zIndex));

  function notify(msg: string) {
    statusNotice = msg;
    setTimeout(() => {
      if (statusNotice === msg) statusNotice = '';
    }, 2500);
  }

  async function persist(next: EaselDocument, recordHistory = true) {
    if (recordHistory) history.push(next);
    canUndo = history.canUndo;
    canRedo = history.canRedo;
    doc = next;
    allDocs = [next, ...allDocs.filter((d) => d.id !== next.id)];
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ [STORAGE_KEY]: allDocs });
    }
  }

  async function loadEasels() {
    const params = new URLSearchParams(window.location.search);
    const requestedId = params.get('id');
    const captureId = params.get('captureId');
    let list: EaselDocument[] = [];
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const res = await chrome.storage.local.get([STORAGE_KEY, 'arc_captures_v1']);
      list = Array.isArray(res[STORAGE_KEY]) ? res[STORAGE_KEY] : [];
      if (captureId && Array.isArray(res['arc_captures_v1'])) {
        const cap = res['arc_captures_v1'].find((c: { id: string }) => c.id === captureId);
        if (cap) {
          const created = addEaselItem(createEasel(cap.title || 'Captured Easel'), {
            id: `item-${Date.now()}`,
            kind: 'image',
            x: 80,
            y: 80,
            w: 520,
            h: 340,
            color: '#ffffff',
            src: cap.dataUrl,
            title: cap.title
          });
          list = [created, ...list];
          await chrome.storage.local.set({ [STORAGE_KEY]: list });
          activeId = created.id;
        }
      }
    }
    if (list.length === 0) {
      list = [createEasel('Workspace Board')];
    }
    allDocs = list;
    const picked = (requestedId && list.find((d) => d.id === requestedId)) || (activeId && list.find((d) => d.id === activeId)) || list[0];
    activeId = picked.id;
    doc = picked;
    history = new EaselHistory(picked);
    canUndo = false;
    canRedo = false;
  }

  function selectEasel(nextDoc: EaselDocument) {
    activeId = nextDoc.id;
    doc = nextDoc;
    history = new EaselHistory(nextDoc);
    canUndo = false;
    canRedo = false;
    selectedId = null;
  }

  async function newEasel() {
    const created = createEasel(`Easel ${allDocs.length + 1}`);
    history = new EaselHistory(created);
    await persist(created, false);
    activeId = created.id;
    selectedId = null;
  }

  function handleCanvasPointerDown(e: PointerEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = Math.round(e.clientX - rect.left);
    const y = Math.round(e.clientY - rect.top);

    if (tool === 'select') {
      selectedId = null;
      editingTextId = null;
      return;
    }

    if (tool === 'text') {
      const id = `item-${Date.now()}`;
      const next = addEaselItem(doc, {
        id,
        kind: 'text',
        x,
        y,
        w: 220,
        h: 48,
        color: activeColor,
        text: 'Double-click to edit',
        fontSize: 18
      });
      void persist(next);
      selectedId = id;
      editingTextId = id;
      tool = 'select';
      return;
    }

    if (tool === 'linkCard') {
      showLinkPrompt = true;
      startPt = { x, y };
      return;
    }

    const id = `item-${Date.now()}`;
    startPt = { x, y };
    drawingId = id;
    dragMode = tool === 'freehand' ? 'freehand' : 'draw';
    const initial: Omit<EaselItem, 'zIndex'> = {
      id,
      kind: tool,
      x,
      y,
      w: tool === 'freehand' ? 4 : 10,
      h: tool === 'freehand' ? 4 : 10,
      color: activeColor,
      fill: tool === 'rect' || tool === 'ellipse' ? activeFill : undefined,
      strokeWidth,
      points: tool === 'freehand' ? [{ x: 0, y: 0 }] : undefined
    };
    doc = addEaselItem(doc, initial);
    selectedId = id;
  }

  function handleItemPointerDown(e: PointerEvent, item: EaselItem, resize = false) {
    e.stopPropagation();
    selectedId = item.id;
    if (tool !== 'select') return;
    startPt = { x: e.clientX, y: e.clientY };
    const orig = { x: item.x, y: item.y, w: item.w, h: item.h };
    dragMode = resize ? 'resize' : 'move';

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startPt.x;
      const dy = ev.clientY - startPt.y;
      if (resize) {
        doc = updateEaselItem(doc, item.id, {
          w: Math.max(36, orig.w + dx),
          h: Math.max(24, orig.h + dy)
        });
      } else {
        const others = doc.items.filter((o) => o.id !== item.id);
        const snapped = snapBounds({ x: orig.x + dx, y: orig.y + dy, w: orig.w, h: orig.h }, others);
        guideX = snapped.guides.x;
        guideY = snapped.guides.y;
        doc = updateEaselItem(doc, item.id, { x: snapped.x, y: snapped.y });
      }
    };

    const onUp = () => {
      guideX = undefined;
      guideY = undefined;
      dragMode = 'none';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      void persist(doc);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function handleCanvasPointerMove(e: PointerEvent) {
    if (!drawingId || (dragMode !== 'draw' && dragMode !== 'freehand')) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const cx = Math.round(e.clientX - rect.left);
    const cy = Math.round(e.clientY - rect.top);
    const cur = doc.items.find((i) => i.id === drawingId);
    if (!cur) return;

    if (dragMode === 'freehand') {
      const nextPts = [...(cur.points || []), { x: cx - startPt.x, y: cy - startPt.y }];
      const xs = nextPts.map((p) => p.x);
      const ys = nextPts.map((p) => p.y);
      const maxX = Math.max(20, ...xs);
      const maxY = Math.max(20, ...ys);
      doc = updateEaselItem(doc, cur.id, { points: nextPts, w: maxX + 8, h: maxY + 8 });
    } else {
      doc = updateEaselItem(doc, cur.id, {
        x: Math.min(startPt.x, cx),
        y: Math.min(startPt.y, cy),
        w: Math.max(18, Math.abs(cx - startPt.x)),
        h: Math.max(18, Math.abs(cy - startPt.y))
      });
    }
  }

  function handleCanvasPointerUp() {
    if (drawingId && (dragMode === 'draw' || dragMode === 'freehand')) {
      drawingId = null;
      dragMode = 'none';
      tool = 'select';
      void persist(doc);
    }
  }

  function insertLinkCard() {
    const raw = linkUrlInput.trim();
    if (!raw) return;
    const url = raw.includes('://') ? raw : `https://${raw}`;
    let host = url;
    try { host = new URL(url).hostname; } catch { /* ignore */ }
    const id = `item-${Date.now()}`;
    const next = addEaselItem(doc, {
      id,
      kind: 'linkCard',
      x: startPt.x || 120,
      y: startPt.y || 120,
      w: 280,
      h: 96,
      color: activeColor,
      url,
      title: host
    });
    void persist(next);
    linkUrlInput = '';
    showLinkPrompt = false;
    selectedId = id;
    tool = 'select';
  }

  function handlePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const blob = item.getAsFile();
        if (!blob) continue;
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = String(reader.result || '');
          const next = addEaselItem(doc, {
            id: `img-${Date.now()}`,
            kind: 'image',
            x: 100,
            y: 100,
            w: 360,
            h: 240,
            color: '#ffffff',
            src: dataUrl
          });
          void persist(next);
        };
        reader.readAsDataURL(blob);
        return;
      }
    }
    const text = e.clipboardData?.getData('text/plain')?.trim();
    if (text && /^https?:\/\//i.test(text)) {
      const next = addEaselItem(doc, {
        id: `link-${Date.now()}`,
        kind: 'linkCard',
        x: 120,
        y: 120,
        w: 280,
        h: 92,
        color: activeColor,
        url: text,
        title: text
      });
      void persist(next);
    }
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${doc.title.replace(/[^a-z0-9_-]/gi, '_')}.easel.json`;
    a.click();
    URL.revokeObjectURL(url);
    notify('Exported Easel JSON');
  }

  function freehandPath(pts?: { x: number; y: number }[]): string {
    if (!pts || pts.length === 0) return '';
    return pts.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  }

  onMount(() => {
    void loadEasels();
    window.addEventListener('paste', handlePaste);
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        const swapped = e.shiftKey ? history.redo() : history.undo();
        if (swapped) void persist(swapped, false);
      } else if ((e.key === 'Backspace' || e.key === 'Delete') && selectedId && !editingTextId) {
        void persist(removeEaselItem(doc, selectedId));
        selectedId = null;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('paste', handlePaste);
      window.removeEventListener('keydown', onKey);
    };
  });
</script>

<div class="easel-shell" style:background={doc.background}>
  <header class="easel-top">
    <div class="left-group">
      <select
        aria-label="Choose Easel"
        value={activeId}
        onchange={(e) => {
          const found = allDocs.find((d) => d.id === e.currentTarget.value);
          if (found) selectEasel(found);
        }}
      >
        {#each allDocs as d (d.id)}
          <option value={d.id}>{d.title}</option>
        {/each}
      </select>
      <input
        class="title-input"
        aria-label="Easel title"
        value={doc.title}
        oninput={(e) => { void persist({ ...doc, title: e.currentTarget.value }, false); }}
      />
      <button onclick={newEasel}>+ New Easel</button>
    </div>

    <div class="toolbar">
      {#each [
        ['select', 'Cursor'],
        ['text', 'Text'],
        ['rect', 'Box'],
        ['ellipse', 'Circle'],
        ['arrow', 'Arrow'],
        ['freehand', 'Draw'],
        ['linkCard', 'Link']
      ] as [k, label]}
        <button
          class:active={tool === k}
          onclick={() => (tool = k as typeof tool)}
        >
          {label}
        </button>
      {/each}
    </div>

    <div class="right-group">
      {#each PALETTE as color}
        <button
          class="swatch {activeColor === color ? 'selected' : ''}"
          style:background={color}
          aria-label="Color {color}"
          onclick={() => {
            activeColor = color;
            if (selectedId) void persist(updateEaselItem(doc, selectedId, { color }));
          }}
        ></button>
      {/each}
      <button onclick={() => { const prev = history.undo(); if (prev) void persist(prev, false); }} disabled={!canUndo}>Undo</button>
      <button onclick={() => { const next = history.redo(); if (next) void persist(next, false); }} disabled={!canRedo}>Redo</button>
      <button onclick={exportJson}>Export</button>
    </div>
  </header>

  {#if showLinkPrompt}
    <form class="link-bar" onsubmit={(e) => { e.preventDefault(); insertLinkCard(); }}>
      <input placeholder="Paste URL for live link card (e.g. https://github.com)" bind:value={linkUrlInput} />
      <button type="submit">Add Link Card</button>
      <button type="button" onclick={() => (showLinkPrompt = false)}>Cancel</button>
    </form>
  {/if}

  <main
    class="canvas"
    onpointerdown={handleCanvasPointerDown}
    onpointermove={handleCanvasPointerMove}
    onpointerup={handleCanvasPointerUp}
  >
    {#if guideX !== undefined}
      <div class="guide-v" style:left="{guideX}px"></div>
    {/if}
    {#if guideY !== undefined}
      <div class="guide-h" style:top="{guideY}px"></div>
    {/if}

    {#each sortedItems as item (item.id)}
      <div
        class="easel-item {selectedId === item.id ? 'selected' : ''}"
        role="button"
        tabindex="0"
        style:left="{item.x}px"
        style:top="{item.y}px"
        style:width="{item.w}px"
        style:height="{item.h}px"
        style:z-index={item.zIndex}
        onpointerdown={(e) => handleItemPointerDown(e, item, false)}
        ondblclick={() => { if (item.kind === 'text') editingTextId = item.id; }}
      >
        {#if item.kind === 'text'}
          {#if editingTextId === item.id}
            <textarea
              class="text-editor"
              style:color={item.color}
              style:font-size="{item.fontSize || 18}px"
              value={item.text || ''}
              onpointerdown={(e) => e.stopPropagation()}
              oninput={(e) => { doc = updateEaselItem(doc, item.id, { text: e.currentTarget.value }); }}
              onblur={() => { editingTextId = null; void persist(doc); }}
            ></textarea>
          {:else}
            <div class="text-node" style:color={item.color} style:font-size="{item.fontSize || 18}px">
              {item.text || 'Text'}
            </div>
          {/if}
        {:else if item.kind === 'rect'}
          <div
            class="shape-rect"
            style:border="{item.strokeWidth || 2}px solid {item.color}"
            style:background={item.fill || 'transparent'}
          ></div>
        {:else if item.kind === 'ellipse'}
          <div
            class="shape-ellipse"
            style:border="{item.strokeWidth || 2}px solid {item.color}"
            style:background={item.fill || 'transparent'}
          ></div>
        {:else if item.kind === 'arrow'}
          <svg width={item.w} height={item.h} class="arrow-svg">
            <line x1="4" y1={item.h - 4} x2={item.w - 10} y2="10" stroke={item.color} stroke-width={item.strokeWidth || 3} />
            <circle cx={item.w - 8} cy="8" r="4" fill={item.color} />
          </svg>
        {:else if item.kind === 'freehand'}
          <svg width={item.w} height={item.h}>
            <path d={freehandPath(item.points)} fill="none" stroke={item.color} stroke-width={item.strokeWidth || 3} stroke-linecap="round" />
          </svg>
        {:else if item.kind === 'image' && item.src}
          <img src={item.src} alt={item.title || 'Capture'} class="easel-img" draggable="false" />
        {:else if item.kind === 'linkCard' && item.url}
          <a href={item.url} target="_blank" rel="noreferrer" class="link-card" style:border-color={item.color}>
            <strong>{item.title || item.url}</strong>
            <span>{item.url}</span>
          </a>
        {/if}

        {#if selectedId === item.id}
          <div class="item-actions" role="toolbar" tabindex="-1" aria-label="Item actions" onpointerdown={(e) => e.stopPropagation()}>
            <button onclick={() => void persist(bringToFront(doc, item.id))}>↑</button>
            <button onclick={() => void persist(sendToBack(doc, item.id))}>↓</button>
            <button onclick={() => { void persist(removeEaselItem(doc, item.id)); selectedId = null; }}>×</button>
          </div>
          <div class="resize-handle" role="presentation" onpointerdown={(e) => handleItemPointerDown(e, item, true)}></div>
        {/if}
      </div>
    {/each}
  </main>

  {#if statusNotice}
    <div class="status-pill">{statusNotice}</div>
  {/if}
</div>

<style>
  .easel-shell { display: flex; flex-direction: column; width: 100vw; height: 100vh; color: #f5f5f7; }
  .easel-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 14px; background: rgba(15, 15, 24, 0.9); border-bottom: 1px solid rgba(255,255,255,0.1); }
  .left-group, .toolbar, .right-group { display: flex; align-items: center; gap: 6px; }
  .title-input, select, .link-bar input { background: rgba(255,255,255,0.08); color: #fff; border: 1px solid rgba(255,255,255,0.16); border-radius: 7px; padding: 5px 8px; font-size: 12px; }
  button { background: rgba(255,255,255,0.08); color: #f1f1f5; border: 1px solid rgba(255,255,255,0.14); border-radius: 7px; padding: 5px 9px; font-size: 12px; cursor: pointer; }
  button.active { background: #6366f1; border-color: #818cf8; }
  button:disabled { opacity: 0.4; cursor: default; }
  .swatch { width: 18px; height: 18px; padding: 0; border-radius: 999px; }
  .swatch.selected { outline: 2px solid #fff; outline-offset: 1px; }
  .link-bar { display: flex; gap: 8px; padding: 8px 14px; background: rgba(25,25,38,0.95); }
  .link-bar input { flex: 1; }
  .canvas { position: relative; flex: 1; overflow: hidden; background-image: radial-gradient(rgba(255,255,255,0.08) 1px, transparent 1px); background-size: 24px 24px; }
  .guide-v { position: absolute; top: 0; bottom: 0; width: 1px; background: #38bdf8; pointer-events: none; z-index: 9999; }
  .guide-h { position: absolute; left: 0; right: 0; height: 1px; background: #38bdf8; pointer-events: none; z-index: 9999; }
  .easel-item { position: absolute; cursor: grab; user-select: none; }
  .easel-item.selected { outline: 2px solid #818cf8; outline-offset: 2px; }
  .shape-rect, .shape-ellipse { width: 100%; height: 100%; box-sizing: border-box; border-radius: 10px; }
  .shape-ellipse { border-radius: 999px; }
  .text-node, .text-editor { width: 100%; height: 100%; background: transparent; border: none; font-weight: 600; outline: none; resize: none; }
  .easel-img { width: 100%; height: 100%; object-fit: contain; border-radius: 8px; display: block; }
  .link-card { display: flex; flex-direction: column; justify-content: center; gap: 4px; width: 100%; height: 100%; padding: 12px; box-sizing: border-box; border-radius: 10px; border: 1.5px solid; background: rgba(30, 30, 48, 0.92); color: #fff; text-decoration: none; }
  .link-card span { font-size: 11px; opacity: 0.7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .item-actions { position: absolute; top: -28px; right: 0; display: flex; gap: 4px; }
  .item-actions button { padding: 2px 6px; font-size: 11px; }
  .resize-handle { position: absolute; right: -5px; bottom: -5px; width: 10px; height: 10px; background: #fff; border: 2px solid #6366f1; border-radius: 2px; cursor: nwse-resize; }
  .status-pill { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); background: rgba(15,15,24,0.92); padding: 6px 14px; border-radius: 999px; font-size: 12px; }
</style>
