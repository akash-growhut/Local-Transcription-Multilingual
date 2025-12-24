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

// Export function to get microphone app name
function getMicrophoneAppName() {
  if (!nativeModule || !nativeModule.getMicrophoneAppName) {
    return "Unknown";
  }
  try {
    return nativeModule.getMicrophoneAppName();
  } catch (error) {
    console.warn("Error getting microphone app name:", error.message);
    return "Unknown";
  }
}

// Export functions for continuous monitoring
function startMicrophoneMonitoring(callback) {
  if (!nativeModule || !nativeModule.startMicrophoneMonitoring) {
    console.warn("Microphone monitoring not available");
    return false;
  }
  try {
    nativeModule.startMicrophoneMonitoring(callback);
    return true;
  } catch (error) {
    console.warn("Error starting microphone monitoring:", error.message);
    return false;
  }
}

function stopMicrophoneMonitoring() {
  if (!nativeModule || !nativeModule.stopMicrophoneMonitoring) {
    return false;
  }
  try {
    nativeModule.stopMicrophoneMonitoring();
    return true;
  } catch (error) {
    console.warn("Error stopping microphone monitoring:", error.message);
    return false;
  }
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

module.exports = AudioCapture;
module.exports.getMicrophoneAppName = getMicrophoneAppName;
module.exports.startMicrophoneMonitoring = startMicrophoneMonitoring;
module.exports.stopMicrophoneMonitoring = stopMicrophoneMonitoring;
