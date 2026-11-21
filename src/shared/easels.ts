export type EaselItemKind =
  | 'text'
  | 'rect'
  | 'ellipse'
  | 'arrow'
  | 'freehand'
  | 'image'
  | 'linkCard';

export interface EaselPoint {
  x: number;
  y: number;
}

export interface EaselItem {
  id: string;
  kind: EaselItemKind;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  fill?: string;
  strokeWidth?: number;
  text?: string;
  fontSize?: number;
  url?: string;
  title?: string;
  src?: string;
  points?: EaselPoint[];
  zIndex: number;
}

export interface EaselDocument {
  id: string;
  title: string;
  background: string;
  createdAt: number;
  updatedAt: number;
  items: EaselItem[];
}

export function createEasel(title = 'Untitled Easel', now = Date.now(), id = `easel-${now}`): EaselDocument {
  return {
    id,
    title: title.trim() || 'Untitled Easel',
    background: '#181822',
    createdAt: now,
    updatedAt: now,
    items: []
  };
}

export function nextZIndex(doc: EaselDocument): number {
  return doc.items.reduce((max, it) => Math.max(max, it.zIndex), 0) + 1;
}

export function addEaselItem(
  doc: EaselDocument,
  item: Omit<EaselItem, 'zIndex'>,
  now = Date.now()
): EaselDocument {
  return {
    ...doc,
    updatedAt: now,
    items: [...doc.items, { ...item, zIndex: nextZIndex(doc) }]
  };
}

export function updateEaselItem(
  doc: EaselDocument,
  id: string,
  patch: Partial<EaselItem>,
  now = Date.now()
): EaselDocument {
  return {
    ...doc,
    updatedAt: now,
    items: doc.items.map((it) => (it.id === id ? { ...it, ...patch } : it))
  };
}

export function removeEaselItem(doc: EaselDocument, id: string, now = Date.now()): EaselDocument {
  return {
    ...doc,
    updatedAt: now,
    items: doc.items.filter((it) => it.id !== id)
  };
}

export function bringToFront(doc: EaselDocument, id: string, now = Date.now()): EaselDocument {
  const z = nextZIndex(doc);
  return updateEaselItem(doc, id, { zIndex: z }, now);
}

export function sendToBack(doc: EaselDocument, id: string, now = Date.now()): EaselDocument {
  const minZ = doc.items.reduce((min, it) => Math.min(min, it.zIndex), 1);
  return updateEaselItem(doc, id, { zIndex: minZ - 1 }, now);
}

export function snapBounds(
  candidate: { x: number; y: number; w: number; h: number },
  others: EaselItem[],
  threshold = 6
): { x: number; y: number; guides: { x?: number; y?: number } } {
  let x = candidate.x;
  let y = candidate.y;
  const guides: { x?: number; y?: number } = {};
  const cx = candidate.x + candidate.w / 2;
  const cy = candidate.y + candidate.h / 2;

  for (const other of others) {
    const ox = other.x + other.w / 2;
    const oy = other.y + other.h / 2;
    if (guides.x === undefined) {
      if (Math.abs(candidate.x - other.x) <= threshold) {
        x = other.x;
        guides.x = other.x;
      } else if (Math.abs(cx - ox) <= threshold) {
        x = ox - candidate.w / 2;
        guides.x = ox;
      }
    }
    if (guides.y === undefined) {
      if (Math.abs(candidate.y - other.y) <= threshold) {
        y = other.y;
        guides.y = other.y;
      } else if (Math.abs(cy - oy) <= threshold) {
        y = oy - candidate.h / 2;
        guides.y = oy;
      }
    }
  }
  return { x, y, guides };
}

export class EaselHistory {
  private past: EaselDocument[] = [];
  private future: EaselDocument[] = [];
  public current: EaselDocument;

  constructor(initial: EaselDocument) {
    this.current = initial;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  push(next: EaselDocument): EaselDocument {
    this.past.push(this.current);
    if (this.past.length > 50) this.past.shift();
    this.future = [];
    this.current = next;
    return next;
  }

  undo(): EaselDocument | null {
    const prev = this.past.pop();
    if (!prev) return null;
    this.future.push(this.current);
    this.current = prev;
    return prev;
  }

  redo(): EaselDocument | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(this.current);
    this.current = next;
    return next;
  }
}
