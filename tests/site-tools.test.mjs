import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['src/shared/site-tools.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral' });
const {
  DEFAULT_SITE_SEARCHES, boostsFor, matchSiteSearch, normalizePattern, routeFor, siteSearchUrl,
  suggestSiteSearches, validSiteSearchUrl
} = await import(`data:text/javascript,${encodeURIComponent(compiled.outputFiles[0].text)}`);

test('a pasted address becomes a host or host-and-path pattern', () => {
  assert.equal(normalizePattern(' https://www.GitHub.com/ '), 'github.com');
  assert.equal(normalizePattern('google.com/maps/?q=1#x'), 'google.com/maps');
});

test('a route matches its host and subdomains, never a look-alike host', () => {
  const rules = [{ id: 'a', pattern: 'github.com', spaceId: 'work' }];
  assert.equal(routeFor(rules, 'https://github.com/org/repo')?.spaceId, 'work');
  assert.equal(routeFor(rules, 'https://gist.github.com/x')?.spaceId, 'work');
  assert.equal(routeFor(rules, 'https://www.github.com/')?.spaceId, 'work');
  assert.equal(routeFor(rules, 'https://notgithub.com/'), undefined);
  assert.equal(routeFor(rules, 'https://github.com.evil.test/'), undefined);
  assert.equal(routeFor(rules, 'chrome://extensions'), undefined);
  assert.equal(routeFor(undefined, 'https://github.com/'), undefined);
});

test('the most specific route wins and a path matches whole segments', () => {
  const rules = [
    { id: 'a', pattern: 'google.com', spaceId: 'personal' },
    { id: 'b', pattern: 'google.com/maps', spaceId: 'travel' }
  ];
  assert.equal(routeFor(rules, 'https://www.google.com/maps/place/x')?.spaceId, 'travel');
  assert.equal(routeFor(rules, 'https://google.com/maps')?.spaceId, 'travel');
  assert.equal(routeFor(rules, 'https://google.com/mapsearch')?.spaceId, 'personal');
  assert.equal(routeFor(rules, 'https://docs.google.com/document')?.spaceId, 'personal');
});

test('a site search is chosen by shortcut or name and encodes the query', () => {
  const found = matchSiteSearch(DEFAULT_SITE_SEARCHES, 'yt lofi & chill');
  assert.equal(found.site.name, 'YouTube');
  assert.equal(siteSearchUrl(found.site, found.terms), 'https://www.youtube.com/results?search_query=lofi%20%26%20chill');
  assert.equal(matchSiteSearch(DEFAULT_SITE_SEARCHES, 'Wikipedia arc')?.site.shortcut, 'w');
  assert.equal(matchSiteSearch(DEFAULT_SITE_SEARCHES, 'yt'), undefined);
  assert.equal(matchSiteSearch(DEFAULT_SITE_SEARCHES, 'why is the sky blue'), undefined);
});

test('site searches are suggested while the shortcut or name is being typed', () => {
  assert.deepEqual(suggestSiteSearches(DEFAULT_SITE_SEARCHES, 'you').map((site) => site.name), ['YouTube']);
  assert.deepEqual(suggestSiteSearches(DEFAULT_SITE_SEARCHES, 'r').map((site) => site.name), ['Reddit']);
  assert.deepEqual(suggestSiteSearches(DEFAULT_SITE_SEARCHES, 'yt cats'), []);
  assert.deepEqual(suggestSiteSearches(DEFAULT_SITE_SEARCHES, ''), []);
});

test('a search URL needs a placeholder and a web address', () => {
  assert.ok(validSiteSearchUrl('https://example.com/?q=%s'));
  assert.ok(!validSiteSearchUrl('https://example.com/?q='));
  assert.ok(!validSiteSearchUrl('javascript:alert(%s)'));
});

test('only enabled, non-empty boosts for the host apply', () => {
  const boosts = [
    { id: 'a', host: 'example.com', css: 'body{}', enabled: true },
    { id: 'b', host: 'example.com', css: 'p{}', enabled: false },
    { id: 'c', host: 'other.test', css: 'p{}', enabled: true },
    { id: 'd', host: 'example.com', css: '  ', enabled: true }
  ];
  assert.deepEqual(boostsFor(boosts, 'https://app.example.com/page').map((boost) => boost.id), ['a']);
  assert.deepEqual(boostsFor(boosts, 'chrome://settings'), []);
});
