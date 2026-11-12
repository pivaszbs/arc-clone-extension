// Exercises the real background dispatcher with disposable, in-memory Chrome APIs.
export async function installPreviewChrome() {
  type Listener = (...args: any[]) => any;
  function event() {
    const listeners: Listener[] = [];
    return { listeners, addListener: (listener: Listener) => listeners.push(listener),
      removeListener: (listener: Listener) => { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); },
      emit: (...args: any[]) => Promise.all(listeners.map((listener) => listener(...args))) };
  }
  const messages = event();
  const activated = event();
  const updated = event();
  const removed = event();
  let nextId = 10;
  let tabs = [
    { id: 1, windowId: 1, index: 0, title: 'Designing for the web', url: 'https://developer.apple.com/design/', active: true },
    { id: 2, windowId: 1, index: 1, title: 'A guide to better typography', url: 'https://fonts.google.com/knowledge', active: false },
    { id: 3, windowId: 1, index: 2, title: 'Hacker News', url: 'https://news.ycombinator.com/', active: false },
    { id: 4, windowId: 1, index: 3, title: 'An unusually long tab title that should truncate without displacing any controls', url: 'https://example.com/reading', active: false }
  ];
  let stored: Record<string, unknown> = {};
  const api = {
    runtime: {
      onMessage: messages, onInstalled: event(), onStartup: event(), getURL: (path: string) => `https://example.com/${path}`,
      async sendMessage(message: any) {
        if (message.type === 'ARC_STATE_UPDATED') {
          for (const listener of messages.listeners.slice(1)) listener(message, {}, () => {});
          return {};
        }
        if (message.type === 'TRANSLATE_TEXT') return { translatedText: 'This is a sample translation for the local preview.', detectedSourceLang: 'en' };
        if (message.type === 'SEARCH_OMNIBOX' && message.query === 'offline') throw new Error('Preview connection failure');
        return new Promise((resolve) => messages.listeners[0](message, {}, (result: unknown) => resolve(structuredClone(result))));
      }
    },
    storage: { local: { get: async () => structuredClone(stored), set: async (value: Record<string, unknown>) => { stored = structuredClone({ ...stored, ...value }); } } },
    tabs: {
      onCreated: event(), onActivated: activated, onUpdated: updated, onRemoved: removed,
      query: async (query: any) => structuredClone(tabs.filter((tab) => !query.active || tab.active)),
      get: async (id: number) => structuredClone(tabs.find((tab) => tab.id === id)),
      getCurrent: async () => undefined,
      update: async (id: number, change: any) => {
        const tab = tabs.find((tab) => tab.id === id); if (!tab) throw new Error('Tab is no longer open');
        if (change.active) tabs.forEach((tab) => tab.active = false);
        Object.assign(tab, change);
        if (change.active) await activated.emit({ tabId: id, windowId: 1 });
        await updated.emit(id, change, tab);
        return structuredClone(tab);
      },
      create: async (options: any) => {
        if (options.active) tabs.forEach((tab) => tab.active = false);
        const tab = { id: nextId++, windowId: 1, index: tabs.length, title: options.url, ...options };
        tabs.push(tab); return structuredClone(tab);
      },
      remove: async (ids: number | number[]) => { for (const id of Array.isArray(ids) ? ids : [ids]) { tabs = tabs.filter((tab) => tab.id !== id); await removed.emit(id); } },
      move: async () => {},
      sendMessage: async (_id: number, message: any) => { for (const listener of messages.listeners.slice(1)) listener(message, {}, () => {}); return { ok: true }; }
    },
    windows: { getCurrent: async () => ({ id: 1, type: 'normal' }), get: async () => ({ id: 1, type: 'normal' }), update: async () => {}, create: async () => ({ id: 2 }) },
    contextMenus: { onClicked: event() }, commands: { onCommand: event() },
    bookmarks: { search: async () => [] }, history: { search: async () => [] }
  };
  Object.defineProperty(window, 'chrome', { configurable: true, value: api });
  await import('../background/index');
}
