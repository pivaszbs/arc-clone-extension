import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: ['src/shared/live-folders.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral'
});
const { parseLiveFeed } = await import(
  `data:text/javascript,${encodeURIComponent(compiled.outputFiles[0].text)}`
);

test('parseLiveFeed parses RSS 2.0 items with CDATA and HTML entities', () => {
  const rss = `<?xml version="1.0"?>
  <rss><channel>
    <item><title><![CDATA[Hello &amp; Welcome]]></title><link>https://example.com/1</link></item>
    <item><title>Second Post</title><link>https://example.com/2</link></item>
  </channel></rss>`;
  const entries = parseLiveFeed(rss);
  assert.deepEqual(entries, [
    { title: 'Hello & Welcome', url: 'https://example.com/1' },
    { title: 'Second Post', url: 'https://example.com/2' }
  ]);
});

test('parseLiveFeed parses Atom entries and GitHub JSON PR/issue arrays', () => {
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom">
    <entry><title>Release 1.4</title><link rel="alternate" href="https://github.com/org/repo/releases/1.4"/><author><name>anton</name></author></entry>
  </feed>`;
  assert.deepEqual(parseLiveFeed(atom), [
    { title: 'Release 1.4', url: 'https://github.com/org/repo/releases/1.4', subtitle: 'anton' }
  ]);

  const githubJson = JSON.stringify([
    { title: 'Fix sync convergence', html_url: 'https://github.com/org/repo/pull/42', user: { login: 'octocat' } }
  ]);
  assert.deepEqual(parseLiveFeed(githubJson), [
    { title: 'Fix sync convergence', url: 'https://github.com/org/repo/pull/42', subtitle: '@octocat' }
  ]);
  assert.deepEqual(parseLiveFeed('not valid'), []);
});
