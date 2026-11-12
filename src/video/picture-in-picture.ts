import { DesktopVideoStream } from './desktop-stream';
/** Native video PiP only: no cloning, reparenting or restarting the media element. */
export function installPictureInPictureControls(doc: Document = document) {
  const win = doc.defaultView;
  if (!win || !('requestPictureInPicture' in win.HTMLVideoElement.prototype)) return () => {};
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
    .control { position: fixed; display: flex; align-items: flex-end; flex-direction: column; gap: 4px;
      max-width: calc(100vw - 16px); opacity: 0; pointer-events: none; }
    .control[data-hovered], .control:has(button:focus-visible), .control:has(.status:not([hidden])) { opacity: 1; pointer-events: auto; }
    @media (hover: none) {
      .control { opacity: 1; pointer-events: auto; }
    }
    [hidden] { display: none !important; }
    button { display: grid; place-items: center; width: 34px; height: 34px; padding: 0;
      border: 1px solid #ffffff50; border-radius: 8px; background: #24232bef; color: #fff;
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

  const controls = new Map<HTMLVideoElement, { update: () => void; hover: (target: EventTarget | null) => void; dispose: () => void }>();
  let pointer: { x: number; y: number; target: EventTarget | null } | null = null;
  let frame = 0;
  let disposed = false;
  const resize = new ResizeObserver(() => schedule());

  function makeIconButton(outline: string) {
    const button = doc.createElement('button');
    button.type = 'button';
    const icon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');
    const path = doc.createElementNS(icon.namespaceURI, 'path');
    path.setAttribute('d', outline);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.7');
    icon.append(path);
    button.append(icon);
    return button;
  }

  function attach(video: HTMLVideoElement) {
    const element = doc.createElement('div');
    element.className = 'control';
    const button = makeIconButton('M3 4h18v16H3z M12 12h7v6h-7z');
    const desktopButton = makeIconButton('M3 4h15v11H3z M8 17v2h5 M14 11h7v8h-7z');
    const status = doc.createElement('p');
    status.className = 'status';
    status.setAttribute('role', 'status');
    status.hidden = true;
    desktopButton.hidden = !/Mac/i.test(navigator.platform);
    element.append(button, desktopButton, status);
    shadow.append(element);
    let busy = false;
    let rect = video.getBoundingClientRect();
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

    function hover(target: EventTarget | null) {
      const onControl = target === host && element.matches(':hover');
      const overVideo = pointer && pointer.x >= rect.left && pointer.x < rect.right
        && pointer.y >= rect.top && pointer.y < rect.bottom;
      element.toggleAttribute('data-hovered', !element.hidden && !!(onControl || overVideo));
    }

    function update() {
      const active = doc.pictureInPictureElement === video;
      const text = active ? 'Exit picture in picture' : 'Picture in picture';
      button.setAttribute('aria-label', text);
      button.setAttribute('aria-pressed', String(active));
      button.disabled = busy;
      desktopButton.disabled = busy;
      const desktopLabel = desktop.active ? 'Exit picture in picture across desktops' : 'Picture in picture across desktops';
      desktopButton.setAttribute('aria-label', desktopLabel);
      desktopButton.setAttribute('aria-pressed', String(desktop.active));
      rect = video.getBoundingClientRect();
      const visible = rect.width >= 180 && rect.height >= 90 && rect.bottom > 40
        && rect.top < win!.innerHeight - 40 && rect.right > 40 && rect.left < win!.innerWidth - 40
        && win!.getComputedStyle(video).visibility !== 'hidden'
        && win!.getComputedStyle(video).display !== 'none';
      element.hidden = !visible || video.readyState === 0 || video.videoWidth === 0
        || (video.disablePictureInPicture && !active) || Boolean(doc.fullscreenElement);
      element.style.top = `${Math.max(8, rect.top + 8)}px`;
      element.style.right = `${Math.max(8, win!.innerWidth - rect.right + 8)}px`;
      hover(pointer?.target ?? null);
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
    controls.set(video, { update, hover, dispose: () => {
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
  function trackPointer(event: PointerEvent) {
    if (event.pointerType === 'touch') return;
    pointer = { x: event.clientX, y: event.clientY, target: event.target };
    for (const control of controls.values()) control.hover(event.target);
  }
  function clearPointer(event: PointerEvent) {
    if (event.relatedTarget !== null) return;
    pointer = null;
    for (const control of controls.values()) control.hover(null);
  }
  const observer = new MutationObserver(schedule);
  observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true,
    attributeFilter: ['data-arc-study-video', 'disablepictureinpicture', 'class', 'style', 'hidden', 'src'] });
  win.addEventListener('scroll', schedule, true);
  win.addEventListener('resize', schedule);
  win.addEventListener('pageshow', schedule);
  doc.addEventListener('pointermove', trackPointer, { capture: true, passive: true });
  doc.addEventListener('pointerout', clearPointer, { capture: true, passive: true });
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
    doc.removeEventListener('pointermove', trackPointer, true);
    doc.removeEventListener('pointerout', clearPointer, true);
    doc.removeEventListener('fullscreenchange', schedule);
    for (const control of controls.values()) control.dispose();
    controls.clear();
    host.remove();
  };
}
