import { translateText } from './translate';
import { desktopPipRequest, openDownloadedVideoInQuickTime } from './desktop-pip';
import { studyRequest } from '../japanese/storage';
import { subtitleUrl } from '../japanese/captions';
import { isAnimeSubtitleSite } from '../japanese/page-captions';
import { seriesDownloadRequest } from './series-downloads';
import './remote-downloads';
import { seriesRoot } from '../japanese/series';

declare const __ARC_BROWSER_ID__: string;
const arcStorageKey = 'arc_chrome_state_v1';

chrome.runtime.onMessageExternal.addListener((message, sender, respond) => {
  if (sender.id !== __ARC_BROWSER_ID__ || message?.type !== 'IMPORT_LEGACY_ARC_STATE') return;
  void chrome.storage.local.get(arcStorageKey).then(result => respond(result[arcStorageKey] ?? null), () => respond(null));
  return true;
});

chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('offline.html') });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void (async () => {
    if (typeof message?.type === 'string' && message.type.startsWith('SERIES_DOWNLOAD_')) {
      sendResponse(await seriesDownloadRequest(message, sender));
      return;
    }
    if (message?.type === 'OPEN_SERIES_DOWNLOADS' || message?.type === 'OPEN_OFFLINE_STUDY') {
      const url = new URL(chrome.runtime.getURL('offline.html'));
      if (message.type === 'OPEN_SERIES_DOWNLOADS') {
        const source = new URL(sender.tab?.url || '');
        seriesRoot(source.href);
        url.searchParams.set('series', new URL(source.pathname, source.origin).href);
      }
      await chrome.tabs.create({ url: url.href });
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === 'OPEN_ANIME_STUDY_PLAYER' && sender.tab?.id !== undefined) {
      const result = await chrome.tabs.sendMessage(sender.tab.id, { type: 'JAPANESE_OPEN_STUDY_PLAYER' });
      sendResponse(result?.ok ? result : { error: 'Start the episode first, then open the study player.' });
      return;
    }
    if (message?.type === 'ANIME_NEXT_EPISODE_LINK') {
      if (sender.tab?.id === undefined || !sender.tab.url || !isAnimeSubtitleSite(new URL(sender.tab.url).hostname)) {
        sendResponse({ url: null });
        return;
      }
      const result = await chrome.tabs.sendMessage(sender.tab.id, { type: 'JAPANESE_READ_NEXT_EPISODE' }, { frameId: 0 }).catch(() => null);
      sendResponse({ url: typeof result?.url === 'string' ? result.url : null });
      return;
    }
    if (message?.type === 'ANIME_OPEN_EPISODE') {
      const tab = sender.tab;
      const url = new URL(String(message.url || ''));
      // Only move the same tab to another episode of the series it is already showing.
      if (tab?.id === undefined || !tab.url || url.protocol !== 'https:' || seriesRoot(url.href).href !== seriesRoot(tab.url).href) {
        throw new Error('That episode is not part of this series.');
      }
      await chrome.tabs.update(tab.id, { url: url.href });
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === 'ANIME_OPEN_QUICKTIME') {
      if (sender.url?.split(/[?#]/, 1)[0] !== chrome.runtime.getURL('offline.html')) {
        throw new Error('Open the episode from Offline Study.');
      }
      const { name, size, modified } = message;
      if (typeof name !== 'string' || !/^[^/\\]{1,255}\.(mp4|m4v|mov)$/i.test(name)
          || !Number.isSafeInteger(size) || size <= 0 || !Number.isFinite(modified)) {
        throw new Error('Choose a downloaded MP4, M4V, or MOV episode.');
      }
      if (!chrome.downloads) throw new Error('Allow Chrome downloads access or open the episode in QuickTime manually.');
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const downloads = await chrome.downloads.search({ filenameRegex: `/${escaped}$`, state: 'complete', fileSize: size });
      const paths = [...new Set(downloads.filter(item => item.exists).map(item => item.filename))];
      if (paths.length !== 1) throw new Error('Open this file from Finder in QuickTime, or use Screen Mirroring below.');
      await openDownloadedVideoInQuickTime(paths[0], size, modified);
      sendResponse({ ok: true });
      return;
    }
    if (typeof message?.type === 'string' && message.type.startsWith('DESKTOP_PIP_')) {
      sendResponse(await desktopPipRequest(message, sender));
      return;
    }
    if (message?.type === 'JAPANESE_GET_EPISODE_DOWNLOAD') {
      if (sender.tab?.id === undefined || !sender.tab.url || !isAnimeSubtitleSite(new URL(sender.tab.url).hostname)) {
        sendResponse(null);
        return;
      }
      sendResponse(await chrome.tabs.sendMessage(sender.tab.id, { type: 'JAPANESE_READ_EPISODE_DOWNLOAD' }, { frameId: 0 }).catch(() => null));
      return;
    }
    if (message?.type === 'JAPANESE_FETCH_CAPTIONS') {
      const url = String(message.url || '');
      if (!subtitleUrl(url)) throw new Error('Unsupported subtitle source.');
      const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(15000) });
      if (!response.ok || Number(response.headers.get('content-length') || 0) > 5000000) throw new Error('Subtitle source unavailable.');
      const body = await response.text();
      if (body.length > 5000000) throw new Error('Subtitle source too large.');
      sendResponse({ body });
      return;
    }
    if (message?.type === 'TRANSLATE_TEXT') {
      sendResponse(await translateText(String(message.text || ''), 'en', 'ja'));
      return;
    }
    if (typeof message?.type === 'string' && message.type.startsWith('JAPANESE_')) {
      sendResponse(await studyRequest(message));
      return;
    }
    sendResponse({ error: 'Unknown Anime action.' });
  })().catch(error => sendResponse({ error: error instanceof Error ? error.message : String(error) }));
  return true;
});
