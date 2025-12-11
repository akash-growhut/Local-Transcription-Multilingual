# Surge Audio Capture - Electron App

An Electron application that captures microphone and speaker audio and sends it to Deepgram for real-time speech-to-text transcription.

## Architecture

The app follows a three-layer architecture:

1. **Renderer Process (UI)**: Handles user interface and audio capture using Web Audio API
2. **Main Process (Orchestrator)**: Manages Deepgram connections and IPC communication
3. **Native Layer**: For system audio capture (WASAPI Loopback on Windows, ScreenCaptureKit on macOS)

## Features

- 🎤 **Microphone Capture**: Real-time audio capture from default microphone
- 🔊 **Speaker/System Audio Capture**: Captures system audio output (requires permissions)
- 📝 **Real-time Transcription**: Live transcription using Deepgram's Nova-2 model
- 🎨 **Modern UI**: Beautiful, responsive interface with real-time status updates
- 🔒 **Secure**: Uses context isolation and preload scripts for security

## Prerequisites

- Node.js (v16 or higher)
- npm or yarn
- Deepgram API key ([Get one here](https://console.deepgram.com/))

## Installation

1. Install dependencies:
```bash
npm install
```

## Usage

1. Start the application:
```bash
npm start
```

2. Enter your Deepgram API key in the application
3. Click "Start Capture" for microphone or speaker audio
4. View real-time transcriptions in the transcript boxes

## System Audio Capture Notes

### macOS
- **macOS 13+**: Uses ScreenCaptureKit (requires screen recording permission)
- **macOS <13**: Requires BlackHole virtual audio device as fallback
- The current implementation uses `getDisplayMedia` which requires user interaction

### Windows
- Uses WASAPI Loopback (requires native module for full implementation)
- Current implementation uses `getDisplayMedia` as a fallback

## Project Structure

```
stt-electron/
├── src/
│   ├── main.js              # Main Electron process
│   ├── preload.js           # Preload script for secure IPC
│   └── renderer/
│       ├── index.html       # UI markup
│       ├── styles.css       # Styling
│       ├── audioCapture.js  # Audio capture logic
│       └── renderer.js      # Renderer process logic
├── package.json
└── README.md
```

## Native Module Integration

For production use, you'll want to integrate a native module for system audio capture:

- **Windows**: WASAPI Loopback via native addon
- **macOS**: ScreenCaptureKit (macOS 13+) or BlackHole integration

The current implementation provides a foundation that can be extended with native modules.

## Development

Run in development mode with DevTools:
```bash
npm run dev
```

## Building

Build the application:
```bash
npm run build
```

## License

ISC

