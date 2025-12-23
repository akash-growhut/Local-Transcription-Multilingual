// JavaScript wrapper for native audio capture module
let nativeModule = null;

try {
  if (process.platform === "darwin" || process.platform === "win32") {
    nativeModule = require("./build/Release/speaker_audio_capture.node");
  }
} catch (error) {
  console.warn("Native audio capture module not available:", error.message);
  console.warn("Falling back to web API method");
  console.warn(
    "To build the native module, run: cd native-audio && npm install && npm run rebuild"
  );
}

class AudioCapture {
  constructor(callback, options = {}) {
    this.capture = null;
    this.audioCallback = callback || null;
    this.isCapturing = false;
    this.defaultOptions = options; // Store options for use in start()
  }

  isAvailable() {
    return nativeModule !== null;
  }

  start(callback, options) {
    if (!this.isAvailable()) {
      return {
        success: false,
        error:
          "Native module not available. Build it with: cd native-audio && npm install && npm run rebuild",
      };
    }

    try {
      // CRITICAL: Options must be passed to constructor, not start()
      // This ensures HAL mode is set BEFORE any ScreenCaptureKit initialization
      // Use provided options, or fall back to options stored in constructor, or empty object
      const captureOptions = options || this.defaultOptions || {};

      // If instance doesn't exist, create it with callback AND options
      if (!this.capture) {
        // Use provided callback or stored one
        const cb = callback || this.audioCallback;
        if (!cb) {
          return { success: false, error: "No callback provided" };
        }
        // Create capture instance with callback AND options
        // Options are passed as second argument to constructor
        this.capture = new nativeModule.AudioCapture(cb, captureOptions);
      }

      // Support options: { mode: 'hal' | 'screencapturekit' }
      // Default is 'screencapturekit' (App Store safe)
      // 'hal' is experimental Granola-style capture (not App Store safe)
      // Note: Options should already be set in constructor, but we can pass them to start() too for compatibility
      const result = this.capture.start(captureOptions);
      this.isCapturing = result;

      return { success: result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  stop() {
    if (!this.capture) {
      return { success: false };
    }

    try {
      this.capture.stop();
      this.isCapturing = false;

      // Clear the reference to allow garbage collection
      // This ensures the destructor is called before creating a new instance
      this.capture = null;

      // Force garbage collection hint (not guaranteed but helpful)
      if (global.gc) {
        global.gc();
      }

      return { success: true };
    } catch (error) {
      this.capture = null;
      return { success: false, error: error.message };
    }
  }

  isActive() {
    if (!this.capture) {
      return false;
    }
    try {
      return this.capture.isActive();
    } catch (error) {
      return false;
    }
  }
}

module.exports = AudioCapture;
