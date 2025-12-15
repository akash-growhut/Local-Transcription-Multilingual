// JavaScript wrapper for native audio capture module
let nativeModule = null;

try {
  if (process.platform === "darwin") {
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
  constructor(callback) {
    this.capture = null;
    this.audioCallback = callback || null;
    this.isCapturing = false;
  }

  isAvailable() {
    return nativeModule !== null;
  }

  start(callback) {
    if (!this.isAvailable()) {
      return {
        success: false,
        error:
          "Native module not available. Build it with: cd native-audio && npm install && npm run rebuild",
      };
    }

    try {
      // Use provided callback or stored one
      const cb = callback || this.audioCallback;
      if (!cb) {
        return { success: false, error: "No callback provided" };
      }

      // Create capture instance with callback
      this.capture = new nativeModule.AudioCapture(cb);

      const result = this.capture.start();
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
      this.capture = null;
      return { success: true };
    } catch (error) {
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
