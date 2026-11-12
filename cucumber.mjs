export default {
  paths: ['features/**/*.feature'],
  import: ['features/support/*.mjs', 'features/steps/*.mjs'],
  format: ['progress', `json:artifacts/e2e/${process.env.E2E_BROWSER || 'chromium'}.json`],
  tags: process.platform === 'darwin' ? '' : 'not @desktop-pip',
  parallel: 1
};
