#!/bin/bash
# Build script to compile Swift files for the native module

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$SCRIPT_DIR/src"
BUILD_DIR="$SCRIPT_DIR/build"
SWIFT_FILE="$SRC_DIR/ScreenCaptureKitBridge.swift"
BRIDGING_HEADER="$SRC_DIR/AudioCapture-Bridging-Header.h"

# Get macOS SDK path
SDK_PATH=$(xcrun --show-sdk-path --sdk macosx)

# Create build directory if it doesn't exist
mkdir -p "$BUILD_DIR/Release"

echo "Compiling Swift file: $SWIFT_FILE"

# Compile Swift file (Swift will import frameworks directly)
swiftc \
  -c "$SWIFT_FILE" \
  -emit-module \
  -emit-module-path "$BUILD_DIR/Release/ScreenCaptureKitBridge.swiftmodule" \
  -emit-objc-header \
  -emit-objc-header-path "$BUILD_DIR/Release/AudioCapture-Swift.h" \
  -o "$BUILD_DIR/Release/ScreenCaptureKitBridge.o" \
  -sdk "$SDK_PATH" \
  -target arm64-apple-macosx13.0 \
  -framework Foundation \
  -framework ScreenCaptureKit \
  -framework AVFoundation \
  -framework CoreMedia \
  -module-name AudioCapture \
  -Xfrontend -enable-objc-interop

echo "✅ Swift compilation complete"
echo "Generated header: $BUILD_DIR/Release/AudioCapture-Swift.h"

