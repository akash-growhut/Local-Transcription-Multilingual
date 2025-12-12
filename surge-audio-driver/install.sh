#!/bin/bash
# Installer script for Surge Audio Driver

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
BUILD_DIR="$SCRIPT_DIR/build"
DRIVER_NAME="SurgeAudioDriver.driver"
INSTALL_DIR="/Library/Audio/Plug-Ins/HAL"

echo "🎵 Surge Audio Driver Installer"
echo "================================"
echo ""

# Check if driver is built
if [ ! -d "$BUILD_DIR/$DRIVER_NAME" ]; then
    echo "⚠️  Driver not built yet. Building now..."
    "$SCRIPT_DIR/build.sh"
fi

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "🔐 This installer requires administrator privileges."
    echo "   Please enter your password when prompted."
    echo ""
    exec sudo "$0" "$@"
fi

# Check if already installed
if [ -d "$INSTALL_DIR/$DRIVER_NAME" ]; then
    echo "📦 Existing installation found. Removing..."
    rm -rf "$INSTALL_DIR/$DRIVER_NAME"
fi

# Create HAL directory if it doesn't exist
mkdir -p "$INSTALL_DIR"

# Copy driver
echo "📥 Installing driver..."
cp -R "$BUILD_DIR/$DRIVER_NAME" "$INSTALL_DIR/"

# Set permissions
echo "🔒 Setting permissions..."
chmod -R 755 "$INSTALL_DIR/$DRIVER_NAME"
chown -R root:wheel "$INSTALL_DIR/$DRIVER_NAME"

# Restart Core Audio - try multiple methods
echo "🔄 Restarting Core Audio daemon..."

# Method 1: Try launchctl kickstart (may fail on newer macOS with SIP)
if launchctl kickstart -kp system/com.apple.audio.coreaudiod 2>/dev/null; then
    echo "   ✓ Core Audio restarted via launchctl"
else
    # Method 2: Kill coreaudiod (it will auto-restart)
    echo "   → launchctl method blocked by SIP, using killall..."
    if sudo killall coreaudiod 2>/dev/null; then
        echo "   ✓ Core Audio daemon killed (will auto-restart)"
        sleep 2
    else
        # Method 3: If all else fails, just notify the user
        echo "   ⚠️  Could not restart Core Audio automatically."
        echo ""
        echo "   Please do ONE of the following to activate the driver:"
        echo "   1. Log out and log back in"
        echo "   2. Restart your Mac"
        echo "   3. Run: sudo killall coreaudiod"
        echo ""
    fi
fi

echo ""
echo "✅ Installation complete!"
echo ""

# Verify installation
if [ -d "$INSTALL_DIR/$DRIVER_NAME" ]; then
    echo "📍 Driver installed at: $INSTALL_DIR/$DRIVER_NAME"
else
    echo "❌ Warning: Driver file not found after installation"
fi

echo ""
echo "📝 The 'Surge Audio' device should now appear in:"
echo "   - System Settings > Sound (or System Preferences > Sound)"
echo "   - Audio MIDI Setup app (/Applications/Utilities/)"
echo ""
echo "🎤 To capture system audio:"
echo "   1. Set 'Surge Audio' as your system output device"
echo "   2. Your app can now record from 'Surge Audio' input"
echo ""
echo "💡 If the device doesn't appear, try:"
echo "   - Opening Audio MIDI Setup and refreshing"
echo "   - Logging out and back in"
echo "   - Restarting your Mac"
