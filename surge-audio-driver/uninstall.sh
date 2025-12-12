#!/bin/bash
# Uninstaller script for Surge Audio Driver

set -e

DRIVER_NAME="SurgeAudioDriver.driver"
INSTALL_DIR="/Library/Audio/Plug-Ins/HAL"

echo "🎵 Surge Audio Driver Uninstaller"
echo "=================================="
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "🔐 This uninstaller requires administrator privileges."
    echo "   Please enter your password when prompted."
    echo ""
    exec sudo "$0" "$@"
fi

# Check if installed
if [ ! -d "$INSTALL_DIR/$DRIVER_NAME" ]; then
    echo "❌ Driver not found at $INSTALL_DIR/$DRIVER_NAME"
    echo "   Nothing to uninstall."
    exit 0
fi

# Remove driver
echo "🗑️  Removing driver..."
rm -rf "$INSTALL_DIR/$DRIVER_NAME"

# Restart Core Audio - try multiple methods
echo "🔄 Restarting Core Audio daemon..."

if launchctl kickstart -kp system/com.apple.audio.coreaudiod 2>/dev/null; then
    echo "   ✓ Core Audio restarted"
elif sudo killall coreaudiod 2>/dev/null; then
    echo "   ✓ Core Audio daemon restarted"
    sleep 2
else
    echo "   ⚠️  Could not restart Core Audio automatically."
    echo "   Please log out and back in, or restart your Mac."
fi

echo ""
echo "✅ Uninstallation complete!"
echo "   The 'Surge Audio' device has been removed."
