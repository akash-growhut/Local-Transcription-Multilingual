// Web Worker for RNNoise audio processing
// This runs in a separate thread to avoid blocking the main audio callback

// Worker state
let isInitialized = false;
let processingEnabled = true;

// Simple noise gate implementation (lightweight)
class NoiseGate {
  constructor() {
    this.threshold = 0.01; // -40dB
    this.attackTime = 0.001; // 1ms
    this.releaseTime = 0.1; // 100ms
    this.holdTime = 0.05; // 50ms
    this.envelope = 0.0;
    this.holdCounter = 0.0;
    this.sampleRate = 48000;
  }

  process(samples) {
    const attackCoef = Math.exp(-1.0 / (this.attackTime * this.sampleRate));
    const releaseCoef = Math.exp(-1.0 / (this.releaseTime * this.sampleRate));
    const output = new Float32Array(samples.length);

    for (let i = 0; i < samples.length; i++) {
      const inputLevel = Math.abs(samples[i]);

      // Envelope follower
      if (inputLevel > this.envelope) {
        this.envelope =
          attackCoef * this.envelope + (1.0 - attackCoef) * inputLevel;
        this.holdCounter = this.holdTime * this.sampleRate;
      } else {
        if (this.holdCounter > 0) {
          this.holdCounter--;
        } else {
          this.envelope =
            releaseCoef * this.envelope + (1.0 - releaseCoef) * inputLevel;
        }
      }

      // Apply gate with smooth transitions
      let gain = this.envelope > this.threshold ? 1.0 : 0.0;

      // Exponential smoothing for gain to avoid clicks
      if (!this.prevGain) this.prevGain = 1.0;
      gain = this.prevGain * 0.95 + gain * 0.05;
      this.prevGain = gain;

      output[i] = samples[i] * gain;
    }

    return output;
  }
}

// Spectral noise reduction (simplified for Web Worker)
class SpectralNoiseReduction {
  constructor(frameSize = 480) {
    this.frameSize = frameSize;
    this.noiseProfile = new Float32Array(frameSize);
    this.smoothingFactor = 0.95; // How much to smooth noise profile
    this.noiseLearningFrames = 10;
    this.framesProcessed = 0;
  }

  updateNoiseProfile(samples) {
    for (let i = 0; i < Math.min(samples.length, this.frameSize); i++) {
      const absVal = Math.abs(samples[i]);
      this.noiseProfile[i] =
        this.noiseProfile[i] * this.smoothingFactor +
        absVal * (1.0 - this.smoothingFactor);
    }
  }

  process(samples) {
    const output = new Float32Array(samples.length);

    // Learn noise profile in first few frames
    if (this.framesProcessed < this.noiseLearningFrames) {
      this.updateNoiseProfile(samples);
      this.framesProcessed++;
      // During learning, just copy input
      output.set(samples);
      return output;
    }

    // Apply spectral subtraction
    for (let i = 0; i < samples.length; i++) {
      const signal = Math.abs(samples[i]);
      const noise =
        i < this.frameSize ? this.noiseProfile[i] : this.noiseProfile[0];

      // If signal is significantly above noise, keep it
      if (signal > noise * 2.0) {
        const gain = Math.max(0.0, Math.min(1.0, 1.0 - noise / signal));
        output[i] = samples[i] * gain;
      } else {
        // Signal is in noise floor, attenuate heavily
        output[i] = samples[i] * 0.1;
      }
    }

    return output;
  }

  reset() {
    this.noiseProfile.fill(0);
    this.framesProcessed = 0;
  }
}

// Initialize processor components
const noiseGate = new NoiseGate();
const spectralNR = new SpectralNoiseReduction(480); // 10ms at 48kHz

console.log("🔧 Audio Worker initialized");

// Handle messages from main thread
self.onmessage = function (e) {
  const { type, data } = e.data;

  switch (type) {
    case "init":
      isInitialized = true;
      processingEnabled = true;
      spectralNR.reset();
      self.postMessage({
        type: "init-complete",
        success: true,
      });
      console.log("✅ Audio Worker ready for processing");
      break;

    case "process":
      if (!isInitialized || !processingEnabled) {
        // If not enabled, return original audio
        self.postMessage({
          type: "processed",
          data: data.audioData,
          timestamp: data.timestamp,
        });
        return;
      }

      try {
        // Convert array back to Float32Array
        let audioData = new Float32Array(data.audioData);

        // Apply noise reduction
        audioData = spectralNR.process(audioData);
        audioData = noiseGate.process(audioData);

        // Send processed audio back
        self.postMessage({
          type: "processed",
          data: Array.from(audioData),
          timestamp: data.timestamp,
        });
      } catch (error) {
        console.error("❌ Worker processing error:", error);
        // Return original audio on error
        self.postMessage({
          type: "processed",
          data: data.audioData,
          timestamp: data.timestamp,
        });
      }
      break;

    case "set-enabled":
      processingEnabled = data.enabled;
      console.log(
        `🎤 Worker: Noise cancellation ${
          processingEnabled ? "enabled" : "disabled"
        }`
      );
      self.postMessage({
        type: "set-enabled-complete",
        enabled: processingEnabled,
      });
      break;

    case "reset":
      spectralNR.reset();
      console.log("🔄 Worker: Processor reset");
      self.postMessage({
        type: "reset-complete",
      });
      break;

    case "terminate":
      console.log("🔴 Worker: Terminating");
      self.close();
      break;

    default:
      console.warn("⚠️ Worker: Unknown message type:", type);
  }
};

// Handle errors
self.onerror = function (error) {
  console.error("❌ Worker error:", error);
  self.postMessage({
    type: "error",
    error: error.message,
  });
};

console.log("🎙️ Audio Worker ready");
