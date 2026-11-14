import { Directory, File, Paths } from 'expo-file-system';

const stateDir = new Directory(Paths.document, '.anime-study');
const errorFile = new File(stateDir, 'errors.log');

/** Append an error to Documents/.anime-study/errors.log, so its cause can be read from the device. */
export function logError(context: string, error: unknown) {
  try {
    if (!stateDir.exists) stateDir.create({ intermediates: true });
    const previous = errorFile.exists ? errorFile.textSync().slice(-20_000) : '';
    const message = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error);
    errorFile.write(`${previous}[${new Date().toISOString()}] ${context}: ${message}\n`);
  } catch { /* Logging must never throw. */ }
}

/** Record crashes so their cause can be read from the device afterwards. */
export function installCrashLog() {
  const utils = (globalThis as { ErrorUtils?: { getGlobalHandler(): (e: unknown, fatal?: boolean) => void; setGlobalHandler(h: (e: unknown, fatal?: boolean) => void): void } }).ErrorUtils;
  if (!utils) return;
  const previous = utils.getGlobalHandler();
  utils.setGlobalHandler((error, fatal) => {
    logError(fatal ? 'FATAL' : 'error', error);
    previous(error, fatal);
  });
}
