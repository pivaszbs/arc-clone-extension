import { DesktopVideoStream } from './desktop-stream';
import { canMountStudy, OPEN_JAPANESE_STUDY } from '../japanese/study';
/** Native video PiP only: no cloning, reparenting or restarting the media element. */
export function installPictureInPictureControls(doc: Document = document) {
  const win = doc.defaultView;
  if (!win || !('requestPictureInPicture' in win.HTMLVideoElement.prototype)) return () => {};
  const studyAvailable = canMountStudy(win);
  const hostId = 'arc-video-picture-in-picture';
  if (doc.getElementById(hostId)) return () => {};

  const host = doc.createElement('div');
  host.id = hostId;
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = doc.createElement('style');
  style.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .control { position: fixed; pointer-events: auto; max-width: calc(100vw - 16px); }
    [hidden] { display: none !important; }
    button { display: flex; align-items: center; gap: 7px; border: 1px solid #ffffff50; border-radius: 8px;
      background: #24232beF; color: #fff; padding: 8px 10px; font-size: 12px; font-weight: 500;
      cursor: pointer; box-shadow: 0 2px 12px #0005; }
    button:hover { background: #3c394c; }
    button:focus-visible { outline: 2px solid #bdb4ff; outline-offset: 3px; }
    button:disabled { opacity: .65; cursor: wait; }
    svg { width: 18px; height: 18px; flex: none; }
    .status { max-width: 260px; padding: 9px; margin: 5px 0 0; border-radius: 8px;
      color: #fff; background: #24232b; font-size: 12px; line-height: 1.4; box-shadow: 0 2px 12px #0005; }
  `;
  shadow.append(style);
  doc.documentElement.append(host);

  const controls = new Map<HTMLVideoElement, { element: HTMLDivElement; button: HTMLButtonElement; update: () => void; dispose: () => void }>();
  let frame = 0;
  let disposed = false;
  const resize = new ResizeObserver(() => schedule());

  function attach(video: HTMLVideoElement) {
    const element = doc.createElement('div');
    element.className = 'control';
    const button = doc.createElement('button');
    button.type = 'button';
    const icon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');
    const path = doc.createElementNS(icon.namespaceURI, 'path');
    path.setAttribute('d', 'M3 4h18v16H3z M12 12h7v6h-7z');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.7');
    icon.append(path);
    const label = doc.createElement('span');
    const status = doc.createElement('p');
    status.className = 'status';
    status.setAttribute('role', 'status');
    status.hidden = true;
    button.append(icon, label);
    element.append(button, status);
    shadow.append(element);
    let busy = false;
    const desktopButton = doc.createElement('button');
    desktopButton.type = 'button';
    desktopButton.textContent = 'Across desktops';
    desktopButton.setAttribute('aria-label', 'Picture in picture across desktops');
    desktopButton.style.marginTop = '4px';
    desktopButton.hidden = !/Mac/i.test(navigator.platform);
    element.insertBefore(desktopButton, status);
    const studyButton = doc.createElement('button');
    studyButton.type = 'button';
    studyButton.textContent = 'Learn Japanese';
    studyButton.style.marginTop = '4px';
    studyButton.addEventListener('click', (event) => {
      event.stopPropagation();
      video.dispatchEvent(new Event(OPEN_JAPANESE_STUDY, { bubbles: true }));
    });
    if (studyAvailable) element.insertBefore(studyButton, status);
    const desktop = new DesktopVideoStream(video, update, (message) => {
      status.textContent = message; status.hidden = false;
    });
    desktopButton.addEventListener('click', async (event) => {
      event.preventDefault(); event.stopPropagation();
      if (busy) return;
      busy = true; status.hidden = true; update();
      try {
        if (desktop.active) desktop.stop(); else await desktop.start();
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : 'The desktop player could not start.';
        status.hidden = false;
      } finally { busy = false; update(); }
    });

    function update() {
      const active = doc.pictureInPictureElement === video;
      const text = active ? 'Exit picture in picture' : 'Picture in picture';
      label.textContent = text;
      button.setAttribute('aria-label', text);
      button.setAttribute('aria-pressed', String(active));
      button.title = text;
      button.disabled = busy;
      desktopButton.disabled = busy;
      desktopButton.textContent = desktop.active ? 'Return to page' : 'Across desktops';
      desktopButton.setAttribute('aria-label', desktop.active ? 'Exit picture in picture across desktops' : 'Picture in picture across desktops');
      desktopButton.setAttribute('aria-pressed', String(desktop.active));
      const rect = video.getBoundingClientRect();
      const visible = rect.width >= 180 && rect.height >= 90 && rect.bottom > 40
        && rect.top < win!.innerHeight - 40 && rect.right > 40 && rect.left < win!.innerWidth - 40
        && win!.getComputedStyle(video).visibility !== 'hidden'
        && win!.getComputedStyle(video).display !== 'none';
      const pipDisabled = video.disablePictureInPicture && !active;
      button.hidden = pipDisabled;
      desktopButton.hidden = pipDisabled || !/Mac/i.test(navigator.platform);
      element.hidden = !visible || video.readyState === 0 || video.videoWidth === 0
        || (pipDisabled && !studyAvailable) || Boolean(doc.fullscreenElement);
      element.style.top = `${Math.max(8, rect.top + 8)}px`;
      element.style.right = `${Math.max(8, win!.innerWidth - rect.right + 8)}px`;
    }

    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (busy) return;
      if (desktop.active) desktop.stop();
      busy = true;
      status.hidden = true;
      try {
        // Invoke directly from the click to retain transient user activation.
        const operation = doc.pictureInPictureElement === video
          ? doc.exitPictureInPicture() : video.requestPictureInPicture();
        update();
        await operation;
      } catch (error) {
        const name = error instanceof Error ? error.name : '';
        status.textContent = name === 'SecurityError' ? 'Picture in picture is blocked on this page.'
          : name === 'NotAllowedError' ? 'Click the video, then try picture in picture again.'
          : name === 'InvalidStateError' ? 'Play the video first, then try again.'
          : 'Picture in picture is unavailable. You can try again.';
        status.hidden = false;
      } finally {
        busy = false;
        update();
      }
    });
    const events = ['loadedmetadata', 'loadeddata', 'emptied', 'resize', 'enterpictureinpicture', 'leavepictureinpicture'];
    for (const type of events) video.addEventListener(type, schedule);
    resize.observe(video);
    controls.set(video, { element, button, update, dispose: () => {
      for (const type of events) video.removeEventListener(type, schedule);
      resize.unobserve(video);
      if (desktop.active) desktop.stop();
      element.remove();
    } });
  }

  function refresh() {
    frame = 0;
    if (disposed) return;
    for (const [video, control] of controls) {
      if (!video.isConnected) { control.dispose(); controls.delete(video); }
    }
    for (const video of doc.querySelectorAll('video')) if (!controls.has(video)) attach(video);
    for (const control of controls.values()) control.update();
  }
  function schedule() {
    if (!frame && !disposed) frame = win!.requestAnimationFrame(refresh);
  }
  const observer = new MutationObserver(schedule);
  observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true,
    attributeFilter: ['disablepictureinpicture', 'class', 'style', 'hidden', 'src'] });
  win.addEventListener('scroll', schedule, true);
  win.addEventListener('resize', schedule);
  win.addEventListener('pageshow', schedule);
  doc.addEventListener('fullscreenchange', schedule);
  refresh();

  return () => {
    disposed = true;
    win.cancelAnimationFrame(frame);
    observer.disconnect();
    resize.disconnect();
    win.removeEventListener('scroll', schedule, true);
    win.removeEventListener('resize', schedule);
    win.removeEventListener('pageshow', schedule);
    doc.removeEventListener('fullscreenchange', schedule);
    for (const control of controls.values()) control.dispose();
    controls.clear();
    host.remove();
  };
}
