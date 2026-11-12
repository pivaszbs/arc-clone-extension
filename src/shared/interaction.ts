import type { ExtensionSettings } from './types';

export function canPreviewInPeek(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export function isBrowserPageUrl(url: string): boolean {
  return /^(?:chrome|chrome-extension|edge|file):\/\/|^about:/i.test(url);
}

export function shouldPeek(event: Pick<MouseEvent, 'shiftKey' | 'altKey' | 'metaKey' | 'ctrlKey'>, settings: Pick<ExtensionSettings, 'peekTrigger'>): boolean {
  if (event.metaKey || event.ctrlKey) return false;
  return settings.peekTrigger === 'shift-click' ? event.shiftKey
    : settings.peekTrigger === 'alt-click' ? event.altKey : false;
}
