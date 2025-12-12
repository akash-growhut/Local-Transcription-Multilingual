// JavaScript wrapper for native audio capture module
// Supports three modes:
// 1. AudioTapCapture (BEST) - Taps default output directly, no user action needed, no icon
// 2. VirtualAudioCapture - Uses Surge Audio virtual driver (requires install + config)
// 3. AudioCapture (legacy) - Uses ScreenCaptureKit (shows screen recording icon)

let nativeModule = null;

try {
  if (process.platform === "darwin") {
    nativeModule = require("./build/Release/audio_capture.node");
  }
} catch (error) {
  console.warn("Native audio capture module not available:", error.message);
  console.warn("Falling back to web API method");
  console.warn(
    "To build the native module, run: cd native-audio && npm install && npm run rebuild"
  );
}

/**
 * AudioTapCapture - Captures audio by tapping the default output device
 *
 * This is the BEST method:
 * - No screen recording icon
 * - No driver installation required
 * - No user configuration needed
 * - Automatically captures from whatever speakers are playing
 */
class AudioTapCapture {
  constructor(callback) {
    this.capture = null;
    this.audioCallback = callback || null;
    this.isCapturing = false;
  }

  /**
   * Check if the native module is available
   */
  isAvailable() {
    return nativeModule !== null && nativeModule.AudioTapCapture !== undefined;
  }

  /**
   * Get information about the current output device
   */
  getOutputDeviceInfo() {
    if (!this.isAvailable()) {
      return { available: false, error: "Native module not available" };
    }
    try {
      const temp = new nativeModule.AudioTapCapture(() => {});
      const info = temp.getOutputDeviceInfo();
      return info;
    } catch (error) {
      return { available: false, error: error.message };
    }
  }

  /**
   * Start capturing audio from the system output
   */
  start(callback) {
    if (!this.isAvailable()) {
      return {
        success: false,
        error:
          "Native module not available. Build it with: cd native-audio && npm install && npm run rebuild",
      };
    }

    try {
      const cb = callback || this.audioCallback;
      if (!cb) {
        return { success: false, error: "No callback provided" };
      }

      this.capture = new nativeModule.AudioTapCapture(cb);
      const result = this.capture.start();
      this.isCapturing = result;

      return { success: result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Stop capturing audio
   */
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

  /**
   * Check if currently capturing
   */
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

/**
 * VirtualAudioCapture - Captures audio using the Surge Audio virtual driver
 * Requires driver installation and user to change audio output settings
 */
class VirtualAudioCapture {
  constructor(callback) {
    this.capture = null;
    this.audioCallback = callback || null;
    this.isCapturing = false;
  }

  isAvailable() {
    return (
      nativeModule !== null && nativeModule.VirtualAudioCapture !== undefined
    );
  }

  isDriverInstalled() {
    if (!this.isAvailable()) {
      return false;
    }
    try {
      const temp = new nativeModule.VirtualAudioCapture(() => {});
      const installed = temp.isDriverInstalled();
      temp.stop();
      return installed;
    } catch (error) {
      console.error("Error checking driver installation:", error.message);
      return false;
    }
  }

  getDeviceInfo() {
    if (!this.isAvailable()) {
      return { installed: false, error: "Native module not available" };
    }
    try {
      const temp = new nativeModule.VirtualAudioCapture(() => {});
      const info = temp.getDeviceInfo();
      temp.stop();
      return info;
    } catch (error) {
      return { installed: false, error: error.message };
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
      const cb = callback || this.audioCallback;
      if (!cb) {
        return { success: false, error: "No callback provided" };
      }

      this.capture = new nativeModule.VirtualAudioCapture(cb);

      if (!this.capture.isDriverInstalled()) {
        return {
          success: false,
          error:
            "Surge Audio driver not installed. Please run: cd surge-audio-driver && ./install.sh",
          driverNotInstalled: true,
        };
      }

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

/**
 * AudioCapture (Legacy) - Captures audio using ScreenCaptureKit
 * This method WILL show the screen recording icon on macOS
 */
class AudioCapture {
  constructor(callback) {
    this.capture = null;
    this.audioCallback = callback || null;
    this.isCapturing = false;
  }

  isAvailable() {
    return nativeModule !== null && nativeModule.AudioCapture !== undefined;
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
      const cb = callback || this.audioCallback;
      if (!cb) {
        return { success: false, error: "No callback provided" };
      }

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

/**
 * Smart audio capture that automatically chooses the best method:
 * 1. AudioTapCapture - Taps output directly (BEST - no icon, no setup)
 * 2. VirtualAudioCapture - If driver installed (no icon, requires setup)
 * 3. AudioCapture - ScreenCaptureKit fallback (shows icon)
 */
class SmartAudioCapture {
  constructor(callback) {
    this.audioCallback = callback || null;
    this.activeCapture = null;
    this.captureMethod = null;
  }

  isAvailable() {
    return nativeModule !== null;
  }

  /**
   * Check which capture methods are available
   */
  getAvailableMethods() {
    const methods = {
      audioTap: false,
      virtualDriver: false,
      screenCapture: false,
      recommended: null,
    };

    if (!nativeModule) {
      return methods;
    }

    // Check AudioTapCapture (BEST - preferred)
    const tapCapture = new AudioTapCapture(() => {});
    if (tapCapture.isAvailable()) {
      methods.audioTap = true;
      methods.recommended = "audioTap";
    }

    // Check VirtualAudioCapture
    const virtualCapture = new VirtualAudioCapture(() => {});
    if (virtualCapture.isAvailable() && virtualCapture.isDriverInstalled()) {
      methods.virtualDriver = true;
      if (!methods.recommended) {
        methods.recommended = "virtualDriver";
      }
    }

    // Check ScreenCaptureKit (fallback)
    const screenCapture = new AudioCapture(() => {});
    if (screenCapture.isAvailable()) {
      methods.screenCapture = true;
      if (!methods.recommended) {
        methods.recommended = "screenCapture";
      }
    }

    return methods;
  }

  /**
   * Start capturing using the best available method
   */
  start(callback) {
    const cb = callback || this.audioCallback;
    if (!cb) {
      return { success: false, error: "No callback provided" };
    }

    const methods = this.getAvailableMethods();

    // Note: AudioTapCapture doesn't work on macOS without special entitlements
    // The aggregate device approach can't tap output audio
    // Skip it and go straight to working methods

    // Try virtual driver first (no icon, but requires driver install)
    if (methods.virtualDriver) {
      this.activeCapture = new VirtualAudioCapture(cb);
      const result = this.activeCapture.start();
      if (result.success) {
        this.captureMethod = "virtualDriver";
        console.log(
          "✅ Using Surge Audio virtual driver (no screen recording icon)"
        );
        return { ...result, method: "virtualDriver" };
      }
    }

    // Fall back to ScreenCaptureKit (works but shows icon)
    if (methods.screenCapture) {
      this.activeCapture = new AudioCapture(cb);
      const result = this.activeCapture.start();
      if (result.success) {
        this.captureMethod = "screenCapture";
        console.log(
          "⚠️ Using ScreenCaptureKit (screen recording icon will appear)"
        );
        return { ...result, method: "screenCapture" };
      }
    }

    return {
      success: false,
      error:
        "No audio capture method available. Install Surge Audio driver for silent capture.",
    };
  }

  stop() {
    if (!this.activeCapture) {
      return { success: false };
    }

    const result = this.activeCapture.stop();
    this.activeCapture = null;
    this.captureMethod = null;
    return result;
  }

  isActive() {
    return this.activeCapture ? this.activeCapture.isActive() : false;
  }

  getCaptureMethod() {
    return this.captureMethod;
  }
}

// Export all classes
module.exports = {
  // Recommended: Smart capture that auto-selects best method
  SmartAudioCapture,

  // Individual capture methods (in order of preference)
  AudioTapCapture, // BEST: Taps output directly (no icon, no setup)
  VirtualAudioCapture, // Uses Surge Audio driver (no icon, requires setup)
  AudioCapture, // Uses ScreenCaptureKit (shows icon)

  // Legacy default export (for backward compatibility)
  default: AudioCapture,
};

// Also export AudioCapture directly for backward compatibility
module.exports.AudioCapture = AudioCapture;
