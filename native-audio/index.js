// JavaScript wrapper for native audio capture module
let nativeModule = null;
let blackHoleModule = null;

try {
  if (process.platform === "darwin" || process.platform === "win32") {
    nativeModule = require("./build/Release/speaker_audio_capture.node");
  }
} catch (error) {
  console.warn("ScreenCaptureKit module not available:", error.message);
}

try {
  if (process.platform === "darwin") {
    blackHoleModule = require("./build/Release/blackhole_capture.node");
  }
} catch (error) {
  console.warn("BlackHole capture module not available:", error.message);
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

class BlackHoleCapture {
  constructor(callback) {
    this.capture = null;
    this.audioCallback = callback || null;
    this.isCapturing = false;
  }

  isAvailable() {
    return blackHoleModule !== null;
  }

  start(callback) {
    if (!this.isAvailable()) {
      return {
        success: false,
        error:
          "BlackHole capture module not available. Build it with: cd native-audio && npm install && npm run rebuild",
      };
    }

    try {
      // Use provided callback or stored one
      const cb = callback || this.audioCallback;
      if (!cb) {
        return { success: false, error: "No callback provided" };
      }

      // Create capture instance with callback
      this.capture = new blackHoleModule.BlackHoleCapture(cb);

      const result = this.capture.start(cb);
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
      this.capture = null;

      // Force garbage collection hint
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
module.exports.BlackHoleCapture = BlackHoleCapture;
