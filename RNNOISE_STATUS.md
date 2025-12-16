# RNNoise Implementation Status

## Current Status: ⚠️ Module Built, Not Active in Audio Pipeline

### What Works ✅

1. **Native Module Compilation**

   - RNNoise C++ module compiles successfully on macOS
   - No build errors
   - Module loads without issues: `✅ RNNoise module loaded successfully`

2. **Module Infrastructure**

   - C++ implementation: `native-audio/src/microphone_rnnoise.cpp`
   - JavaScript wrapper: `native-audio/rnnoise-wrapper.js`
   - IPC handlers in `main.js` and `preload.js`
   - Integration points in `audioCapture.js`

3. **App Stability**
   - App runs without crashes
   - Microphone recording works perfectly
   - Transcription works correctly

### Current Noise Cancellation: Browser Built-in

**The app is currently using the browser's built-in noise suppression**, NOT RNNoise.

```javascript
// In audioCapture.js
audio: {
  noiseSuppression: true,  // ← Browser's noise cancellation (ACTIVE)
  echoCancellation: true,
  autoGainControl: true,
}
```

### Why RNNoise Is Not Active

**Technical Issue**: Cannot use async IPC calls in real-time audio callback

```javascript
// This causes crashes due to async IPC in audio callback:
this.microphoneProcessor.onaudioprocess = async (e) => {
  const processed = await window.electronAPI.processAudioWithRNNoise(...);
  // ❌ Async IPC in real-time callback = CRASH
}
```

The `onaudioprocess` callback runs ~23 times per second (every 85ms at 48kHz with 4096 sample buffer). Making async IPC calls in this high-frequency callback causes:

- Bus errors (SIGBUS)
- Memory access violations
- App crashes

### What Was Built But Not Used

1. **SpectralNoiseReduction** class in C++

   - Advanced spectral subtraction algorithm
   - Noise profile learning
   - Frame-based processing

2. **NoiseGate** class in C++

   - Attack/release/hold envelope follower
   - Threshold-based gating
   - Smooth gain transitions

3. **IPC Communication**
   - `check-rnnoise` handler
   - `initialize-rnnoise` handler
   - `process-audio-rnnoise` handler (works, but can't be called from audio callback)
   - `set-rnnoise-enabled` handler
   - `destroy-rnnoise` handler

## Browser Noise Suppression Performance

The browser's built-in noise suppression is actually quite good:

### Pros ✅

- **Works in real-time** with no latency
- **No crashes** - stable and reliable
- **Native integration** with WebRTC
- **Optimized** for speech
- **Zero configuration**

### Cons ⚠️

- Less aggressive than custom RNNoise
- Cannot be tuned or adjusted
- Algorithm is browser-dependent

## Test Your Audio

To check if noise suppression is working:

1. **Start recording** in a noisy environment
2. **Check the MP3 files** in `temp_audio/` folder
3. **Listen for background noise**:
   - Fan noise should be reduced
   - Keyboard typing should be attenuated
   - Speech should be clear

The browser's noise suppression should be removing most constant background noise.

## Solutions to Enable RNNoise

### Option 1: Web Worker (Recommended)

Move RNNoise processing to a Web Worker thread:

```javascript
// audioWorker.js
self.onmessage = async (e) => {
  const audioData = e.data;
  const processed = await processWithRNNoise(audioData);
  self.postMessage(processed);
};
```

**Pros**: Non-blocking, no crashes
**Cons**: Adds complexity, slight latency

### Option 2: Synchronous Native Processing (Complex)

Create a synchronous version in the renderer process:

```javascript
// Use a preloaded native module directly in renderer
const rnnoiseNative = require("native-addon");
const processed = rnnoiseNative.processSync(audioData);
```

**Pros**: Zero latency
**Cons**: Requires major refactoring, security concerns

### Option 3: Keep Browser Noise Suppression (Current - Recommended)

Accept that browser noise suppression is "good enough":

**Pros**:

- Stable, reliable, tested
- Zero development time
- Works well for most use cases

**Cons**:

- Cannot market as "RNNoise-powered"
- Less control over algorithm

## Recommendation

**For now, stick with browser noise suppression.** It works well and is stable.

If you need more aggressive noise cancellation:

1. Implement Web Worker solution (1-2 days of work)
2. Test thoroughly for crashes
3. Compare audio quality

## Files Overview

```
native-audio/
├── src/
│   ├── microphone_rnnoise.cpp     ✅ Built successfully
│   ├── speaker_audio_capture.mm   ✅ Working
│   └── rnnoise/
│       └── rnnoise.h              ✅ Header file
├── rnnoise-wrapper.js             ✅ Wrapper works
├── binding.gyp                    ✅ Build config
└── build/Release/
    └── rnnoise.node               ✅ Compiled module (91KB)

src/
├── main.js                        ✅ IPC handlers added
├── preload.js                     ✅ API exposed
└── renderer/
    ├── audioCapture.js            ⚠️ RNNoise disabled in callback
    └── rnnoiseProcessor.js        ⚠️ Not currently used
```

## Summary

✅ **RNNoise module builds and loads successfully**
⚠️ **RNNoise NOT active in audio pipeline** (disabled to prevent crashes)
✅ **Browser noise suppression IS active** and working
✅ **App is stable** and working correctly

**Current noise cancellation**: Browser built-in (good quality)
**Target noise cancellation**: RNNoise (requires Web Worker implementation)

## Testing Noise Suppression

To verify noise suppression is working:

```bash
# 1. Start the app
npm start

# 2. Start recording in a noisy environment
# - Turn on a fan
# - Type on keyboard
# - Have background conversations

# 3. Check MP3 files in temp_audio/
ls -lh temp_audio/*.mp3

# 4. Play an MP3 to hear the result
afplay temp_audio/microphone_audio_*.mp3
```

You should hear reduced background noise and clear speech.

---

**Date**: December 16, 2025
**Status**: Using browser noise suppression (working well)
**Next Steps**: Implement Web Worker if more aggressive noise cancellation is needed
