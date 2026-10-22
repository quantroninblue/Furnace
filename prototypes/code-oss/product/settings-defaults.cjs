'use strict';
// Application-scoped product defaults. Extensions cannot default these, so they are written
// into the user's settings: by scripts/launch.mjs in development (missing keys only) and by
// the packaged app's entry (release/furnace-main.mjs) on first launch.
function settingsDefaults(platform = process.platform) {
    return {
        'workbench.colorTheme': 'Furnace Charcoal',
        'chat.disableAIFeatures': true,
        'workbench.startupEditor': 'none',
        'workbench.secondarySideBar.defaultVisibility': 'visible',
        'telemetry.telemetryLevel': 'off',
        'extensions.autoUpdate': false,
        'extensions.autoCheckUpdates': false,
        'window.commandCenter': false,
        // 120%: readable on dense laptop screens; users change it with Text size or Ctrl+=/-.
        'window.zoomLevel': 1,
        // Themed dialogs match the charcoal panels.
        'window.dialogStyle': 'custom',
        // Linux: menus stay native. The drawn (custom) menu bar dropdowns opened behind the
        // workspace panels on a real Linux desktop, and Linux only uses native menus with the
        // native title bar. macOS menus are always native, so it keeps the default title bar.
        ...(platform === 'linux' ? { 'window.titleBarStyle': 'native', 'window.menuStyle': 'native' } : {}),
    };
}

module.exports = { settingsDefaults };
