// JavaScript wrapper for RNNoise native module
let rnnoiseModule = null;

try {
  if (process.platform === "darwin") {
    rnnoiseModule = require("./build/Release/rnnoise.node");
    console.log("✅ RNNoise module loaded successfully");
  } else {
    console.log("⚠️ RNNoise currently only supported on macOS");
  }
} catch (error) {
  console.warn("⚠️ RNNoise native module not available:", error.message);
  console.warn("   Microphone will work without noise cancellation");
  console.warn("   To build RNNoise: cd native-audio && npm run rebuild");
}

class RNNoiseWrapper {
  constructor() {
    this.processor = null;
    this.isAvailable = rnnoiseModule !== null;
    this.enabled = true;
  }

  /**
   * Check if RNNoise is available
   * @returns {boolean} True if RNNoise module is loaded
   */
  available() {
    return this.isAvailable;
  }

  /**
   * Initialize the RNNoise processor
   * @returns {boolean} True if initialization succeeded
   */
  initialize() {
    if (!this.isAvailable) {
      console.log("⚠️ RNNoise not available, skipping initialization");
      return false;
    }

    try {
      this.processor = new rnnoiseModule.RNNoiseProcessor();
      console.log("✅ RNNoise processor initialized");
      return true;
    } catch (error) {
      console.error("❌ Failed to initialize RNNoise:", error.message);
      return false;
    }
  }

  /**
   * Process audio frame through RNNoise
   * @param {Float32Array} audioData - Audio samples to process
   * @returns {Float32Array} Processed audio samples
   */
  processFrame(audioData) {
    if (!this.processor || !this.enabled) {
      // Return original audio if processor not available or disabled
      return audioData;
    }

    try {
      return this.processor.processFrame(audioData);
    } catch (error) {
      console.error("❌ Error processing audio frame:", error.message);
      return audioData;
    }
  }

  /**
   * Enable or disable noise cancellation
   * @param {boolean} enabled - True to enable, false to disable
   */
  setEnabled(enabled) {
    this.enabled = enabled;
    if (this.processor) {
      try {
        this.processor.setEnabled(enabled);
        console.log(
          `🎤 Noise cancellation ${enabled ? "enabled" : "disabled"}`
        );
      } catch (error) {
        console.error("❌ Error setting RNNoise state:", error.message);
      }
    }
  }

  /**
   * Check if noise cancellation is enabled
   * @returns {boolean} True if enabled
   */
  isEnabled() {
    if (this.processor) {
      try {
        return this.processor.isEnabled();
      } catch (error) {
        return this.enabled;
      }
    }
    return this.enabled;
  }

  /**
   * Reset the RNNoise processor state
   */
  reset() {
    if (this.processor) {
      try {
        this.processor.reset();
        console.log("🔄 RNNoise processor reset");
      } catch (error) {
        console.error("❌ Error resetting RNNoise:", error.message);
      }
    }
  }

  /**
   * Destroy the processor and free resources
   */
  destroy() {
    if (this.processor) {
      this.processor = null;
      console.log("🔴 RNNoise processor destroyed");
    }
  }

  /**
   * Get the frame size required by RNNoise
   * @returns {number} Frame size in samples (typically 480 for 10ms at 48kHz)
   */
  getFrameSize() {
    return rnnoiseModule ? rnnoiseModule.FRAME_SIZE : 480;
  }

  /**
   * Get the optimal sample rate for RNNoise
   * @returns {number} Sample rate in Hz (48000)
   */
  getSampleRate() {
    return rnnoiseModule ? rnnoiseModule.SAMPLE_RATE : 48000;
  }
}

// Export singleton instance
const rnnoiseWrapper = new RNNoiseWrapper();

module.exports = rnnoiseWrapper;
module.exports.RNNoiseWrapper = RNNoiseWrapper;
