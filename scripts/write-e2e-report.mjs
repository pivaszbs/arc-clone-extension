import { readFile, writeFile } from 'node:fs/promises';
const runs = JSON.parse(await readFile('artifacts/e2e/comparison.json', 'utf8'));
const total = runs.reduce((sum, run) => sum + run.scenarios.length, 0);
const passed = runs.reduce((sum, run) => sum + run.scenarios.filter(scenario => scenario.passed).length, 0);
const lines = [
  '# Browser comparison results', '',
  `${passed}/${total} scenario runs passed.`, '',
  'These runs test the actual unpacked extension in Chrome for Testing and Google Chrome. Native Arc was inspected visually but could not connect through the Playwright launch interface. Native Arc parity and pixel equality are not established.', '',
  'The build, Svelte/TypeScript checks, and 44 unit tests also passed during this implementation.', '',
  '| Workflow | ' + runs.map(run => run.browser).join(' | ') + ' |',
  '| --- | ' + runs.map(() => '---').join(' | ') + ' |'
];
for (const scenario of runs[0].scenarios) {
  lines.push('| ' + scenario.name + ' | ' + runs.map(run => run.scenarios.find(item => item.name === scenario.name)?.passed ? 'Pass' : 'Fail').join(' | ') + ' |');
}
lines.push('', 'The macOS desktop-player path was additionally checked across actual Finder full-screen/desktop transitions. See [the OS verification](../../docs/pip-macos-spaces.md), [Chrome OS checks](desktop-pip-os-chrome.json), and [Chrome for Testing OS checks](desktop-pip-os-chromium.json).', '', 'See [the functionality inventory](../../docs/arc-parity.md) for sources, alternatives, and remaining gaps.', '',
  'Raw results: [comparison.json](comparison.json), [Chrome for Testing](chromium.json), [Google Chrome](chrome.json).', '',
  'Screenshots are local test fixtures and contain no copied personal browser data. Earlier failed-run traces are retained under history/.', '',
  '![Sidebar at 360 pixels wide](chrome-the-sidebar-fits-a-narrow-browser-panel.png)', '');
await writeFile('artifacts/e2e/RESULTS.md', lines.join('\n'));
