# Messenger Unleashed

Messenger desktop app with extra features.

## Features

- **Always on Top** - Keep window floating above others (`Cmd+Shift+T`)
- **OLED Dark Theme** - True black background for OLED displays
- **Compact Mode** - Reduced spacing for more content
- **Picture in Picture** - Floating mini window (`Cmd+Shift+P`)
- **Do Not Disturb** - Suppress notifications (`Cmd+Shift+D`)
- **Quiet Hours** - Auto-enable Do Not Disturb on a schedule
- **Quick Replies** - Send saved replies with `Cmd+Shift+[key]`
- **Privacy Tools** - Block read receipts, typing indicator, active status
- **Keyword Alerts** - Notifications when matching words appear
- **Clipboard Sanitizer** - Strip tracking params from pasted URLs
- Full WebRTC support for video/audio calls
- Settings persist between sessions

## Install

### From Releases

Download from [Releases](../../releases):

- **macOS**: `.dmg`
- **Windows**: `.exe`

### Build from source

```bash
curl -fsSL https://bun.sh/install | bash
git clone https://github.com/YOUR_USERNAME/messenger-desktop.git
cd messenger-desktop
git checkout dev/unleashed
bun install && bun run build
```

## Usage

All features accessible via **Unleashed** menu or keyboard shortcuts:

| Feature            | Shortcut      |
| ------------------ | ------------- |
| Always on Top      | `Cmd+Shift+T` |
| Do Not Disturb     | `Cmd+Shift+D` |
| Picture in Picture | `Cmd+Shift+P` |
| Focus Mode         | `Cmd+Shift+F` |
| Quick Reply        | `Cmd+Shift+[key]` |

Themes: **Unleashed → Theme** menu
Settings: **Unleashed → Open Settings...** (`CmdOrCtrl+,`)
Quiet Hours: **Unleashed → Power Tools → Quiet Hours**

## Development

```bash
bun install
bun run dev
```

## License

MIT
