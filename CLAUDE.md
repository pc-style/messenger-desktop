# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Messenger Unleashed** is an Electron-based desktop wrapper for Facebook Messenger (messenger.com) with enhanced features not available in the standard web or official desktop app. The app loads messenger.com in a BrowserWindow and adds native desktop features via CSS injection, JavaScript execution, and Electron APIs.

## Build & Development Commands

```bash
# Install dependencies (use bun, not npm/yarn)
bun install

# Run in development mode
bun run dev

# Build for current platform
bun run build

# Build for specific platforms
bun run build:mac
bun run build:win
```

## Architecture

### Core Files (3 files total)

- **main.js** (650+ lines) - Main Electron process, all app logic
- **preload.js** - Security bridge for notifications
- **themes.css** - CSS definitions for OLED and Compact themes

### Main Process Architecture (main.js)

The entire application is structured as a single main process file with:

1. **Store-based persistence** using `electron-store`
   - All settings saved in defaults object (lines 6-23)
   - Settings include: window bounds, theme, feature toggles, quick replies

2. **Feature toggle functions** pattern
   - Each feature has a `toggle[FeatureName]()` function
   - Functions update store, apply changes, and call `updateMenu()`
   - Example: `toggleFocusMode()`, `toggleLaunchAtLogin()`

3. **CSS injection for UI modifications**
   - Themes: via `applyTheme()` reading from themes.css
   - Focus Mode: inline CSS injection to hide sidebar
   - Applied on page load via `did-finish-load` event

4. **JavaScript injection for behavior changes**
   - Quick Replies: DOM manipulation to insert text and simulate Enter
   - Block Read Receipts: Override `document.hidden` and `visibilityState`
   - PIP close button: Inject floating × button element

5. **Menu system**
   - Single `updateMenu()` function rebuilds entire menu
   - Reads all current settings from store
   - Menu structure defined in template array

### Notification System

Uses a two-step bridge for native notifications:
1. **preload.js** exposes `window.electronNotify` to renderer
2. Overrides `window.Notification` constructor to intercept Messenger notifications
3. **main.js** handles IPC `show-notification` events
4. Respects Do Not Disturb setting

### Theme System

- **themes.css** contains two theme blocks marked with comments: `/* oled */` and `/* compact */`
- `getThemeCSS()` extracts relevant section via regex
- `applyTheme()` uses `insertCSS()` with `cssKey: 'theme'` for hot-swapping
- Default theme = no CSS injection

### WebRTC Support

- Custom USER_AGENT set to Chrome for compatibility
- Permission handlers allow: media, mediaKeySystem, geolocation, notifications, fullscreen, pointerLock

### Picture-in-Picture Implementation

- Frameless BrowserWindow (no native close button)
- Close methods: Escape key handler + injected × button overlay
- Loads same messenger.com URL in smaller window

## Key Patterns

### Adding New Features

1. Add setting to store defaults (main.js:6-23)
2. Create `toggle[FeatureName]()` function
3. Add to `updateMenu()` - read setting and create menu item
4. If persistent, apply in `did-finish-load` event handler
5. Register global shortcut in `app.on('ready')` if needed

### CSS-based Features

Use `mainWindow.webContents.insertCSS(css, { cssKey: 'unique-key' })` for toggleable CSS.
Remove with `removeInsertedCSS('unique-key')`.

### JavaScript-based Features

Use `mainWindow.webContents.executeJavaScript()` for DOM manipulation.
Wrap in IIFE for safety. Use after `did-finish-load`.

## Technical Constraints

- **Selector brittleness**: Messenger's DOM uses aria-labels and dynamic class names that may break
- **Read receipts**: Visibility API override may not catch all receipt mechanisms
- **Quick replies**: Relies on `document.execCommand` (deprecated but still works)
- **Tray icon**: On macOS, requires .icns file; template icon recommended

## Settings Persistence

All settings stored via `electron-store` in:
- macOS: `~/Library/Application Support/messenger-unleashed/config.json`
- Windows: `%APPDATA%/messenger-unleashed/config.json`

Settings survive app restarts but not uninstall.
