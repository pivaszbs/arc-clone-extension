// Chrome serializes this function into the player frame's main world.
export async function captureCaptionResponses(): Promise<string[]> {
  const bodies = new Set<string>();
  const maxBody = 1024 * 1024;
  let remaining = 3 * maxBody;
  let active = true;
  const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  const xhrListeners = new Map<XMLHttpRequest, () => void>();
  const originalFetch = window.fetch;
  const originalSend = XMLHttpRequest.prototype.send;

  function subtitleResponse(url: string, contentType: string) {
    if (!active || bodies.size >= 12 || remaining <= 0) return false;
    const mime = contentType.split(';')[0].trim().toLowerCase();
    if (/^(audio|video|image)\//.test(mime)) return false;
    if (/^(text\/vtt|application\/(ttml\+xml|x-subrip|x-ass|x-ssa|vtt))$/.test(mime)) return true;
    const path = new URL(url).pathname;
    return /\.(vtt|srt|ass|ssa|ttml|dfxp)$/i.test(path) || /(?:^|\/)(timedtext|captions?|subtitles?)(?:\/|$)/i.test(path);
  }
  function collect(body: string) {
    if (!active || bodies.size >= 12 || !body || body.length > maxBody || body.length > remaining || bodies.has(body)) return;
    bodies.add(body);
    remaining -= body.length;
  }
  async function read(response: Response) {
    if (!response.ok || !subtitleResponse(response.url, response.headers.get('content-type') || '')
      || Number(response.headers.get('content-length')) > maxBody || readers.size >= 4) return;
    const reader = response.clone().body?.getReader();
    if (!reader) return;
    readers.add(reader);
    const decoder = new TextDecoder();
    let body = '';
    let bytes = 0;
    try {
      while (active) {
        const { done, value } = await reader.read();
        if (done) { collect(body + decoder.decode()); return; }
        bytes += value.byteLength;
        if (bytes > maxBody) return;
        body += decoder.decode(value, { stream: true });
      }
    } finally {
      readers.delete(reader);
      void reader.cancel().catch(() => {});
    }
  }
  const fetchWithCaptions: typeof fetch = function (...args) {
    const response = Reflect.apply(originalFetch, window, args) as Promise<Response>;
    void response.then(read).catch(() => {});
    return response;
  };
  const sendWithCaptions: typeof XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body) {
    const xhr = this;
    const onEnd = () => {
      xhrListeners.delete(xhr);
      try {
        if (xhr.status < 200 || xhr.status >= 300 || !subtitleResponse(xhr.responseURL, xhr.getResponseHeader('content-type') || '')) return;
        if (!xhr.responseType || xhr.responseType === 'text') collect(xhr.responseText);
        else if (xhr.responseType === 'json') collect(JSON.stringify(xhr.response));
        else if (xhr.responseType === 'blob' && xhr.response?.size <= maxBody) void xhr.response.text().then(collect).catch(() => {});
        else if (xhr.responseType === 'arraybuffer' && xhr.response?.byteLength <= maxBody) collect(new TextDecoder().decode(xhr.response));
      } catch { /* The page retains ownership of the request and response. */ }
    };
    xhr.addEventListener('loadend', onEnd, { once: true });
    xhrListeners.set(xhr, onEnd);
    try { return originalSend.call(xhr, body); }
    catch (error) {
      xhr.removeEventListener('loadend', onEnd);
      xhrListeners.delete(xhr);
      throw error;
    }
  };
  try {
    window.fetch = fetchWithCaptions;
    XMLHttpRequest.prototype.send = sendWithCaptions;
    await new Promise(resolve => setTimeout(resolve, 10000));
  } finally {
    active = false;
    if (window.fetch === fetchWithCaptions) window.fetch = originalFetch;
    if (XMLHttpRequest.prototype.send === sendWithCaptions) XMLHttpRequest.prototype.send = originalSend;
    for (const [xhr, handler] of xhrListeners) xhr.removeEventListener('loadend', handler);
    for (const reader of readers) void reader.cancel().catch(() => {});
  }
  return [...bodies];
}
