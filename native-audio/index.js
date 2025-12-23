// JavaScript wrapper for native audio capture module
// Uses HAL AudioServerPlugIn driver (not ScreenCaptureKit)
let nativeModule = null;

try {
  if (process.platform === "darwin") {
    // Try to load driver-based capture module
    nativeModule = require("./build/Release/driver_audio_capture.node");
  } else if (process.platform === "win32") {
    // Windows still uses the old module (WASAPI)
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

  /**
   * Check if the HAL audio driver is available and installed
   */
  async checkDriverAvailable() {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      if (typeof nativeModule.DriverAudioCapture !== "undefined") {
        // Try to check driver availability
        const testInstance = new nativeModule.DriverAudioCapture(() => {});
        const available = testInstance.checkDriverAvailable();
        return available;
      }
      return false;
    } catch (error) {
      console.warn("Error checking driver availability:", error.message);
      return false;
    }
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

      // On macOS, use DriverAudioCapture (HAL plug-in based)
      // On Windows, use old AudioCapture (WASAPI)
      if (process.platform === "darwin" && typeof nativeModule.DriverAudioCapture !== "undefined") {
        this.capture = new nativeModule.DriverAudioCapture(cb);
      } else if (typeof nativeModule.AudioCapture !== "undefined") {
        this.capture = new nativeModule.AudioCapture(cb);
      } else {
        return {
          success: false,
          error: "No compatible audio capture class found in native module",
        };
      }

      const result = this.capture.start();
      this.isCapturing = result;

      if (!result && process.platform === "darwin") {
        return {
          success: false,
          error:
            "Failed to start capture. Make sure the HAL audio driver is installed and enabled. " +
            "The virtual audio device should be set as your system output in System Preferences > Sound.",
        };
      }

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
