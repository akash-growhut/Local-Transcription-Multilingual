// Audio capture utilities for microphone and speaker

class AudioCapture {
  constructor() {
    this.microphoneStream = null;
    this.speakerStream = null;
    this.microphoneContext = null;
    this.speakerContext = null;
    this.microphoneProcessor = null;
    this.speakerProcessor = null;
    this.isMicrophoneCapturing = false;
    this.isSpeakerCapturing = false;
    this.isMicrophoneMuted = false;
    this.rnnoiseEnabled = true;
    this.rnnoiseAvailable = false;

    // Web Worker for RNNoise processing
    this.audioWorker = null;
    this.workerInitialized = false;
    this.pendingAudioBuffer = [];

    // Echo suppression - uses speaker energy from native capture (sent via IPC)
    this.speakerAudioEnergy = 0;
    this.speakerEnergyDecay = 0.9; // Slower decay for better tracking
    this.echoSuppressionEnabled = true; // ENABLED - now works with native capture via IPC
    this.echoThreshold = 0.002; // Very low threshold - any speaker audio triggers suppression
    this.lastSpeakerAudioTime = 0;
    this.echoHoldTime = 500; // Hold suppression for 500ms after speaker stops
  }

  // Set microphone mute state
  setMicrophoneMuted(muted) {
    this.isMicrophoneMuted = muted;
    console.log(`Microphone ${muted ? "muted" : "unmuted"} in AudioCapture`);
  }

  // Update speaker audio energy from native capture (called via IPC)
  updateSpeakerEnergy(rms) {
    // Update speaker energy - use max of decayed value and new value
    this.speakerAudioEnergy = Math.max(
      this.speakerAudioEnergy * this.speakerEnergyDecay,
      rms
    );
    
    // Track when speaker was last active (very sensitive threshold)
    if (rms > 0.0005) {
      this.lastSpeakerAudioTime = Date.now();
    }
  }

  // Start microphone capture
  async startMicrophoneCapture(onAudioData) {
    try {
      // Initialize Web Worker for RNNoise processing
      try {
        this.audioWorker = new Worker("audioWorker.js");
        this.workerInitialized = false;
        this.processedAudioQueue = []; // Queue for processed audio chunks

        // Set up worker message handler
        this.audioWorker.onmessage = (e) => {
          const { type, data } = e.data;

          if (type === "init-complete") {
            this.workerInitialized = true;
            this.rnnoiseAvailable = true;
            console.log("✅ RNNoise Web Worker initialized successfully");
          } else if (type === "processed") {
            // Queue processed audio for immediate use
            this.processedAudioQueue.push(new Float32Array(data.data));
          } else if (type === "error") {
            console.error("❌ Worker error:", data.error);
          }
        };

        this.audioWorker.onerror = (error) => {
          console.error("❌ Worker failed:", error);
          this.rnnoiseAvailable = false;
        };

        // Initialize the worker
        this.audioWorker.postMessage({ type: "init" });

        // Wait a bit for initialization
        await new Promise((resolve) => setTimeout(resolve, 50));

        if (this.workerInitialized) {
          console.log("✅ RNNoise noise cancellation active via Web Worker");
        } else {
          console.log("⚠️ RNNoise worker starting, will be active shortly");
        }
      } catch (error) {
        console.error("❌ Failed to initialize audio worker:", error);
        this.rnnoiseAvailable = false;
        console.log("⚠️ Falling back to browser's built-in noise suppression");
      }

      // First, list available microphones
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter(
        (device) => device.kind === "audioinput"
      );

      console.log("🎤 [Microphone] Available audio input devices:");
      audioInputs.forEach((device, index) => {
        console.log(
          `  ${index + 1}. ${
            device.label || "Unnamed device"
          } (${device.deviceId.substring(0, 20)}...)`
        );
      });

      // Request audio with aggressive echo cancellation constraints
      // This helps prevent speaker audio from being picked up when not using headphones
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          // Aggressive echo cancellation settings
          echoCancellation: { ideal: true },
          noiseSuppression: { ideal: true }, // Keep browser noise suppression as backup
          autoGainControl: { ideal: true },
          // Additional constraints for better echo handling
          latency: { ideal: 0.01 }, // Request low latency
          sampleSize: { ideal: 16 },
        },
      });

      // Log which microphone is being used
      const audioTrack = stream.getAudioTracks()[0];
      const settings = audioTrack.getSettings();
      const capabilities = audioTrack.getCapabilities();

      console.log("🎤 [Microphone] Device selected:", audioTrack.label);
      console.log("🎤 [Microphone] Settings:", {
        sampleRate: settings.sampleRate,
        channelCount: settings.channelCount,
        echoCancellation: settings.echoCancellation,
        noiseSuppression: settings.noiseSuppression,
        autoGainControl: settings.autoGainControl,
        deviceId: settings.deviceId,
      });
      console.log("🎤 [Microphone] Capabilities:", capabilities);

      this.microphoneStream = stream;

      // Create AudioContext with native sample rate - send directly to Deepgram
      this.microphoneContext = new AudioContext({
        sampleRate: settings.sampleRate,
      });
      const source = this.microphoneContext.createMediaStreamSource(stream);

      console.log(
        `🎤 [Microphone] AudioContext created at ${this.microphoneContext.sampleRate} Hz (native rate - no resampling needed)`
      );

      // Store sample rate for later use
      this.microphoneSampleRate = this.microphoneContext.sampleRate;

      // Create a script processor to capture audio data
      // Use smaller buffer (2048) for lower latency (~42ms at 48kHz instead of ~85ms with 4096)
      this.microphoneProcessor = this.microphoneContext.createScriptProcessor(
        2048,
        1,
        1
      );

      let chunkCount = 0;

      this.microphoneProcessor.onaudioprocess = (e) => {
        if (this.isMicrophoneCapturing && !this.isMicrophoneMuted) {
          let inputData = e.inputBuffer.getChannelData(0);

          // Calculate RMS for echo detection and logging
          let sumSquares = 0;
          for (let i = 0; i < inputData.length; i++) {
            sumSquares += inputData[i] * inputData[i];
          }
          const rms = Math.sqrt(sumSquares / inputData.length);

          // Log audio quality for first few chunks
          if (chunkCount < 5) {
            const peak = Math.max(...Array.from(inputData).map(Math.abs));
            const hasAudio = inputData.some(
              (sample) => Math.abs(sample) > 0.001
            );

            console.log(`🎤 [Microphone] Audio chunk ${chunkCount}:`, {
              samples: inputData.length,
              rms: rms.toFixed(4),
              peak: peak.toFixed(4),
              hasAudio,
              sampleRate: e.inputBuffer.sampleRate,
              echoSuppression: this.echoSuppressionEnabled ? "active" : "off",
              noiseSuppression:
                this.workerInitialized && this.rnnoiseEnabled
                  ? "RNNoise-WebWorker"
                  : "browser-builtin",
            });
            chunkCount++;
          }

          // Echo suppression: mute mic when speaker is playing (detected via IPC from native capture)
          if (this.echoSuppressionEnabled) {
            const now = Date.now();
            const timeSinceSpeaker = now - this.lastSpeakerAudioTime;
            const speakerActive = this.speakerAudioEnergy > this.echoThreshold || timeSinceSpeaker < this.echoHoldTime;

            // Debug logging (only occasionally)
            if (chunkCount % 200 === 0 && this.speakerAudioEnergy > 0) {
              console.log(`🔊 [Echo] Speaker energy: ${this.speakerAudioEnergy.toFixed(4)}, threshold: ${this.echoThreshold}, active: ${speakerActive}, timeSince: ${timeSinceSpeaker}ms`);
            }

            if (speakerActive) {
              // Mute the microphone while speaker is playing
              const suppressedData = new Float32Array(inputData.length);
              suppressedData.fill(0); // Complete silence
              inputData = suppressedData;
            }
          }

          // Convert Float32Array to Int16Array for Deepgram (no resampling!)
          const int16Data = this.floatTo16BitPCM(inputData);
          // Convert to Uint8Array for better IPC compatibility
          const uint8Data = new Uint8Array(int16Data.buffer);

          // Send audio data with sample rate info
          onAudioData(
            uint8Data.buffer,
            "microphone",
            this.microphoneSampleRate
          );
        }
      };

      source.connect(this.microphoneProcessor);
      this.microphoneProcessor.connect(this.microphoneContext.destination);
      this.isMicrophoneCapturing = true;

      return { success: true };
    } catch (error) {
      console.error("Microphone capture error:", error);
      return { success: false, error: error.message };
    }
  }

  // Start speaker/system audio capture
  // Note: This requires system permissions and may need native modules
  async startSpeakerCapture(onAudioData) {
    try {
      // Use Electron's desktopCapturer API for system audio capture
      // This is more reliable than getDisplayMedia in Electron

      let stream = null;

      // Try getDisplayMedia first (standard web API, should work in Electron 39+)
      if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
        try {
          // Request both audio and video (required by most Electron versions)
          stream = await navigator.mediaDevices.getDisplayMedia({
            audio: true,
            video: true,
          });

          // Stop video tracks immediately since we only need audio
          const videoTracks = stream.getVideoTracks();
          if (videoTracks.length > 0) {
            videoTracks.forEach((track) => track.stop());
          }

          // Verify we have an audio track
          const audioTracks = stream.getAudioTracks();
          if (audioTracks.length === 0) {
            stream.getTracks().forEach((track) => track.stop());
            throw new Error(
              "No audio track in the selected source. Please select a source with audio."
            );
          }
        } catch (error) {
          // If getDisplayMedia fails, try desktopCapturer as fallback
          console.log(
            "getDisplayMedia failed, trying desktopCapturer:",
            error.message
          );

          if (window.electronAPI && window.electronAPI.getDesktopSources) {
            try {
              const sourcesResult =
                await window.electronAPI.getDesktopSources();
              if (sourcesResult.success && sourcesResult.sources.length > 0) {
                const sourceId = sourcesResult.sources[0].id;

                // Use getUserMedia with desktop source
                stream = await navigator.mediaDevices.getUserMedia({
                  audio: {
                    mandatory: {
                      chromeMediaSource: "desktop",
                      chromeMediaSourceId: sourceId,
                    },
                  },
                  video: {
                    mandatory: {
                      chromeMediaSource: "desktop",
                      chromeMediaSourceId: sourceId,
                    },
                  },
                });

                // Stop video tracks
                stream.getVideoTracks().forEach((track) => track.stop());
              } else {
                throw new Error("No desktop sources available");
              }
            } catch (desktopError) {
              console.log("DesktopCapturer also failed:", desktopError.message);
              // Throw the original getDisplayMedia error with helpful message
              throw new Error(
                `Unable to capture system audio: ${error.message}\n\n` +
                  "This may require:\n" +
                  "• Screen recording permission (macOS: System Preferences > Security & Privacy > Screen Recording)\n" +
                  "• Selecting an audio source in the sharing dialog\n" +
                  "• Or a native audio capture module for automatic capture\n\n" +
                  "For production use, integrate native modules:\n" +
                  "• macOS: ScreenCaptureKit (macOS 13+) or BlackHole\n" +
                  "• Windows: WASAPI Loopback\n\n" +
                  "See NATIVE_MODULE_NOTES.md for integration details."
              );
            }
          } else {
            // Neither method available
            throw new Error(
              `System audio capture not available: ${error.message}\n\n` +
                "getDisplayMedia is not supported. This may indicate:\n" +
                "• Electron version issue\n" +
                "• Missing permissions\n" +
                "• Or use a native audio capture module\n\n" +
                "See NATIVE_MODULE_NOTES.md for native module integration."
            );
          }
        }
      } else {
        throw new Error(
          "getDisplayMedia API not available in this Electron version.\n\n" +
            "System audio capture requires:\n" +
            "• Electron 5.0+ with getDisplayMedia support\n" +
            "• Or a native audio capture module\n\n" +
            "For production use, integrate native modules:\n" +
            "• macOS: ScreenCaptureKit (macOS 13+) or BlackHole\n" +
            "• Windows: WASAPI Loopback\n\n" +
            "See NATIVE_MODULE_NOTES.md for integration details."
        );
      }

      if (!stream) {
        throw new Error("Failed to obtain audio stream");
      }

      // Check if audio track was actually selected and is enabled
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error(
          "⚠️ No audio track selected!\n\n" +
            "IMPORTANT: In the sharing dialog, you must:\n" +
            "1. Select a screen or window\n" +
            '2. ✅ CHECK THE "Share audio" or "Share system audio" checkbox\n' +
            '3. Then click "Share" or "Allow"\n\n' +
            "If you don't see an audio option, the selected source may not support audio sharing.\n\n" +
            "Note: For production use, integrate native modules for automatic system audio capture."
        );
      }

      // Validate audio track state
      const audioTrack = audioTracks[0];
      if (!audioTrack.enabled || audioTrack.readyState !== "live") {
        const state = audioTrack.readyState;
        const enabled = audioTrack.enabled;
        stream.getTracks().forEach((track) => track.stop());
        throw new Error(
          `⚠️ Audio track is not active!\n\n` +
            `Track state: ${state}\n` +
            `Track enabled: ${enabled}\n\n` +
            `Please try again and make sure to:\n` +
            `1. Select a screen/window in the dialog\n` +
            `2. ✅ CHECK "Share audio" or "Share system audio"\n` +
            `3. Click "Share" or "Allow"\n\n` +
            `If the problem persists, you may need to grant screen recording permissions.`
        );
      }

      this.speakerStream = stream;
      this.speakerContext = new AudioContext({ sampleRate: 16000 });
      const source = this.speakerContext.createMediaStreamSource(stream);

      // Track audio levels to detect if audio is actually flowing
      let audioSamplesReceived = 0;
      let lastAudioCheck = Date.now();
      const audioCheckInterval = setInterval(() => {
        if (!this.isSpeakerCapturing) {
          clearInterval(audioCheckInterval);
          return;
        }

        const timeSinceLastAudio = Date.now() - lastAudioCheck;
        // If no audio samples received in 3 seconds, warn the user
        if (audioSamplesReceived === 0 && timeSinceLastAudio > 3000) {
          console.warn(
            '⚠️ No audio data detected. Make sure audio is playing and "Share audio" was enabled.'
          );
          // Dispatch event to notify renderer
          if (window.dispatchEvent) {
            window.dispatchEvent(
              new CustomEvent("audio-capture-warning", {
                detail: {
                  message:
                    'No audio detected. Make sure "Share audio" was enabled and audio is playing.',
                },
              })
            );
          }
        }
        audioSamplesReceived = 0; // Reset counter
      }, 3000);

      // Use smaller buffer (2048) for lower latency
      this.speakerProcessor = this.speakerContext.createScriptProcessor(
        2048,
        1,
        1
      );

      this.speakerProcessor.onaudioprocess = (e) => {
        if (this.isSpeakerCapturing) {
          const inputData = e.inputBuffer.getChannelData(0);

          // Calculate RMS energy for echo detection
          let sumSquares = 0;
          for (let i = 0; i < inputData.length; i++) {
            sumSquares += inputData[i] * inputData[i];
          }
          const rms = Math.sqrt(sumSquares / inputData.length);

          // Update speaker energy tracking for echo cancellation
          // Use exponential moving average for smooth tracking
          this.speakerAudioEnergy =
            this.speakerAudioEnergy * this.speakerEnergyDecay +
            rms * (1 - this.speakerEnergyDecay);

          // Check if there's actual audio (not just silence)
          const hasAudio = rms > 0.001;
          if (hasAudio) {
            audioSamplesReceived++;
            lastAudioCheck = Date.now();
            this.lastSpeakerAudioTime = Date.now(); // Track when speaker last had audio
          }

          const int16Data = this.floatTo16BitPCM(inputData);
          // Convert to Uint8Array for better IPC compatibility
          const uint8Data = new Uint8Array(int16Data);
          onAudioData(uint8Data.buffer, "speaker");
        }
      };

      source.connect(this.speakerProcessor);
      this.speakerProcessor.connect(this.speakerContext.destination);
      this.isSpeakerCapturing = true;

      // Store interval ID for cleanup
      this.speakerAudioCheckInterval = audioCheckInterval;

      // Handle stream ending (user might stop sharing or close dialog)
      const handleTrackEnd = () => {
        if (this.isSpeakerCapturing) {
          this.stopSpeakerCapture();
          // Notify renderer that capture was stopped
          if (window.electronAPI && window.electronAPI.onSpeakerStopped) {
            window.electronAPI.onSpeakerStopped();
          }
        }
      };

      // Listen to all tracks ending
      audioTracks.forEach((track) => {
        track.onended = handleTrackEnd;
      });

      // Also listen to video tracks if any (in case user selected screen)
      stream.getVideoTracks().forEach((track) => {
        track.onended = handleTrackEnd;
      });

      return { success: true };
    } catch (error) {
      console.error("Speaker capture error:", error);

      // Provide more helpful error messages
      let errorMessage = error.message;

      if (
        error.name === "NotAllowedError" ||
        error.name === "PermissionDeniedError"
      ) {
        errorMessage =
          "Permission denied. Please:\n" +
          "1. Grant screen recording permission in System Preferences (macOS)\n" +
          "2. Or allow screen sharing in the browser dialog\n" +
          "3. For silent capture, use a native module (see NATIVE_MODULE_NOTES.md)";
      } else if (
        error.name === "NotReadableError" ||
        error.name === "TrackStartError"
      ) {
        errorMessage =
          "Cannot access audio device. This may require:\n" +
          "• Screen recording permission (macOS)\n" +
          "• Or a native audio capture module for system audio";
      } else if (error.name === "NotFoundError") {
        errorMessage =
          "No audio source found. Please ensure:\n" +
          "• Audio is playing on your system\n" +
          "• You select an audio source in the sharing dialog\n" +
          "• Or use a native module for automatic capture";
      } else if (
        error.name === "NotSupportedError" ||
        error.message.includes("not supported") ||
        error.message.includes("Not supported")
      ) {
        errorMessage =
          "Screen sharing API not supported in this Electron version.\n\n" +
          "This feature requires:\n" +
          "• Electron 5.0+ with desktopCapturer enabled\n" +
          "• Or a native audio capture module\n\n" +
          "For production use, integrate native modules:\n" +
          "• macOS: ScreenCaptureKit (macOS 13+) or BlackHole\n" +
          "• Windows: WASAPI Loopback\n\n" +
          "See NATIVE_MODULE_NOTES.md for integration details.";
      }

      return { success: false, error: errorMessage };
    }
  }

  // Stop microphone capture
  stopMicrophoneCapture() {
    this.isMicrophoneCapturing = false;

    // Clean up Web Worker
    if (this.audioWorker) {
      this.audioWorker.postMessage({ type: "terminate" });
      this.audioWorker.terminate();
      this.audioWorker = null;
      this.workerInitialized = false;
      console.log("🔴 Audio Worker terminated");
    }

    // Clear processed audio queue
    this.processedAudioQueue = [];

    if (this.microphoneProcessor) {
      this.microphoneProcessor.disconnect();
      this.microphoneProcessor = null;
    }

    if (this.microphoneContext) {
      this.microphoneContext.close();
      this.microphoneContext = null;
    }

    if (this.microphoneStream) {
      this.microphoneStream.getTracks().forEach((track) => track.stop());
      this.microphoneStream = null;
    }

    return { success: true };
  }

  // Enable or disable echo suppression
  setEchoSuppressionEnabled(enabled) {
    this.echoSuppressionEnabled = enabled;
    console.log(`🔊 Echo suppression ${enabled ? "enabled" : "disabled"}`);
  }

  // Set echo suppression parameters
  setEchoSuppressionParams(params) {
    if (params.threshold !== undefined) {
      this.echoThreshold = params.threshold;
    }
    if (params.gain !== undefined) {
      this.echoSuppressionGain = params.gain;
    }
    if (params.holdTime !== undefined) {
      this.echoHoldTime = params.holdTime;
    }
    console.log(`🔧 Echo suppression params updated:`, {
      threshold: this.echoThreshold,
      gain: this.echoSuppressionGain,
      holdTime: this.echoHoldTime,
    });
  }

  // Check if echo suppression is active
  isEchoSuppressionActive() {
    const now = Date.now();
    const timeSinceSpeaker = now - this.lastSpeakerAudioTime;
    return (
      this.echoSuppressionEnabled &&
      (this.speakerAudioEnergy > this.echoThreshold ||
        timeSinceSpeaker < this.echoHoldTime)
    );
  }

  // Enable or disable RNNoise
  setRNNoiseEnabled(enabled) {
    this.rnnoiseEnabled = enabled;

    // Send to worker if available
    if (this.audioWorker && this.workerInitialized) {
      this.audioWorker.postMessage({
        type: "set-enabled",
        data: { enabled },
      });
    }

    console.log(`🎤 RNNoise ${enabled ? "enabled" : "disabled"}`);
  }

  // Check if RNNoise is enabled
  isRNNoiseEnabled() {
    return this.rnnoiseEnabled && this.workerInitialized;
  }

  // Reset RNNoise processor
  resetRNNoise() {
    if (this.audioWorker && this.workerInitialized) {
      this.audioWorker.postMessage({ type: "reset" });
      console.log("🔄 RNNoise processor reset");
    }
  }

  // Stop speaker capture
  stopSpeakerCapture() {
    this.isSpeakerCapturing = false;

    // Reset echo-related state
    this.speakerAudioEnergy = 0;
    this.lastSpeakerAudioTime = 0;

    // Clear audio monitoring interval
    if (this.speakerAudioCheckInterval) {
      clearInterval(this.speakerAudioCheckInterval);
      this.speakerAudioCheckInterval = null;
    }

    if (this.speakerProcessor) {
      this.speakerProcessor.disconnect();
      this.speakerProcessor = null;
    }

    if (this.speakerContext) {
      this.speakerContext.close();
      this.speakerContext = null;
    }

    if (this.speakerStream) {
      this.speakerStream.getTracks().forEach((track) => track.stop());
      this.speakerStream = null;
    }

    return { success: true };
  }

  // Convert Float32Array to Int16Array (16-bit PCM)
  floatTo16BitPCM(float32Array) {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      // Clamp values to [-1, 1] range and convert to 16-bit integer
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return int16Array;
  }

  // Resample audio from one sample rate to another (simple linear interpolation)
  resampleAudio(audioData, fromSampleRate, toSampleRate) {
    if (fromSampleRate === toSampleRate) {
      return audioData;
    }

    const ratio = fromSampleRate / toSampleRate;
    const newLength = Math.round(audioData.length / ratio);
    const result = new Float32Array(newLength);

    for (let i = 0; i < newLength; i++) {
      const srcIndex = i * ratio;
      const srcIndexInt = Math.floor(srcIndex);
      const fraction = srcIndex - srcIndexInt;

      if (srcIndexInt + 1 < audioData.length) {
        // Linear interpolation between samples
        result[i] =
          audioData[srcIndexInt] * (1 - fraction) +
          audioData[srcIndexInt + 1] * fraction;
      } else {
        result[i] = audioData[srcIndexInt];
      }
    }

    return result;
  }

  // Get available audio devices
  async getAudioDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return {
        inputs: devices.filter((device) => device.kind === "audioinput"),
        outputs: devices.filter((device) => device.kind === "audiooutput"),
      };
    } catch (error) {
      console.error("Error getting audio devices:", error);
      return { inputs: [], outputs: [] };
    }
  }

  // Check if system audio capture is supported
  checkSystemAudioSupport() {
    const checks = {
      mediaDevices: !!navigator.mediaDevices,
      getDisplayMedia: !!(
        navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia
      ),
      getUserMedia: !!(
        navigator.mediaDevices && navigator.mediaDevices.getUserMedia
      ),
      electronAPI: !!(
        window.electronAPI && window.electronAPI.getDesktopSources
      ),
    };

    let supportLevel = "full";
    let message = "";

    if (!checks.mediaDevices) {
      supportLevel = "none";
      message =
        "MediaDevices API not available. This may indicate an insecure context or outdated Electron version.";
    } else if (!checks.getDisplayMedia && !checks.electronAPI) {
      supportLevel = "none";
      message =
        "System audio capture not available. Requires Electron 5.0+ with getDisplayMedia or desktopCapturer API.";
    } else if (!checks.getDisplayMedia && checks.electronAPI) {
      supportLevel = "partial";
      message =
        "getDisplayMedia not available, but desktopCapturer API is available. System audio capture should work.";
    } else {
      message =
        "System audio capture API is available (requires user permission).";
    }

    return {
      supported: checks.getDisplayMedia || checks.electronAPI,
      supportLevel,
      message,
      checks,
    };
  }
}

// Export for use in renderer
window.AudioCapture = AudioCapture;
