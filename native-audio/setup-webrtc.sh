#!/bin/bash
# Setup script for WebRTC AudioProcessing library
# This script downloads and builds WebRTC AudioProcessing for AEC3

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEBRTC_DIR="$SCRIPT_DIR/webrtc-audio"
BUILD_DIR="$WEBRTC_DIR/build"
INSTALL_DIR="$SCRIPT_DIR/webrtc-install"
DEPOT_TOOLS_DIR="$SCRIPT_DIR/depot_tools"

echo "🔧 Setting up WebRTC AudioProcessing for AEC3..."
echo ""
echo "⚠️  This process requires:"
echo "   - Git"
echo "   - CMake"
echo "   - Python 3"
echo "   - Xcode Command Line Tools (macOS)"
echo "   - ~5GB disk space"
echo "   - 15-30 minutes (depending on internet speed)"
echo ""

# Check if webrtc-audio already exists
if [ -d "$WEBRTC_DIR" ]; then
    echo "⚠️  WebRTC directory already exists. Remove it to rebuild."
    read -p "Remove and rebuild? (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        rm -rf "$WEBRTC_DIR"
    else
        echo "Using existing WebRTC build."
        exit 0
    fi
fi

# Check for depot_tools
if [ ! -d "$DEPOT_TOOLS_DIR" ]; then
    echo "📥 Installing depot_tools (required for WebRTC)..."
    git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git "$DEPOT_TOOLS_DIR" || {
        echo "❌ Failed to clone depot_tools. Check internet connection."
        exit 1
    }
    export PATH="$DEPOT_TOOLS_DIR:$PATH"
else
    echo "✅ depot_tools found"
    export PATH="$DEPOT_TOOLS_DIR:$PATH"
fi

# Clone webrtc-audioprocessing repository
echo "📥 Cloning webrtc-audioprocessing repository..."
git clone https://github.com/get-wrecked/webrtc-audioprocessing.git "$WEBRTC_DIR" || {
    echo "❌ Failed to clone repository. Make sure git is installed."
    exit 1
}

cd "$WEBRTC_DIR"

# Fetch WebRTC source code
echo "📥 Fetching WebRTC source code..."
echo "   ⏱️  This may take 15-30 minutes depending on your internet speed"
echo "   📦 This downloads ~2-3GB of source code"
echo "   ☕ You can grab a coffee while this runs..."
echo ""
fetch --nohooks webrtc || {
    echo ""
    echo "❌ Failed to fetch WebRTC source."
    echo "   Common issues:"
    echo "   - Slow or unstable internet connection"
    echo "   - Firewall blocking git/chromium servers"
    echo "   - Insufficient disk space (need ~5GB free)"
    echo ""
    echo "   You can retry by running: npm run setup-webrtc"
    exit 1
}

# Sync dependencies
echo "🔄 Syncing WebRTC dependencies..."
cd src
gclient sync || {
    echo "❌ Failed to sync dependencies."
    exit 1
}

# Checkout a stable branch (M124 - recent stable release)
echo "📌 Checking out WebRTC M124 (stable release)..."
git checkout branch-heads/6367 || {
    echo "⚠️  Failed to checkout specific branch, using default..."
}

# Generate build files (needed for protobuf generation)
echo "⚙️  Generating WebRTC build files (for protobuf generation)..."
gn gen out/Default || {
    echo "❌ Failed to generate build files."
    exit 1
}

cd ..

# Create build directory
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

# Configure with CMake
echo "⚙️  Configuring CMake..."
cmake .. \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$INSTALL_DIR" \
    -DCMAKE_CXX_STANDARD=17 \
    || {
    echo "❌ CMake configuration failed. Make sure CMake is installed."
    exit 1
}

# Build
echo "🔨 Building WebRTC AudioProcessing..."
echo "   ⏱️  This may take 5-15 minutes depending on your CPU..."
CPU_COUNT=$(sysctl -n hw.ncpu 2>/dev/null || echo 4)
echo "   Using $CPU_COUNT parallel jobs"
cmake --build . --config Release -j$CPU_COUNT || {
    echo ""
    echo "❌ Build failed."
    echo "   Common issues:"
    echo "   - Missing dependencies (check CMake output above)"
    echo "   - Insufficient memory"
    echo "   - Xcode Command Line Tools not installed"
    echo ""
    echo "   Try: xcode-select --install (macOS)"
    exit 1
}

# Install
echo "📦 Installing WebRTC AudioProcessing..."
cmake --install . --config Release || {
    echo "❌ Installation failed."
    exit 1
}

echo ""
echo "✅ WebRTC AudioProcessing built successfully!"
echo "📁 Installation directory: $INSTALL_DIR"
echo ""
echo "Next steps:"
echo "1. Rebuild the native module: npm run rebuild"
echo "2. Verify WebRTC is detected: npm run check-webrtc"
echo ""
echo "Note: The build system will automatically detect and use WebRTC."
echo ""
