import { requestArc } from './client';
import { findEpisodeDownloads } from './page-captions';

export function addEpisodeActions() {
  const mount = () => {
    if (document.getElementById('arc-anime-inline-studio')) return;
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'));
    const downloads = findEpisodeDownloads(links, new URL(location.href));
    const frame = document.querySelector<HTMLIFrameElement>('iframe[src*="/translations/embed/"]');
    const anchor = links.find(link => link.href === (downloads?.subtitle || downloads?.video?.url));
    if (!frame && !anchor) return;

    const card = document.createElement('div');
    card.id = 'arc-anime-inline-studio';
    card.style.cssText = 'padding:6px;display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:6px';
    const status = document.createElement('span');
    status.setAttribute('role', 'status');
    function button(label: string, onClick: () => Promise<unknown>) {
      const element = document.createElement('button');
      element.type = 'button';
      element.textContent = label;
      element.style.cssText = 'padding:5px 10px;height:auto;line-height:1.4;background:#302b40;color:#fff;border:1px solid #8c80ad;border-radius:6px;cursor:pointer';
      element.addEventListener('click', () => {
        status.textContent = '';
        void onClick().catch(error => { status.textContent = error instanceof Error ? error.message : 'Could not open Anime Study.'; });
      });
      card.append(element);
    }
    button('Open study player', async () => {
      await requestArc({ type: 'OPEN_ANIME_STUDY_PLAYER' });
      frame?.scrollIntoView({ block: 'center' });
    });
    button('Offline', () => requestArc({ type: 'OPEN_SERIES_DOWNLOADS' }));
    card.append(status);
    if (frame) (frame.closest('.card-image') || frame.closest('.video-container') || frame).before(card);
    else anchor?.parentElement?.append(card);
  };
  mount();
  new MutationObserver(mount).observe(document.documentElement, { childList: true, subtree: true });
}
