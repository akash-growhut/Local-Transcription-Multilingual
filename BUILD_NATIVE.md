# Building the Native Audio Capture Module

## Implementation

This native module is implemented in **pure Objective-C++** and does not require Swift or full Xcode. It uses the Objective-C runtime to interface with ScreenCaptureKit APIs.

## Prerequisites

- macOS 13.0+ (for ScreenCaptureKit)
- Xcode Command Line Tools installed (no full Xcode needed!)
- Node.js and npm

## Build Steps

1. **Install dependencies in the native-audio folder:**

```bash
cd native-audio
npm install
```

2. **Build the native module:**

```bash
npm run rebuild
```

This will compile the Objective-C++ code and create `build/Release/audio_capture.node`

## First-Time Setup

1. **Grant Screen Recording Permission:**

   - When you first run the app, macOS will prompt: "App wants to capture screen contents."
   - Click "Open System Preferences" or go to:
     - System Preferences → Security & Privacy → Privacy → Screen Recording
   - Check the box next to your Electron app
   - Restart the app

2. **After permission is granted:**
   - The native module will automatically capture system audio
   - No dialog popups needed
   - Works silently in the background

## Troubleshooting

### Build Errors

If you get build errors:

1. **Check Xcode Command Line Tools:**

```bash
xcode-select --install
```

2. **Check Node.js version:**

   - Requires Node.js 16+ for node-addon-api

3. **Clean and rebuild:**

```bash
cd native-audio
rm -rf build node_modules
npm install
npm run rebuild
```

### Runtime Errors

- **"Native module not available"**: The module wasn't built. Run `npm run rebuild` in the `native-audio` folder.
- **Permission denied**: Grant Screen Recording permission in System Preferences.
- **Module load error**: Make sure you're running on macOS 13.0+.

## How It Works

1. The native module uses ScreenCaptureKit to capture system audio
2. Objective-C runtime (`NSInvocation`) is used to call ScreenCaptureKit's Objective-C APIs
3. Audio is streamed directly to the Electron main process via N-API callbacks
4. The main process sends audio to Deepgram for transcription
5. No user interaction needed after initial permission grant

## Fallback

If the native module isn't available or fails to load, the app automatically falls back to the web API method (`getDisplayMedia`), which requires user interaction each time.

## Why No Swift?

Earlier versions planned to use Swift for ScreenCaptureKit's async/await APIs. However, the current implementation cleverly uses Objective-C compatible methods (`getShareableContentWithCompletionHandler:`) accessed via the Objective-C runtime, eliminating the need for Swift entirely. This simplifies the build process significantly.
