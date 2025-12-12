#!/bin/bash
# Build script for Surge Audio Driver

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
SRC_DIR="$SCRIPT_DIR/src"
BUILD_DIR="$SCRIPT_DIR/build"
DRIVER_NAME="SurgeAudioDriver"
BUNDLE_NAME="$DRIVER_NAME.driver"

echo "🔨 Building Surge Audio Driver..."

# Create build directory
mkdir -p "$BUILD_DIR/$BUNDLE_NAME/Contents/MacOS"

# Copy Info.plist
cp "$SCRIPT_DIR/Info.plist" "$BUILD_DIR/$BUNDLE_NAME/Contents/"

# Compile the driver
echo "📦 Compiling driver..."
clang -c \
    -arch x86_64 \
    -arch arm64 \
    -mmacosx-version-min=12.0 \
    -fPIC \
    -O2 \
    -I/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk/System/Library/Frameworks/CoreAudio.framework/Headers \
    -o "$BUILD_DIR/SurgeAudioDriver.o" \
    "$SRC_DIR/SurgeAudioDriver.c"

# Link as bundle
echo "🔗 Linking bundle..."
clang \
    -arch x86_64 \
    -arch arm64 \
    -mmacosx-version-min=12.0 \
    -bundle \
    -framework CoreFoundation \
    -framework CoreAudio \
    -o "$BUILD_DIR/$BUNDLE_NAME/Contents/MacOS/$DRIVER_NAME" \
    "$BUILD_DIR/SurgeAudioDriver.o"

# Create PkgInfo
echo "BNDL????" > "$BUILD_DIR/$BUNDLE_NAME/Contents/PkgInfo"

echo "✅ Build complete: $BUILD_DIR/$BUNDLE_NAME"
echo ""
echo "📍 To install (requires admin):"
echo "   sudo cp -R \"$BUILD_DIR/$BUNDLE_NAME\" /Library/Audio/Plug-Ins/HAL/"
echo "   sudo launchctl kickstart -kp system/com.apple.audio.coreaudiod"
echo ""
echo "📍 To uninstall:"
echo "   sudo rm -rf /Library/Audio/Plug-Ins/HAL/$BUNDLE_NAME"
echo "   sudo launchctl kickstart -kp system/com.apple.audio.coreaudiod"
