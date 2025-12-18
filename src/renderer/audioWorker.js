// Web Worker for RNNoise audio processing
// This runs in a separate thread to avoid blocking the main audio callback

// Worker state
let isInitialized = false;
let processingEnabled = true;
let processedCount = 0;

// Simple noise gate implementation (lightweight and fast)
class NoiseGate {
  constructor() {
    this.threshold = 0.008; // Slightly lower threshold for better speech detection
    this.attackCoef = 0.999; // Pre-computed for speed
    this.releaseCoef = 0.998;
    this.envelope = 0.0;
    this.gain = 1.0;
    this.holdCounter = 0;
    this.holdSamples = 2400; // ~50ms at 48kHz
  }

  process(samples) {
    const output = new Float32Array(samples.length);
    const len = samples.length;

    for (let i = 0; i < len; i++) {
      const inputLevel = Math.abs(samples[i]);

      // Fast envelope follower
      if (inputLevel > this.envelope) {
        this.envelope = this.attackCoef * this.envelope + (1.0 - this.attackCoef) * inputLevel;
        this.holdCounter = this.holdSamples;
      } else if (this.holdCounter > 0) {
        this.holdCounter--;
      } else {
        this.envelope = this.releaseCoef * this.envelope + (1.0 - this.releaseCoef) * inputLevel;
      }

      // Smooth gate with faster response
      const targetGain = this.envelope > this.threshold ? 1.0 : 0.1; // Don't fully silence, just attenuate
      this.gain = this.gain * 0.9 + targetGain * 0.1;

      output[i] = samples[i] * this.gain;
    }

    return output;
  }
}

// Fast noise reduction using simple statistics
class FastNoiseReduction {
  constructor() {
    this.noiseFloor = 0.005; // Estimated noise floor
    this.smoothingFactor = 0.98;
    this.framesProcessed = 0;
    this.learningFrames = 5; // Reduced learning time
  }

  process(samples) {
    const output = new Float32Array(samples.length);
    const len = samples.length;

    // Calculate RMS of current frame
    let sumSquares = 0;
    for (let i = 0; i < len; i++) {
      sumSquares += samples[i] * samples[i];
    }
    const rms = Math.sqrt(sumSquares / len);

    // Learn noise floor from quiet frames
    if (this.framesProcessed < this.learningFrames) {
      this.noiseFloor = this.noiseFloor * this.smoothingFactor + rms * (1 - this.smoothingFactor);
      this.framesProcessed++;
      output.set(samples);
      return output;
    }

    // Update noise floor slowly when signal is very quiet
    if (rms < this.noiseFloor * 1.5) {
      this.noiseFloor = this.noiseFloor * 0.999 + rms * 0.001;
    }

    // Apply soft noise reduction
    const threshold = this.noiseFloor * 2;
    for (let i = 0; i < len; i++) {
      const absVal = Math.abs(samples[i]);
      if (absVal > threshold) {
        // Signal above noise, keep it
        output[i] = samples[i];
      } else {
        // Apply soft knee attenuation
        const ratio = absVal / threshold;
        output[i] = samples[i] * ratio * ratio; // Quadratic soft knee
      }
    }

    return output;
  }

  reset() {
    this.noiseFloor = 0.005;
    this.framesProcessed = 0;
  }
}

// Initialize processor components
const noiseGate = new NoiseGate();
const noiseReduction = new FastNoiseReduction();

console.log("🔧 Audio Worker initialized with fast processors");

// Handle messages from main thread
self.onmessage = function (e) {
  const { type, data } = e.data;

  switch (type) {
    case "init":
      isInitialized = true;
      processingEnabled = true;
      noiseReduction.reset();
      processedCount = 0;
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

        // Apply fast noise reduction pipeline
        audioData = noiseReduction.process(audioData);
        audioData = noiseGate.process(audioData);

        processedCount++;

        // Send processed audio back immediately
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
      noiseReduction.reset();
      processedCount = 0;
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
