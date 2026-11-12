import { mount } from 'svelte';
import JapaneseStudy from './JapaneseStudy.svelte';
import { supportedSite } from './study';
import type { PageCaptions } from './auto-subtitles';

export function startJapaneseStudy(loadEpisodeCaptions?: () => Promise<PageCaptions | null>) {
const origins = Array.from(location.ancestorOrigins || []);
const eligible = [location.href, document.referrer, ...origins].some((value) => {
  try { return supportedSite(new URL(value).hostname); } catch { return false; }
});
if (eligible) {
  const init = () => {
    if (document.getElementById('arc-japanese-study')) return;
    // Put the launcher beside the actual video when the episode uses an embed.
    const hasVideo = !!document.querySelector('video');
    if (!hasVideo && (window !== window.top || (loadEpisodeCaptions && document.querySelector('iframe[src*="/translations/embed/"]')))) return;
    const host = document.createElement('div');
    host.id = 'arc-japanese-study';
    document.documentElement.appendChild(host);
    mount(JapaneseStudy, { target: host.attachShadow({ mode: 'open' }), props: { loadEpisodeCaptions } });
    document.addEventListener('fullscreenchange', () => {
      const fullscreen = document.fullscreenElement;
      if (fullscreen && fullscreen.tagName !== 'VIDEO') fullscreen.appendChild(host);
      else if (!fullscreen) document.documentElement.appendChild(host);
    });
  };
  init();
  const observer = new MutationObserver(init);
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

}
