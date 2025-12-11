# Native Audio Capture Module

Native macOS audio capture using ScreenCaptureKit for silent system audio capture.

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

This will create `build/Release/audio_capture.node`

## Requirements

- macOS 13.0+ (for ScreenCaptureKit)
- Xcode Command Line Tools
- Screen Recording permission (granted once, then works automatically)

## Usage

```javascript
const AudioCapture = require('./native-audio');
const capture = new AudioCapture();

if (capture.isAvailable()) {
  capture.start((audioData) => {
    // Process audio data
  });
}
```

