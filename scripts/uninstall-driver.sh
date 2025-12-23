#!/bin/bash
#
# uninstall-driver.sh
# Removes the HAL AudioServerPlugIn driver
#
# This script must be run with sudo:
#   sudo ./scripts/uninstall-driver.sh
#

set -e

DRIVER_NAME="GrowhutAudioDriver.driver"
INSTALL_DIR="/Library/Audio/Plug-Ins/HAL"

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo "❌ This script must be run as root (use sudo)"
    exit 1
fi

echo "🗑️  Uninstalling HAL AudioServerPlugIn driver..."

# Remove driver
if [ -d "$INSTALL_DIR/$DRIVER_NAME" ]; then
    echo "📦 Removing driver from $INSTALL_DIR..."
    rm -rf "$INSTALL_DIR/$DRIVER_NAME"
    
    # Restart CoreAudio daemon
    echo "🔄 Restarting CoreAudio daemon..."
    launchctl kickstart -k system/com.apple.audio.coreaudiod
    
    echo "✅ Driver uninstalled successfully!"
else
    echo "ℹ️  Driver not found at $INSTALL_DIR/$DRIVER_NAME"
    echo "   Nothing to uninstall."
fi

