export function safariApi(): typeof chrome {
  const scope = globalThis as typeof globalThis & { browser?: typeof chrome };
  const api = scope.browser || scope.chrome;
  if (!api?.runtime || !api?.storage) throw new Error('Safari extension APIs are unavailable.');
  return api;
}
