#!/bin/bash
#
# build-driver.sh
# Builds the HAL AudioServerPlugIn driver bundle
#
# Prerequisites:
# - Xcode Command Line Tools
# - macOS 13+ SDK
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DRIVER_SRC="$PROJECT_ROOT/native-audio/src/audio_driver"
BUILD_DIR="$PROJECT_ROOT/build"
DRIVER_NAME="GrowhutAudioDriver.driver"
DRIVER_BUNDLE="$BUILD_DIR/$DRIVER_NAME"

echo "🔨 Building HAL AudioServerPlugIn driver..."

# Create build directory
mkdir -p "$BUILD_DIR"

# Create driver bundle structure
echo "📦 Creating driver bundle structure..."
rm -rf "$DRIVER_BUNDLE"
mkdir -p "$DRIVER_BUNDLE/Contents/MacOS"
mkdir -p "$DRIVER_BUNDLE/Contents/Resources"

# Copy Info.plist
if [ -f "$DRIVER_SRC/Info.plist" ]; then
    cp "$DRIVER_SRC/Info.plist" "$DRIVER_BUNDLE/Contents/"
else
    echo "❌ Info.plist not found at $DRIVER_SRC/Info.plist"
    exit 1
fi

# Compile driver
echo "🔨 Compiling driver..."

DRIVER_SOURCES=(
    "$DRIVER_SRC/audio_driver.c"
    "$DRIVER_SRC/audio_driver_properties.c"
    "$DRIVER_SRC/audio_driver_complete.c"
)

# Check if Xcode is available
if ! command -v clang &> /dev/null; then
    echo "❌ clang not found. Please install Xcode Command Line Tools:"
    echo "   xcode-select --install"
    exit 1
fi

# Compile with CoreAudio frameworks
clang -std=c11 -fPIC -Wall -Wextra -O2 \
    -I"$DRIVER_SRC" \
    -framework CoreAudio \
    -framework CoreFoundation \
    -framework IOKit \
    -dynamiclib \
    -install_name "@rpath/GrowhutAudioDriver" \
    -compatibility_version 1.0.0 \
    -current_version 1.0.0 \
    -mmacosx-version-min=13.0 \
    -o "$DRIVER_BUNDLE/Contents/MacOS/GrowhutAudioDriver" \
    "${DRIVER_SOURCES[@]}"

if [ $? -eq 0 ]; then
    echo "✅ Driver compiled successfully!"
    echo "   Output: $DRIVER_BUNDLE"
    echo ""
    echo "📋 Next steps:"
    echo "   1. Code sign the driver bundle (required for installation)"
    echo "   2. Run: sudo ./scripts/install-driver.sh"
else
    echo "❌ Driver compilation failed"
    exit 1
fi

