// The sync engine lives in ../shared so the phone, Chrome and TV apps all use the same code.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, '../shared')];
module.exports = config;
