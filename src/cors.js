export function normalizeOrigin(value) {
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
}

export function normalizeAllowedOrigins(value) {
  const values = Array.isArray(value) ? value : String(value ?? '').split(',');
  return values
    .map((origin) => normalizeOrigin(origin))
    .filter(Boolean);
}

export function isAllowedOrigin(origin, configuredOrigins = []) {
  const normalizedOrigin = normalizeOrigin(origin);

  if (!normalizedOrigin) {
    return true;
  }

  const normalizedConfiguredOrigins = normalizeAllowedOrigins(configuredOrigins);
  const isLocalDevelopmentOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(normalizedOrigin);

  return normalizedConfiguredOrigins.includes(normalizedOrigin) || isLocalDevelopmentOrigin;
}
