# Repository Guidelines

## Project Structure & Module Organization
- `main.js`: Electron main process; handles windows, tray, menu, shortcuts, quick replies, and settings persistence via `electron-store`.
- `preload.js`: Preload bridge for renderer tweaks; loaded by the single `BrowserWindow`.
- `themes.css`: Theme slices (`/* oled */`, `/* compact */`, etc.) injected at runtime; keep new themes in this file.
- `dist/`: Generated binaries/installers (git-ignored when rebuilding locally).
- `icon.icns`, `icon.ico`: Platform icons referenced by electron-builder.
- `messenger-session.json`: Local session cache; do not commit changes.

## Build, Test, and Development Commands
- `bun install` — install dependencies (Bun preferred; `bun.lock` is authoritative).
- `bun run dev` — start the app in development (`electron .`).
- `bun run build` — cross-platform package via `electron-builder` using config in `package.json`.
- `bun run build:mac` / `bun run build:win` — platform-specific artifacts (run on matching OS hosts for code signing).

## Coding Style & Naming Conventions
- Language: Node/Electron (CommonJS). Follow existing style: 2-space indent, camelCase identifiers, no trailing semicolons.
- Keep side-effectful helpers near their use; prefer small, named functions (see `toggle*`, `applyTheme` patterns).
- CSS themes: wrap variants with `/* theme-name */` markers so `getThemeCSS` can extract them cleanly.
- Avoid adding framework dependencies; keep the renderer as vanilla Messenger web with minimal injected CSS/JS.

## Testing Guidelines
- No automated test suite yet. Run a quick manual pass before PRs:
  - Launch app, log in, and verify chat load.
  - Toggle Always on Top, Do Not Disturb, Focus Mode, PiP, and Quick Replies.
  - Switch themes (default/oled/compact) and restart to confirm persistence.
  - Check launch-at-login and menu-bar mode on macOS; tray toggle on Windows.

## Commit & Pull Request Guidelines
- Use Conventional Commits (`feat: ...`, `fix: ...`, `chore: ...`, `build: ...`). Recent history follows this pattern.
- PRs should include: one-paragraph summary, linked issue (if any), OS tested, and before/after screenshots when UI is affected.
- Keep PRs small and focused; mention any manual testing steps performed and any follow-up TODOs.

## Security & Configuration Tips
- Do not log or commit auth/session data; keep `messenger-session.json` local.
- When adding new permissions or preload bridges, keep them minimal and documented to avoid widening the attack surface.
- Electron store defaults live in `main.js`; update defaults and migration logic together when introducing new settings.
