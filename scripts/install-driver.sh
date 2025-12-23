#!/bin/bash
#
# install-driver.sh
# Installs the HAL AudioServerPlugIn driver to /Library/Audio/Plug-Ins/HAL/
#
# This script must be run with sudo:
#   sudo ./scripts/install-driver.sh
#

set -e

DRIVER_NAME="GrowhutAudioDriver.driver"
INSTALL_DIR="/Library/Audio/Plug-Ins/HAL"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo "❌ This script must be run as root (use sudo)"
    exit 1
fi

echo "🔧 Installing HAL AudioServerPlugIn driver..."

# Check if driver bundle exists
DRIVER_BUNDLE="$PROJECT_ROOT/build/$DRIVER_NAME"
if [ ! -d "$DRIVER_BUNDLE" ]; then
    echo "❌ Driver bundle not found at: $DRIVER_BUNDLE"
    echo "   Please build the driver first."
    exit 1
fi

# Remove old driver if it exists
if [ -d "$INSTALL_DIR/$DRIVER_NAME" ]; then
    echo "🗑️  Removing existing driver..."
    rm -rf "$INSTALL_DIR/$DRIVER_NAME"
fi

# Install driver
echo "📦 Installing driver to $INSTALL_DIR..."
cp -R "$DRIVER_BUNDLE" "$INSTALL_DIR/"

# Set correct permissions
echo "🔐 Setting permissions..."
chown -R root:wheel "$INSTALL_DIR/$DRIVER_NAME"
chmod -R 755 "$INSTALL_DIR/$DRIVER_NAME"

# Restart CoreAudio daemon to load the driver
echo "🔄 Restarting CoreAudio daemon..."
launchctl kickstart -k system/com.apple.audio.coreaudiod

echo ""
echo "✅ Driver installed successfully!"
echo ""
echo "📋 Next steps:"
echo "   1. macOS will show a 'System software from developer was blocked' dialog"
echo "   2. Open System Settings > Privacy & Security"
echo "   3. Click 'Allow' next to Growhut Audio Driver"
echo "   4. Restart your app"
echo ""
echo "💡 To verify installation:"
echo "   system_profiler SPAudioDataType | grep -A 5 'Growhut'"

