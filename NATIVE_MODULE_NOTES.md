# Native Module Integration Notes

## Current Implementation

The current implementation uses Web APIs (`getUserMedia` for microphone and `getDisplayMedia` for system audio) which work but have limitations:

- **Microphone**: Works well with `getUserMedia`
- **System Audio**: Uses `getDisplayMedia` which requires user interaction and screen sharing permissions

## Production Native Module Integration

For production use, you'll want to integrate native modules for true system audio capture:

### macOS (macOS 13+)
- Use **ScreenCaptureKit** framework for silent system audio capture
- Requires one-time screen recording permission
- No user interaction needed after permission is granted

### macOS (macOS < 13)
- Use **BlackHole** virtual audio device as fallback
- Requires BlackHole installation and configuration
- User needs to route audio through BlackHole

### Windows
- Use **WASAPI Loopback** for system audio capture
- Zero setup required
- Silent capture of all system audio

## Implementation Approach

1. Create a native Node.js addon using:
   - **node-addon-api** (N-API)
   - Platform-specific code:
     - macOS: Objective-C++ with ScreenCaptureKit
     - Windows: C++ with WASAPI

2. Expose the native module to Electron's main process

3. Stream audio data from native module to Deepgram

## Example Native Module Structure

```
native-audio-capture/
├── binding.gyp
├── src/
│   ├── audio_capture.cc
│   ├── mac/
│   │   └── screen_capture_kit.mm
│   └── win/
│       └── wasapi_loopback.cc
└── index.js
```

## Alternative: Use Existing Libraries

Consider using or adapting:
- `@surge/audio-capture` (if available)
- `node-record-lpcm16` (for microphone only)
- Custom native module based on platform-specific APIs

## Current Workaround

The current implementation uses `getDisplayMedia` which:
- ✅ Works across platforms
- ✅ No native compilation needed
- ❌ Requires user interaction
- ❌ Requires screen sharing permission
- ❌ May capture video if user selects wrong option

For a production app, native modules are recommended for the best user experience.

