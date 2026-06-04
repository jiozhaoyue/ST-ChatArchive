export const THEME_MODES = ['system', 'light', 'dark'];

export function normalizeThemeMode(value) {
  return THEME_MODES.includes(value) ? value : 'system';
}

export function applyThemePreference(value, root = globalThis.document?.documentElement) {
  const mode = normalizeThemeMode(value);
  if (root?.dataset) {
    root.dataset.chatArchivePackTheme = mode;
  }
  return mode;
}
