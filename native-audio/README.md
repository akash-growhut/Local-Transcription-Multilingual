# Native Audio Capture Module

Cross-platform native audio capture for macOS and Windows with silent system audio capture.

## Platform Support

### macOS

- **Implementation**: Pure Objective-C++ using ScreenCaptureKit
- **Requirements**: macOS 13.0+, Screen Recording permission
- **File**: `src/speaker_audio_capture.mm`

### Windows

- **Implementation**: C++ using WASAPI (Windows Audio Session API)
- **Requirements**: Windows 7+, COM initialization
- **File**: `src/speaker_audio_capture_win.cpp`
- **Features**: Loopback recording to capture system audio

The correct implementation is automatically selected at build time based on your platform.

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

## Build Requirements

### macOS

- macOS 13.0+ (for ScreenCaptureKit)
- Xcode Command Line Tools
- Screen Recording permission (granted once, then works automatically)

### Windows

- Windows 7 or later
- Visual Studio Build Tools or Visual Studio 2017+
- Windows SDK

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

### macOS Implementation

- **ScreenCaptureKit** for system audio capture
- **Objective-C runtime** (`NSInvocation`) to call ScreenCaptureKit APIs
- Pure Objective-C++ implementation (no Swift dependencies)

### Windows Implementation

- **WASAPI** (Windows Audio Session API) for loopback recording
- **COM** (Component Object Model) for audio device enumeration
- **IAudioClient** and **IAudioCaptureClient** for capturing system audio
- Multi-threaded capture with automatic format conversion

### Common Features

- **Node-API (N-API)** for Node.js integration
- Thread-safe callbacks to JavaScript
- Automatic audio format conversion to Float32
- Unified API across both platforms
