# Messenger Desktop

Electron wrapper for messenger.com with full video/audio call support.

## Features

- Native macOS app
- WebRTC support for video/audio calls
- Camera, microphone, and notification permissions
- Chrome user agent for full compatibility

## Install

### From Releases

Download the latest `.dmg` from [Releases](../../releases) and drag to Applications.

### Build from source

Requires [Bun](https://bun.sh):

```bash
# install bun if needed
curl -fsSL https://bun.sh/install | bash

# clone and build
git clone https://github.com/YOUR_USERNAME/messenger-desktop.git
cd messenger-desktop
./install.sh
```

## Development

```bash
bun install
bun run dev
```

## Build

```bash
bun run build
```

Output: `dist/Messenger.dmg`

## License

MIT
