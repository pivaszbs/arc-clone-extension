import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
await mkdir('artifacts/e2e', { recursive: true });
if (process.platform === 'darwin') {
  const build=spawnSync(process.execPath,['scripts/build-desktop-pip.mjs'],{stdio:'inherit'});
  if (build.status !== 0) process.exit(build.status || 1);
}
const browsers = (process.env.E2E_BROWSERS || 'chromium,chrome').split(',');
const summary = [];
for (const browser of browsers) {
  const exitCode = await new Promise(resolve => {
    const child = spawn(process.execPath, ['node_modules/@cucumber/cucumber/bin/cucumber.js'], {
      stdio: 'inherit', env: { ...process.env, E2E_BROWSER: browser }
    });
    child.on('error', () => resolve(1)); child.on('exit', code => resolve(code ?? 1));
  });
  const report = JSON.parse(await readFile(`artifacts/e2e/${browser}.json`, 'utf8'));
  const scenarios = report.flatMap(feature => (feature.elements || []).map(scenario => ({
    name: scenario.name, passed: scenario.steps.every(step => step.result?.status === 'passed')
  })));
  summary.push({ browser, exitCode, scenarios });
}
await writeFile('artifacts/e2e/comparison.json', JSON.stringify(summary, null, 2) + '\n');
const names = summary.map(run => JSON.stringify(run.scenarios.map(scenario => scenario.name)));
if (summary.some(run => run.exitCode !== 0) || new Set(names).size !== 1) process.exitCode = 1;
console.log(`Browser comparison saved to artifacts/e2e/comparison.json. Native Arc parity is documented separately.`);
await import('./write-e2e-report.mjs');
