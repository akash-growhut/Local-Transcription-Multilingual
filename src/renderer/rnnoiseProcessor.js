// Renderer-side RNNoise processor wrapper
// This allows synchronous processing in the audio callback

class RNNoiseProcessorRenderer {
  constructor() {
    this.enabled = true;
    this.available = false;
    this.processor = null;
  }

  async initialize() {
    try {
      // Check if RNNoise is available via IPC
      const status = await window.electronAPI.checkRNNoise();
      this.available = status.available;

      if (this.available) {
        // Initialize the processor
        const result = await window.electronAPI.initializeRNNoise();
        if (result.success) {
          console.log("✅ RNNoise processor initialized for renderer");
          return true;
        }
      }

      console.log("⚠️ RNNoise not available in renderer");
      return false;
    } catch (error) {
      console.error("❌ Failed to initialize RNNoise in renderer:", error);
      this.available = false;
      return false;
    }
  }

  // Simple noise gate implementation for renderer (lightweight fallback)
  processFrameSimple(audioData) {
    if (!this.enabled || !audioData || audioData.length === 0) {
      return audioData;
    }

    // Simple noise gate
    const threshold = 0.01; // -40dB
    const output = new Float32Array(audioData.length);

    // Calculate RMS
    let sumSquares = 0;
    for (let i = 0; i < audioData.length; i++) {
      sumSquares += audioData[i] * audioData[i];
    }
    const rms = Math.sqrt(sumSquares / audioData.length);

    // Apply gate
    if (rms > threshold) {
      // Signal is above threshold, copy as-is
      output.set(audioData);
    } else {
      // Signal is below threshold, attenuate
      const attenuation = 0.1;
      for (let i = 0; i < audioData.length; i++) {
        output[i] = audioData[i] * attenuation;
      }
    }

    return output;
  }

  setEnabled(enabled) {
    this.enabled = enabled;

    // Also update main process
    if (this.available) {
      window.electronAPI.setRNNoiseEnabled(enabled).catch((err) => {
        console.error("Error setting RNNoise state:", err);
      });
    }
  }

  isEnabled() {
    return this.enabled && this.available;
  }

  isAvailable() {
    return this.available;
  }

  async destroy() {
    if (this.available) {
      await window.electronAPI.destroyRNNoise();
    }
    this.processor = null;
    this.available = false;
  }
}

// Export singleton
window.rnnoiseProcessor = new RNNoiseProcessorRenderer();
