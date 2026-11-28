const ALLOW = new Set([
  'PATH',
  'HOME',
  'USERPROFILE',
  'TEMP',
  'TMP',
  'TMPDIR',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'LD_LIBRARY_PATH',
  'FONTCONFIG_PATH',
  'FONTCONFIG_FILE',
  'PLAYWRIGHT_BROWSERS_PATH',
]);

const SECRET = /(API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|DASHSCOPE|DEEPSEEK|OPENAI|QWEN)/i;

/**
 * Browser processes must never inherit model credentials. Only non-secret OS
 * variables needed for display/fonts/libraries survive.
 */
export function sanitizeBrowserEnv(source = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (value === undefined || value === null) continue;
    if (!ALLOW.has(key)) continue;
    if (SECRET.test(key)) continue;
    out[key] = String(value);
  }
  return out;
}

export function findSecretEnvKeys(source = process.env) {
  return Object.keys(source || {}).filter((key) => SECRET.test(key));
}
