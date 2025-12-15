#!/bin/bash
set -e

# check for bun
if ! command -v bun &> /dev/null; then
    echo "Installing bun..."
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
fi

echo "Installing dependencies..."
bun install

echo "Building app..."
bun run build

echo ""
echo "Build complete!"
echo "Install: open dist/Messenger-*.dmg"
echo "Or copy directly: cp -r 'dist/mac-arm64/Messenger.app' /Applications/"
