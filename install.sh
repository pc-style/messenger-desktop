#!/bin/bash
set -e

APP_NAME="Messenger Unleashed"
REPO="nicholaspcstyle/messenger-desktop"
INSTALL_DIR="/Applications"

echo "Messenger Unleashed Installer"
echo "=============================="
echo ""

# detect architecture
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
    ASSET_PATTERN="arm64"
else
    ASSET_PATTERN="x64"
fi

# get latest release download url
echo "Fetching latest release..."
DOWNLOAD_URL=$(curl -s "https://api.github.com/repos/$REPO/releases/latest" | \
    grep "browser_download_url.*\.dmg" | \
    grep -i "$ASSET_PATTERN" | \
    head -n 1 | \
    cut -d '"' -f 4)

# fallback if arch-specific not found
if [ -z "$DOWNLOAD_URL" ]; then
    DOWNLOAD_URL=$(curl -s "https://api.github.com/repos/$REPO/releases/latest" | \
        grep "browser_download_url.*\.dmg" | \
        head -n 1 | \
        cut -d '"' -f 4)
fi

if [ -z "$DOWNLOAD_URL" ]; then
    echo "Error: Could not find DMG download URL"
    echo "Please download manually from: https://github.com/$REPO/releases"
    exit 1
fi

# create temp directory
TEMP_DIR=$(mktemp -d)
DMG_PATH="$TEMP_DIR/messenger.dmg"
MOUNT_POINT="$TEMP_DIR/mount"

cleanup() {
    echo "Cleaning up..."
    hdiutil detach "$MOUNT_POINT" 2>/dev/null || true
    rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

# download
echo "Downloading from: $DOWNLOAD_URL"
curl -L -o "$DMG_PATH" "$DOWNLOAD_URL"

# mount dmg
echo "Mounting DMG..."
mkdir -p "$MOUNT_POINT"
hdiutil attach "$DMG_PATH" -mountpoint "$MOUNT_POINT" -nobrowse -quiet

# find the app
APP_PATH=$(find "$MOUNT_POINT" -name "*.app" -maxdepth 1 | head -n 1)
if [ -z "$APP_PATH" ]; then
    echo "Error: Could not find app in DMG"
    exit 1
fi

# remove old version if exists
if [ -d "$INSTALL_DIR/$APP_NAME.app" ]; then
    echo "Removing old version..."
    rm -rf "$INSTALL_DIR/$APP_NAME.app"
fi

# copy to applications
echo "Installing to $INSTALL_DIR..."
cp -R "$APP_PATH" "$INSTALL_DIR/"

# remove quarantine attribute so gatekeeper doesn't block it
echo "Removing quarantine attribute..."
xattr -cr "$INSTALL_DIR/$APP_NAME.app"

echo ""
echo "Installation complete!"
echo "You can now open $APP_NAME from your Applications folder."
