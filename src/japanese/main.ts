import { addEpisodeActions } from './episode-actions';
import { installPictureInPictureControls } from '../video/picture-in-picture';
import { startJapaneseStudy } from './mount';
import { requestArc } from './client';
import { findNextEpisode, isAnimeSubtitleSite, loadPageCaptions } from './page-captions';

if (window === window.top && isAnimeSubtitleSite(location.hostname)) {
  addEpisodeActions();
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === 'JAPANESE_READ_NEXT_EPISODE') {
      respond({ url: findNextEpisode(document, new URL(location.href)) });
      return;
    }
    if (message?.type !== 'JAPANESE_READ_EPISODE_DOWNLOAD') return;
    void loadPageCaptions(document).then(respond, () => respond(null));
    return true;
  });
}
const isAnimePage = [location.href, document.referrer, ...Array.from(location.ancestorOrigins || [])].some(value => {
  try { return isAnimeSubtitleSite(new URL(value).hostname); } catch { return false; }
});
startJapaneseStudy(isAnimePage ? async () => {
  if (window === window.top) return loadPageCaptions(document);
  const local = await loadPageCaptions(document);
  if (local?.cues.length) return local;
  return (await requestArc({ type: 'JAPANESE_GET_EPISODE_DOWNLOAD' }).catch(() => null)) || local;
} : undefined);

if (isAnimePage) {
  installPictureInPictureControls();
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type !== 'JAPANESE_OPEN_STUDY_PLAYER') return;
    if (!Array.from(document.querySelectorAll('video')).some(video => video.getBoundingClientRect().width > 0)) return;
    const panel = document.getElementById('arc-japanese-study')?.shadowRoot;
    if (panel?.querySelector('[data-study-player][aria-pressed="true"]')) {
      respond({ ok: true });
      return;
    }
    const launcher = panel?.querySelector<HTMLButtonElement>('.launcher');
    if (!launcher) return;
    if (launcher.getAttribute('aria-expanded') !== 'true') launcher.click();
    respond({ ok: true });
  });
}
