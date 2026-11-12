const HOST = 'local.arcclone.desktop_video_v2';
let port: chrome.runtime.Port | undefined;
let active: { sessionId: string; tabId: number; frameId: number; ready?: (value: any) => void; timer?: ReturnType<typeof setTimeout> } | undefined;
const statusRequests = new Map<string, { resolve: (value: any) => void; timer: ReturnType<typeof setTimeout> }>();

function notify(message: Record<string, unknown>) {
  if (active) void chrome.tabs.sendMessage(active.tabId, { type: 'DESKTOP_PIP_EVENT', ...message }, { frameId: active.frameId }).catch(() => {});
}
function disconnected() {
  const reason = chrome.runtime.lastError?.message || 'The desktop player disconnected.';
  active?.ready?.({ ok: false, error: `${reason} Build and install the macOS desktop PiP companion.` });
  if (active?.timer) clearTimeout(active.timer);
  notify({ event: 'closed', sessionId: active?.sessionId, error: reason });
  active = undefined; port = undefined;
  for (const pending of statusRequests.values()) { clearTimeout(pending.timer); pending.resolve({ ok: false, error: reason }); }
  statusRequests.clear();
}
function connect() {
  if (port) return port;
  const connected = chrome.runtime.connectNative(HOST);
  port = connected;
  connected.onDisconnect.addListener(() => { if (port === connected) disconnected(); });
  port.onMessage.addListener((message) => {
    if (message.type === 'status') {
      const pending = statusRequests.get(message.requestId);
      if (pending) {
        clearTimeout(pending.timer); statusRequests.delete(message.requestId);
        if (active) void chrome.tabs.sendMessage(active.tabId, { type: 'DESKTOP_PIP_SOURCE_STATE', sessionId: active.sessionId }, { frameId: active.frameId }).then(source => pending.resolve({ ok: true, ...message, source })).catch(() => pending.resolve({ ok: true, ...message }));
        else pending.resolve({ ok: true, ...message });
      }
      return;
    }
    if (message.sessionId !== active?.sessionId) return;
    if (message.type === 'ready') {
      if (active?.timer) clearTimeout(active.timer);
      active?.ready?.({ ok: true, ...message });
      if (active) active.ready = undefined;
    } else {
      if (message.type === 'error') active?.ready?.({ ok: false, error: message.error });
      notify({ ...message, event: message.type });
      if (message.type === 'closed' || message.type === 'error') {
        if (active?.timer) clearTimeout(active.timer);
        active = undefined;
        const closing = port; port = undefined; closing?.disconnect();
      }
    }
  });
  return port;
}
export async function desktopPipRequest(message: any, sender: chrome.runtime.MessageSender) {
  if (message.type === 'DESKTOP_PIP_OPEN') {
    if (sender.tab?.id === undefined) throw new Error('Open desktop PiP from a video page.');
    if (active?.timer) clearTimeout(active.timer);
    if (active) { notify({ event: 'closed', sessionId: active.sessionId }); port?.postMessage({ type: 'close' }); }
    const sessionId = crypto.randomUUID();
    return new Promise((resolve) => {
      active = { sessionId, tabId: sender.tab!.id!, frameId: sender.frameId || 0, ready: resolve };
      active.timer = setTimeout(() => { active?.ready?.({ ok: false, error: 'The desktop player did not start. Check its installation.' }); active!.ready = undefined; }, 15000);
      try { connect().postMessage({ type: 'open', sessionId, muted: Boolean(message.muted), volume: Number(message.volume ?? 1) }); }
      catch { disconnected(); }
    });
  }
  if (message.type === 'DESKTOP_PIP_STATUS') {
    if (!active || !port) return { ok: true, active: false };
    return new Promise((resolve) => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => { statusRequests.delete(requestId); resolve({ ok: false, error: 'Desktop player status timed out.' }); }, 3000);
      statusRequests.set(requestId, { resolve, timer });
      port!.postMessage({ type: 'status', requestId });
    });
  }
  if (!active || message.sessionId !== active.sessionId || sender.tab?.id !== active.tabId || (sender.frameId || 0) !== active.frameId) {
    throw new Error('The desktop PiP session is no longer active.');
  }
  if (message.type === 'DESKTOP_PIP_START') {
    port?.postMessage({ type: 'start', sessionId: active.sessionId, mime: message.mime, paused: Boolean(message.paused) });
  } else if (message.type === 'DESKTOP_PIP_PLAYBACK') {
    port?.postMessage({ type: 'playback', sessionId: active.sessionId, paused: Boolean(message.paused), failed: Boolean(message.failed) });
  } else if (message.type === 'DESKTOP_PIP_CHUNK') {
    if (typeof message.data !== 'string' || message.data.length > 1_400_000) throw new Error('Desktop video chunk is too large.');
    port?.postMessage({ type: 'chunk', sessionId: active.sessionId, data: message.data });
  } else if (message.type === 'DESKTOP_PIP_CLOSE') {
    port?.postMessage({ type: 'close' });
    notify({ event: 'closed', sessionId: active.sessionId });
    active = undefined;
    port?.disconnect(); port = undefined;
  }
  return { ok: true };
}

function closeForTab(tabId: number) {
  if (active?.tabId !== tabId) return;
  if (active.timer) clearTimeout(active.timer);
  active = undefined;
  const closing = port; port = undefined;
  closing?.disconnect();
}
chrome.tabs.onRemoved.addListener(closeForTab);
chrome.tabs.onUpdated.addListener((tabId, change) => { if (change.status === 'loading') closeForTab(tabId); });
