import { mount } from 'svelte';
import JapaneseStudy from './JapaneseStudy.svelte';
import { canMountStudy } from './study';

export function startJapaneseStudy(networkScanAvailable = false) {
  if (!canMountStudy(window)) return;
  const init = () => {
    if (document.getElementById('arc-japanese-study')) return;
    // Embedded players get their own controls because their video belongs to that frame.
    if (window !== window.top && !document.querySelector('video')) return;
    const host = document.createElement('div');
    host.id = 'arc-japanese-study';
    document.documentElement.appendChild(host);
    mount(JapaneseStudy, { target: host.attachShadow({ mode: 'open' }), props: { networkScanAvailable } });
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
