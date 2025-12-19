// JavaScript wrapper for native audio capture with AEC module
let nativeModule = null;

try {
  if (process.platform === "darwin") {
    nativeModule = require("./build/Release/audio_capture_with_aec.node");
  }
} catch (error) {
  console.warn(
    "Native audio capture with AEC module not available:",
    error.message
  );
  console.warn("Falling back to separate capture methods");
  console.warn(
    "To build the native module, run: cd native-audio && npm install && npm run rebuild"
  );
}

class AudioCaptureWithAEC {
  constructor(speakerCallback, microphoneCallback) {
    this.capture = null;
    this.speakerCallback = speakerCallback || null;
    this.microphoneCallback = microphoneCallback || null;
    this.isCapturing = false;
  }

  isAvailable() {
    return nativeModule !== null;
  }

  start(speakerCallback, microphoneCallback) {
    if (!this.isAvailable()) {
      return {
        success: false,
        error:
          "Native module not available. Build it with: cd native-audio && npm install && npm run rebuild",
      };
    }

    try {
      // Use provided callbacks or stored ones
      const speakerCb = speakerCallback || this.speakerCallback;
      const micCb = microphoneCallback || this.microphoneCallback;

      if (!speakerCb || !micCb) {
        return {
          success: false,
          error: "Both speaker and microphone callbacks required",
        };
      }

      // Create capture instance with both callbacks
      this.capture = new nativeModule.AudioCaptureWithAEC(speakerCb, micCb);

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

module.exports = AudioCaptureWithAEC;
