declare const __TV_VERSION__: string;

export function tvDiagnostics(video: HTMLVideoElement, details: () => string[]) {
  const dialog = document.querySelector<HTMLDialogElement>('#diagnostics')!;
  const report = document.querySelector<HTMLElement>('#diagnostics-report')!;
  const entries: string[] = [];
  let timer: number | undefined;

  function render() {
    const state = video.error ? `error ${video.error.code}` : video.ended ? 'ended' : video.paused ? 'paused' : 'playing';
    const duration = Number.isFinite(video.duration) ? video.duration.toFixed(1) : 'unknown';
    const codec = video.canPlayType('video/mp4; codecs="avc1.640028, mp4a.40.2"') || 'unsupported';
    const engine = navigator.userAgent.match(/(?:Chrome|Chromium)\/\d+(?:\.\d+)?/)?.[0] || 'unknown';
    report.textContent = [
      `Anime Study TV ${__TV_VERSION__} · ${engine}`,
      ...details(),
      `Video: ${state} · ${video.currentTime.toFixed(1)} / ${duration} s · ${video.videoWidth}×${video.videoHeight}`,
      `Ready state: ${video.readyState} · Network state: ${video.networkState} · H.264/AAC: ${codec}`,
      '', 'Recent events', ...entries
    ].join('\n');
  }

  function log(message: string) {
    entries.push(`${new Date().toLocaleTimeString()}  ${message}`);
    if (entries.length > 24) entries.shift();
    if (dialog.open) render();
  }

  for (const event of ['loadstart', 'loadedmetadata', 'playing', 'pause', 'waiting', 'stalled', 'seeking', 'seeked', 'ended', 'error']) {
    video.addEventListener(event, () => log(event === 'error' ? `Media error ${video.error?.code ?? 'unknown'}` : `Media: ${event}`));
  }
  window.addEventListener('error', event => log(`Script error at line ${event.lineno || '?'}`));
  window.addEventListener('unhandledrejection', () => log('Unhandled promise rejection'));

  function open() {
    if (dialog.open) return;
    render();
    dialog.showModal();
    timer = window.setInterval(render, 1000);
  }

  dialog.addEventListener('close', () => window.clearInterval(timer));
  document.querySelector('#library-diagnostics')?.addEventListener('click', open);
  document.querySelector('#player-diagnostics')?.addEventListener('click', open);

  return { dialog, log };
}
