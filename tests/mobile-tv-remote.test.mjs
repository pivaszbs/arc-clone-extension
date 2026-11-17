import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync('mobile/App.tsx', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

// Render the real app composition with native views represented as element objects.
// Deliver TV state through the same client callback used by the WebSocket connection.
function app(tab = 'watch', source = 'server') {
  const slots = [], effects = [], commands = [];
  let cursor = 0, receiveTv;
  const hook = init => {
    const i = cursor++;
    if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init;
    return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }];
  };
  const noop = () => {};
  const jsx = (type, props) => ({ type, props });
  const catalog = [{ folder: 'series', title: 'Series', episodes: [] }];
  const fallback = new Proxy({}, { get: (_, name) => name });
  const modules = {
    react: {
      useState: hook, useRef: value => hook(() => ({ current: value }))[0],
      useMemo: fn => fn(), useCallback: fn => fn, useEffect: fn => effects.push(fn),
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { ...Object.fromEntries(['View', 'Text', 'Pressable', 'ActivityIndicator'].map(x => [x, x])),
      StyleSheet: { create: x => x, absoluteFill: {}, hairlineWidth: 1 },
      Platform: { OS: 'ios' }, useWindowDimensions: () => ({ width: 390 }),
    },
    'react-native-safe-area-context': { SafeAreaProvider: 'SafeAreaProvider', SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 44, bottom: 34 }) },
    './src/theme': { colors: {}, radius: {}, space: {}, type: {} },
    './src/lib/storage': { settings: () => ({ source, tab }), cachedCatalog: () => catalog, allProgress: () => ({}), saveSettings: noop },
    './src/lib/crash-log': { installCrashLog: noop },
    './src/components/SeriesGallery': { SeriesGallery: 'SeriesGallery', seriesGroups: list => list.map(item => ({ entries: [item] })) },
    './src/lib/library': { readLibrary: () => catalog },
    './src/lib/episode-downloads': { episodeDownloads: {} },
    './src/lib/worker-node': { PhoneWorkerNode: class {} },
    './src/lib/tv-sync': {
      normalizeTvServerUrl: () => 'http://test/',
      TvSyncClient: class {
        constructor(...args) { receiveTv = args[6]; }
        connect() {} log() {}
        sendTvControl(command) { commands.push(command); }
      },
    },
  };
  const exports = {};
  runInNewContext(code, { exports, require: name => modules[name] ?? fallback, console });
  const Study = exports.default().props.children.type;
  const render = () => { cursor = 0; effects.length = 0; return Study(); };
  render();
  effects.find(effect => effect.toString().includes('new tv_sync_1.TvSyncClient'))();
  return { render, commands, receive: value => receiveTv(value) };
}

function visibleRemote(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) return node.map(visibleRemote).find(Boolean);
  const style = [node.props?.style].flat().filter(Boolean);
  if (style.some(s => s.display === 'none')) return null;
  if (node.type === 'TvRemotePanel') return node;
  return Object.values(node.props ?? {}).map(visibleRemote).find(Boolean);
}

for (const tab of ['watch', 'download', 'pipelines']) {
  for (const source of ['server', 'local']) {
    test(`TV remote is reachable on ${tab} with ${source} library without opening a series`, () => {
      const ui = app(tab, source);
      ui.receive({ active: true, paused: false });
      const remote = visibleRemote(ui.render());
      assert.ok(remote, 'Active TV must have visible remote controls');
      remote.props.onCommand({ action: 'pause' });
      assert.deepEqual(ui.commands, [{ action: 'pause' }]);
      remote.props.onPlayOnPhone();
      assert.ok(visibleRemote(ui.render()), 'Choosing phone playback must not lose access to the TV remote');
      ui.receive({ active: false });
      assert.equal(visibleRemote(ui.render()) ?? null, null);
    });
  }
}
