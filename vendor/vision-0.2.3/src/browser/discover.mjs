import fs from 'node:fs';

const WINDOWS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

const MACOS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

const LINUX = [
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
];

/**
 * Resolve a Chromium/Edge executable. No ZCode/Electron path is used.
 * A Playwright-installed browser can be selected with
 * VPLAY_BROWSER_EXECUTABLE / PLAYWRIGHT_BROWSERS_PATH + explicit path.
 */
export function findBrowserExecutable({
  env = process.env,
  platform = process.platform,
  exists = (value) => fs.existsSync(value),
} = {}) {
  const explicit = env.VPLAY_BROWSER_EXECUTABLE || env.BROWSER_EXECUTABLE || env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (explicit && exists(explicit)) return explicit;
  const candidates = platform === 'win32' ? WINDOWS : platform === 'darwin' ? MACOS : LINUX;
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return null;
}
