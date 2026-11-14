// The sync engine lives in ../shared so the phone, Chrome and TV apps all use the same code.
// The Anime365 series planner is reused from the extension (../src/japanese).
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const extensionCode = path.resolve(__dirname, '../src/japanese');
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, '../shared'), extensionCode];

// Packages imported by the extension's files (parse5) resolve from this app's node_modules,
// which Metro watches, instead of the repo root's.
const resolveFromApp = { originModulePath: path.join(__dirname, 'index.ts') };
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const fromExtension = context.originModulePath.startsWith(extensionCode + path.sep);
  const bare = !moduleName.startsWith('.') && !path.isAbsolute(moduleName);
  return context.resolveRequest(fromExtension && bare ? { ...context, ...resolveFromApp } : context, moduleName, platform);
};
module.exports = config;
