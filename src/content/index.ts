import { mount } from 'svelte';
import Overlay from './Overlay.svelte';

function initArcContentOverlay() {
  const ROOT_ID = 'arc-chrome-extension-root';
  if (document.getElementById(ROOT_ID)) return;

  const host = document.createElement('div');
  host.id = ROOT_ID;
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; pointer-events: auto;';

  const shadowRoot = host.attachShadow({ mode: 'open' });
  const container = document.createElement('div');
  shadowRoot.appendChild(container);

  (document.documentElement || document.body).appendChild(host);

  mount(Overlay, {
    target: container
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initArcContentOverlay);
} else {
  initArcContentOverlay();
}
