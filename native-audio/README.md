# Native Audio Capture Module

Native macOS audio capture using ScreenCaptureKit for silent system audio capture.

## Implementation

This module is implemented in **pure Objective-C++** and uses macOS ScreenCaptureKit APIs directly through the Objective-C runtime. No Swift code is required.

## Building

1. Install dependencies:

```bash
cd native-audio
npm install
```

2. Build the native module:

```bash
npm run rebuild
```

This will create `build/Release/speaker_audio_capture.node`

## Requirements

- macOS 13.0+ (for ScreenCaptureKit)
- Xcode Command Line Tools
- Screen Recording permission (granted once, then works automatically)

## Usage

```javascript
const AudioCapture = require("./native-audio");
const capture = new AudioCapture();

if (capture.isAvailable()) {
  capture.start((audioData) => {
    // Process audio data
  });
}
```

## Technical Details

The module uses:

- **ScreenCaptureKit** for system audio capture
- **Objective-C runtime** (`NSInvocation`) to call ScreenCaptureKit APIs
- **Node-API (N-API)** for Node.js integration
- Pure Objective-C++ implementation (no Swift dependencies)
