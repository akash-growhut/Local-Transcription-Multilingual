#!/bin/bash
# Build Swift code using xcodebuild

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build/Release"

mkdir -p "$BUILD_DIR"

# Create a temporary Xcode project to compile Swift
# Actually, let's use swiftc with proper module setup
SDK_PATH=$(xcrun --show-sdk-path --sdk macosx)

echo "Building Swift module..."

# Compile as a library
swiftc \
  "$SCRIPT_DIR/src/ScreenCaptureKitBridge.swift" \
  -emit-library \
  -o "$BUILD_DIR/libScreenCaptureKitBridge.dylib" \
  -emit-module \
  -emit-module-path "$BUILD_DIR/ScreenCaptureKitBridge.swiftmodule" \
  -emit-objc-header \
  -emit-objc-header-path "$BUILD_DIR/AudioCapture-Swift.h" \
  -sdk "$SDK_PATH" \
  -target arm64-apple-macosx13.0 \
  -framework Foundation \
  -framework ScreenCaptureKit \
  -framework AVFoundation \
  -framework CoreMedia \
  -module-name AudioCapture

echo "✅ Swift library built: $BUILD_DIR/libScreenCaptureKitBridge.dylib"
echo "✅ Swift header generated: $BUILD_DIR/AudioCapture-Swift.h"

