import type { SkipRanges } from 'react-native-anime-core';

function range(value: unknown) {
  const item = value as { start?: unknown; end?: unknown } | undefined;
  return item && typeof item.start === 'number' && typeof item.end === 'number'
    && Number.isFinite(item.start) && Number.isFinite(item.end) && item.start >= 0 && item.end > item.start
    ? { start: item.start, end: item.end } : undefined;
}

export function skipRanges(value: unknown): SkipRanges {
  const item = (value ?? {}) as Record<string, unknown>;
  return { op: range(item.op), ed: range(item.ed), recap: range(item.recap) };
}
