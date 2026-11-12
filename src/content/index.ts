import { mount, unmount } from 'svelte';
import Overlay from './Overlay.svelte';

const contentScope = globalThis as typeof globalThis & { arcOverlayHost?: HTMLElement };
const shutdownEvent = 'arc-overlay-shutdown';

function initArcContentOverlay() {
  const ROOT_ID = 'arc-chrome-extension-root';
  const existing = document.getElementById(ROOT_ID);
  if (existing && contentScope.arcOverlayHost === existing) return;
  const previous = contentScope.arcOverlayHost || existing;
  previous?.dispatchEvent(new Event(shutdownEvent));
  previous?.remove();

  const host = document.createElement('div');
  host.id = ROOT_ID;
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; pointer-events: auto;';

  const shadowRoot = host.attachShadow({ mode: 'open' });
  const container = document.createElement('div');
  shadowRoot.appendChild(container);

  (document.documentElement || document.body).appendChild(host);

  const overlay = mount(Overlay, { target: container });
  contentScope.arcOverlayHost = host;
  host.addEventListener(shutdownEvent, () => {
    void unmount(overlay).catch(() => {});
    if (contentScope.arcOverlayHost === host) delete contentScope.arcOverlayHost;
  }, { once: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initArcContentOverlay);
} else {
  initArcContentOverlay();
}
