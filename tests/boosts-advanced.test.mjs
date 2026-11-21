import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: ['src/shared/site-tools.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral'
});
const { compileBoostCss, boostsFor } = await import(
  `data:text/javascript,${encodeURIComponent(compiled.outputFiles[0].text)}`
);

test('compileBoostCss generates zapped selectors, image-safe invert filters, tint overlay, typography, and custom CSS', () => {
  const css = compileBoostCss({
    id: 'b1',
    host: 'example.com',
    enabled: true,
    zappedSelectors: ['.banner', '#cookie-wall'],
    invert: true,
    hue: 45,
    brightness: 110,
    contrast: 105,
    tintColor: '#6366f1',
    tintIntensity: 25,
    fontFamily: 'Georgia, serif',
    fontSize: 120,
    textCase: 'upper',
    css: 'main { max-width: 720px; }'
  });

  assert.match(css, /\.banner, #cookie-wall \{ display: none !important; \}/);
  assert.match(css, /invert\(1\) hue-rotate\(180deg\)/);
  assert.match(css, /img, video, picture, canvas, svg \{ filter: invert\(1\) hue-rotate\(180deg\) !important; \}/);
  assert.match(css, /hue-rotate\(45deg\)/);
  assert.match(css, /brightness\(110%\)/);
  assert.match(css, /contrast\(105%\)/);
  assert.match(css, /background: #6366f1; opacity: 0\.25; mix-blend-mode: multiply/);
  assert.match(css, /font-family: Georgia, serif !important;/);
  assert.match(css, /font-size: 120% !important;/);
  assert.match(css, /text-transform: uppercase !important;/);
  assert.match(css, /main \{ max-width: 720px; \}/);
});

test('boostsFor matches subdomains and ignores disabled or unrelated hosts', () => {
  const list = [
    { id: '1', host: 'github.com', css: '', enabled: true, zappedSelectors: ['.ad'] },
    { id: '2', host: 'gist.github.com', css: 'body {}', enabled: false }
  ];
  assert.equal(boostsFor(list, 'https://gist.github.com/user').length, 1);
  assert.equal(boostsFor(list, 'https://evilgithub.com/').length, 0);
});
