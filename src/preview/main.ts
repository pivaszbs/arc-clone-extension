// Local development only. This entry is not included in the extension build.
import { mount } from 'svelte';
import { installPreviewChrome } from './mock-chrome';

await installPreviewChrome();
const target = document.getElementById('app')!;
const surface = new URLSearchParams(location.search).get('surface');
if (surface === 'japanese') {
  target.innerHTML = '<article style="padding:60px;max-width:700px"><h1>Japanese study preview</h1><p style="margin-top:20px">Select this Japanese phrase, then open Learn and capture it.</p><p lang="ja" style="font-size:28px;margin-top:24px">それは何ですか。</p><p style="margin-top:20px">The preview supports saving, review, and export. Video controls need a playing video.</p></article>';
  const video = document.createElement('video');
  video.src = new URL('./japanese-qa.mp4', import.meta.url).href;
  video.controls = true; video.style.cssText = 'width:100%;margin-top:20px';
  video.setAttribute('aria-label', 'Silent test video with Japanese captions');
  const track = document.createElement('track');
  track.kind = 'subtitles'; track.srclang = 'ja'; track.label = 'Japanese test captions'; track.default = true;
  track.src = URL.createObjectURL(new Blob(['WEBVTT\n\n00:00:01.000 --> 00:00:05.000\nそれは何ですか。\n\n00:00:06.000 --> 00:00:10.000\nやさしい日本語でお願いします。\n'], { type: 'text/vtt' }));
  video.appendChild(track); target.querySelector('article')!.appendChild(video);
  const { default: JapaneseStudy } = await import('../japanese/JapaneseStudy.svelte');
  const host = document.createElement('div'); document.body.appendChild(host);
  mount(JapaneseStudy, { target: host });
} else if (surface === 'newtab') {
  const { default: NewTab } = await import('../newtab/NewTab.svelte');
  mount(NewTab, { target });
} else if (surface === 'overlay') {
  target.innerHTML = '<article class="preview-page"><h1>A quieter place to browse.</h1><p>This local preview uses sample tabs. Your real tabs and browsing history are untouched.</p><p>Select this text to try translation. Use Command K to search, or the sidebar to switch Spaces.</p><p><a href="https://example.com">A sample link for Peek</a></p></article>';
  const { default: Overlay } = await import('../content/Overlay.svelte');
  const host = document.createElement('div');
  host.id = 'arc-chrome-extension-root';
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  // Vite injects development CSS into document.head. Production content scripts
  // inject their own CSS into this root; mirror that placement in this preview.
  for (const style of document.querySelectorAll('style[data-vite-dev-id]')) shadow.appendChild(style.cloneNode(true));
  const container = document.createElement('div'); shadow.appendChild(container);
  mount(Overlay, { target: container });
} else {
  target.className = 'sidebar';
  const { default: App } = await import('../sidepanel/App.svelte');
  mount(App, { target });
}
