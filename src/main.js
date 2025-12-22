const { app, BrowserWindow, ipcMain, desktopCapturer } = require("electron");
const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
const https = require("https");
const { createClient } = require("@deepgram/sdk");
const { createDeepgramConnection } = require("./deepgram-streaming");

// Try to load native audio capture module (macOS only)
let NativeAudioCapture = null;
let BlackHoleCapture = null;
let nativeAudioCapture = null;
let blackHoleManager = null;

if (process.platform === "darwin") {
  try {
    const audioModule = require("../native-audio/index.js");
    NativeAudioCapture = audioModule;
    BlackHoleCapture = audioModule.BlackHoleCapture;
    console.log("✅ Native audio capture module loaded");
  } catch (error) {
    console.log("⚠️ Native audio capture not available:", error.message);
    console.log("   Falling back to web API method");
  }

  try {
    blackHoleManager = require("./blackhole-manager.js");
    console.log("✅ BlackHole manager loaded");
  } catch (error) {
    console.log("⚠️ BlackHole manager not available:", error.message);
  }
}

// Try to load RNNoise module for microphone noise cancellation (macOS only)
let rnnoiseWrapper = null;

if (process.platform === "darwin") {
  try {
    rnnoiseWrapper = require("../native-audio/rnnoise-wrapper.js");
    console.log("✅ RNNoise wrapper loaded");
  } catch (error) {
    console.log("⚠️ RNNoise not available:", error.message);
    console.log("   Microphone will use browser's built-in noise suppression");
  }
}

let mainWindow;
let deepgramClient;
let microphoneConnection = null;
let speakerConnection = null;
let microphoneSampleRate = 48000; // Default, will be updated when microphone starts
let speakerAudioBuffer = []; // Buffer for audio chunks when connection isn't ready

// Initialize Deepgram client (kept for backward compatibility with file-based transcription if needed)
function initializeDeepgram(apiKey) {
  if (!apiKey) {
    console.error("Deepgram API key is required");
    return null;
  }
  return createClient(apiKey);
}

// Create Deepgram WebSocket connection for microphone (streaming)
function createMicrophoneConnection(apiKey, sampleRate = 48000) {
  if (microphoneConnection) {
    microphoneConnection.close();
    microphoneConnection = null;
  }

  console.log(
    `📡 Creating microphone Deepgram WebSocket connection (${sampleRate}Hz)`
  );

  microphoneConnection = createDeepgramConnection({
    apiKey,
    language: "multi",
    model: "nova-3",
    sampleRate,
    channels: 1,
    interimResults: true,
    punctuate: true,
    smartFormat: true,
    diarize: false,
    type: "microphone",
    onTranscript: (transcript, isFinal, words) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("transcript", {
          text: transcript,
          isFinal,
          source: "microphone",
          timestamp: Date.now(),
          words: words,
        });
      }
    },
    onError: (error) => {
      console.error("❌ Microphone Deepgram error:", error);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("microphone-error", error.message);
      }
    },
    onOpen: () => {
      console.log("✅ Microphone Deepgram WebSocket connected");
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("microphone-connected", true);
      }
    },
    onClose: () => {
      console.log("🔌 Microphone Deepgram WebSocket closed");
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("microphone-connected", false);
      }
    },
  });

  return microphoneConnection;
}

// Create Deepgram WebSocket connection for speaker (streaming)
function createSpeakerConnection(apiKey) {
  if (speakerConnection) {
    speakerConnection.close();
    speakerConnection = null;
  }

  console.log("📡 Creating speaker Deepgram WebSocket connection (48kHz)");

  speakerConnection = createDeepgramConnection({
    apiKey,
    language: "multi",
    model: "nova-3",
    sampleRate: 48000,
    channels: 1,
    interimResults: true,
    punctuate: true,
    smartFormat: true,
    diarize: false,
    type: "speaker",
    onTranscript: (transcript, isFinal, words) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("transcript", {
          text: transcript,
          isFinal,
          source: "speaker",
          timestamp: Date.now(),
          words: words,
        });
      }
    },
    onError: (error) => {
      console.error("❌ Speaker Deepgram error:", error);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("speaker-error", error.message);
      }
    },
    onOpen: () => {
      console.log("✅ Speaker Deepgram WebSocket connected");
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("speaker-connected", true);
      }
    },
    onClose: () => {
      console.log("🔌 Speaker Deepgram WebSocket closed");
      // Clear audio buffer on close
      speakerAudioBuffer = [];
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("speaker-connected", false);
      }
    },
  });

  return speakerConnection;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      // Enable features needed for screen/audio capture
      webSecurity: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  // Open DevTools in development
  if (process.argv.includes("--dev")) {
    mainWindow.webContents.openDevTools();
  }
}

// IPC Handlers
ipcMain.handle("initialize-deepgram", async (event, apiKey) => {
  try {
    deepgramClient = initializeDeepgram(apiKey);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("start-microphone-capture", async (event, apiKey) => {
  try {
    // Initialize Deepgram client for backward compatibility
    if (!deepgramClient) {
      deepgramClient = initializeDeepgram(apiKey);
    }

    // Create WebSocket streaming connection for microphone
    createMicrophoneConnection(apiKey, microphoneSampleRate);

    console.log(`✅ Microphone WebSocket streaming initialized`);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("start-speaker-capture", async (event, apiKey) => {
  try {
    // Initialize Deepgram client for backward compatibility
    if (!deepgramClient) {
      deepgramClient = initializeDeepgram(apiKey);
    }

    // Create WebSocket streaming connection for speaker
    createSpeakerConnection(apiKey);

    // Try to start BlackHole capture if available (macOS)
    if (BlackHoleCapture && process.platform === "darwin") {
      try {
        // Check and setup BlackHole first
        if (blackHoleManager) {
          console.log("🔧 Checking BlackHole setup...");
          const setupResult = await blackHoleManager.setup();
          if (!setupResult.success) {
            console.log("⚠️ BlackHole setup failed:", setupResult.error);
            if (mainWindow && !mainWindow.isDestroyed()) {
              let errorMsg = `BlackHole setup failed: ${setupResult.error}`;
              if (setupResult.needsRestart) {
                errorMsg +=
                  "\n\nPlease restart your Mac after installing BlackHole.";
              }
              if (setupResult.needsManualInstall) {
                errorMsg +=
                  "\n\nPlease install BlackHole manually and restart your Mac.";
              }
              mainWindow.webContents.send("speaker-error", errorMsg);
            }
            // Don't continue if installation failed - BlackHole won't be available
            return { success: false, error: setupResult.error };
          } else {
            console.log("✅ BlackHole setup complete");
            // If setup succeeded but needs restart, warn user
            if (setupResult.needsRestart) {
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send(
                  "speaker-error",
                  "BlackHole installed. Please restart your Mac for it to be recognized, then try again."
                );
              }
              return { success: false, error: "Restart required" };
            }
          }
        }

        // Always create a fresh instance to avoid state issues
        if (nativeAudioCapture) {
          console.log(
            "⚠️ Cleaning up existing native audio capture instance..."
          );
          try {
            nativeAudioCapture.stop();
          } catch (e) {
            console.log("⚠️ Error stopping existing instance:", e.message);
          }
          nativeAudioCapture = null;
          // Small delay to ensure cleanup
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        let audioSampleCount = 0;

        console.log("🎙️ Creating new BlackHole capture instance...");
        nativeAudioCapture = new BlackHoleCapture((audioBuffer) => {
          console.log(
            "🎙️ BlackHole audio capture callback",
            audioBuffer.length
          );
          // audioBuffer is a Node Buffer of float32 PCM from native
          // Reinterpret bytes as Float32Array without copying per-element
          const byteOffset = audioBuffer.byteOffset || 0;
          const byteLength =
            audioBuffer.byteLength - (audioBuffer.byteLength % 4);
          const floatData = new Float32Array(
            audioBuffer.buffer,
            byteOffset,
            byteLength / 4
          );

          // Apply audio gain normalization to boost system audio levels
          // System audio can be quieter, so we amplify it for better transcription
          const normalizedData = new Float32Array(floatData.length);

          // Calculate RMS to determine audio level
          let sumSquares = 0;
          for (let i = 0; i < floatData.length; i++) {
            sumSquares += floatData[i] * floatData[i];
          }
          const rms = Math.sqrt(sumSquares / floatData.length) || 0;

          // Find peak value to prevent clipping
          let peak = 0;
          for (let i = 0; i < floatData.length; i++) {
            const absValue = Math.abs(floatData[i]);
            if (absValue > peak) peak = absValue;
          }

          // Calculate optimal gain: boost quiet audio, prevent clipping on loud audio
          // Target RMS around 0.1-0.15 for optimal transcription quality
          // More conservative gains to avoid distortion and preserve audio quality
          let gainMultiplier = 1.0;
          if (rms > 0 && rms < 0.03) {
            // Very quiet audio - boost moderately (reduced from 3.0 to avoid distortion)
            gainMultiplier = 2.0;
          } else if (rms < 0.08) {
            // Quiet audio - boost moderately (reduced from 2.5)
            gainMultiplier = 1.8;
          } else if (rms < 0.15) {
            // Moderate audio - slight boost (reduced from 1.5)
            gainMultiplier = 1.3;
          }
          // For loud audio (rms >= 0.15), use gainMultiplier = 1.0 (no boost)

          // Prevent clipping: if peak * gain would exceed 0.95, reduce gain
          const maxSafeGain =
            peak > 0 ? Math.min(gainMultiplier, 0.95 / peak) : gainMultiplier;

          // Apply gain normalization
          for (let i = 0; i < floatData.length; i++) {
            normalizedData[i] = Math.max(
              -1,
              Math.min(1, floatData[i] * maxSafeGain)
            );
          }

          // Calculate RMS for audio validation (after normalization)
          let normalizedSumSquares = 0;
          for (let i = 0; i < normalizedData.length; i++) {
            normalizedSumSquares += normalizedData[i] * normalizedData[i];
          }
          const normalizedRms =
            Math.sqrt(normalizedSumSquares / normalizedData.length) || 0;

          // Log first few samples for debugging
          if (audioSampleCount < 3) {
            console.log(
              `📊 Audio sample ${audioSampleCount}: ${
                normalizedData.length
              } samples, original_rms≈${rms.toFixed(
                4
              )}, normalized_rms≈${normalizedRms.toFixed(
                4
              )}, peak≈${peak.toFixed(4)}, gain≈${maxSafeGain.toFixed(2)}x`
            );
            audioSampleCount++;
          }

          // Send to Deepgram WebSocket (will automatically convert Float32 to Int16)
          if (speakerConnection && speakerConnection.isReady()) {
            speakerConnection.send(normalizedData);

            // Flush any buffered audio chunks (Deepgram handles silence automatically)
            if (speakerAudioBuffer.length > 0) {
              console.log(
                `📤 Flushing ${speakerAudioBuffer.length} buffered audio chunks`
              );
              speakerAudioBuffer.forEach((bufferedData) => {
                speakerConnection.send(bufferedData);
              });
              speakerAudioBuffer = [];
            }
          } else {
            // Buffer audio if connection isn't ready yet (max 50 chunks to prevent memory issues)
            if (speakerAudioBuffer.length < 50) {
              speakerAudioBuffer.push(normalizedData);
            } else {
              // Drop oldest if buffer is full
              speakerAudioBuffer.shift();
              speakerAudioBuffer.push(normalizedData);
            }
          }
        });

        const result = nativeAudioCapture.start();
        if (result.success) {
          console.log("✅ BlackHole audio capture started");
          mainWindow.webContents.send("native-audio-started", true);
        } else {
          console.log("⚠️ BlackHole capture failed:", result.error);
          mainWindow.webContents.send(
            "speaker-error",
            `BlackHole capture failed: ${
              result.error || "Unknown error"
            }. Please ensure BlackHole is installed and a Multi-Output Device is configured.`
          );
        }
      } catch (error) {
        console.log("⚠️ BlackHole capture error:", error.message);
        // Continue with web API fallback
      }
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("stop-microphone-capture", async () => {
  // Close WebSocket connection
  if (microphoneConnection) {
    microphoneConnection.close();
    microphoneConnection = null;
  }

  console.log("✅ Microphone capture stopped");
  return { success: true };
});

ipcMain.handle("stop-speaker-capture", async () => {
  console.log("🛑 Stopping speaker capture...");

  // Stop native audio capture if running
  if (nativeAudioCapture) {
    try {
      const stopResult = nativeAudioCapture.stop();
      console.log("✅ Native audio capture stopped:", stopResult);
    } catch (error) {
      console.error("❌ Error stopping native audio capture:", error.message);
    }

    // Clear the reference to allow proper cleanup
    nativeAudioCapture = null;

    // Give a small delay to ensure native cleanup is complete
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  // Close WebSocket connection
  if (speakerConnection) {
    speakerConnection.close();
    speakerConnection = null;
    console.log("✅ Speaker Deepgram connection closed");
  }

  // Clear audio buffer
  speakerAudioBuffer = [];

  console.log("✅ Speaker capture stopped successfully");
  return { success: true };
});

ipcMain.handle(
  "send-audio-data",
  async (event, audioData, source, sampleRate) => {
    try {
      // Convert ArrayBuffer to Buffer for Node.js
      const buffer = Buffer.from(audioData);

      // Handle speaker audio (continuous streaming, not batched)
      if (source === "speaker") {
        if (speakerConnection && speakerConnection.isReady()) {
          // Convert buffer to Int16Array for streaming
          const int16Array = new Int16Array(
            buffer.buffer,
            buffer.byteOffset,
            buffer.length / 2
          );
          console.log("Sending audio data to speaker", int16Array.length);

          // Send audio continuously (even if quiet, let Deepgram handle it)
          speakerConnection.send(int16Array);
        }
        return { success: true };
      }

      // Handle microphone audio (continuous streaming, not batched)
      if (source === "microphone") {
        // Update sample rate if provided
        if (sampleRate && sampleRate !== microphoneSampleRate) {
          console.log(`📊 [Microphone] Sample rate detected: ${sampleRate} Hz`);
          microphoneSampleRate = sampleRate;

          // Recreate connection with new sample rate
          if (microphoneConnection && deepgramClient) {
            const apiKey = deepgramClient.key;
            if (apiKey) {
              console.log(
                `🔄 Recreating microphone connection with ${sampleRate}Hz`
              );
              createMicrophoneConnection(apiKey, sampleRate);
            }
          }
        }

        if (microphoneConnection && microphoneConnection.isReady()) {
          // Convert buffer to Int16Array for streaming
          const int16Array = new Int16Array(
            buffer.buffer,
            buffer.byteOffset,
            buffer.length / 2
          );

          // Send audio continuously (even if quiet, let Deepgram handle it)
          microphoneConnection.send(int16Array);
        }
        return { success: true };
      }

      return { success: false, error: "Unknown source" };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
);

// Get desktop sources for screen/audio capture
ipcMain.handle("get-desktop-sources", async (event, options = {}) => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 0, height: 0 }, // No thumbnails needed
      fetchWindowIcons: false,
    });
    return { success: true, sources };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// RNNoise handlers for microphone noise cancellation
ipcMain.handle("check-rnnoise", async () => {
  if (!rnnoiseWrapper) {
    return { available: false };
  }
  return { available: rnnoiseWrapper.available() };
});

ipcMain.handle("initialize-rnnoise", async () => {
  if (!rnnoiseWrapper) {
    return { success: false, error: "RNNoise not available" };
  }
  try {
    const success = rnnoiseWrapper.initialize();
    return { success };
  } catch (error) {
    console.error("❌ Failed to initialize RNNoise:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("process-audio-rnnoise", async (event, audioData) => {
  if (!rnnoiseWrapper) {
    return audioData; // Return original audio if RNNoise not available
  }
  try {
    // Convert array to Float32Array
    const float32Data = new Float32Array(audioData);
    const processedData = rnnoiseWrapper.processFrame(float32Data);
    // Convert back to array for IPC
    return Array.from(processedData);
  } catch (error) {
    console.error("❌ RNNoise processing error:", error);
    return audioData; // Return original audio on error
  }
});

ipcMain.handle("set-rnnoise-enabled", async (event, enabled) => {
  if (!rnnoiseWrapper) {
    return { success: false, error: "RNNoise not available" };
  }
  try {
    rnnoiseWrapper.setEnabled(enabled);
    return { success: true };
  } catch (error) {
    console.error("❌ Failed to set RNNoise state:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("destroy-rnnoise", async () => {
  if (!rnnoiseWrapper) {
    return { success: true };
  }
  try {
    rnnoiseWrapper.destroy();
    return { success: true };
  } catch (error) {
    console.error("❌ Failed to destroy RNNoise:", error);
    return { success: false, error: error.message };
  }
});

// BlackHole management handlers
ipcMain.handle("check-blackhole", async () => {
  if (!blackHoleManager || process.platform !== "darwin") {
    return { available: false, error: "BlackHole manager not available" };
  }
  try {
    const isInstalled = await blackHoleManager.checkInstalled();
    const availability = await blackHoleManager.checkBlackHoleAvailable();
    return {
      available: availability.available,
      installed: isInstalled,
    };
  } catch (error) {
    return { available: false, error: error.message };
  }
});

ipcMain.handle("setup-blackhole", async () => {
  if (!blackHoleManager || process.platform !== "darwin") {
    return { success: false, error: "BlackHole manager not available" };
  }
  try {
    const result = await blackHoleManager.setup();
    return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("install-blackhole", async () => {
  if (!blackHoleManager || process.platform !== "darwin") {
    return { success: false, error: "BlackHole manager not available" };
  }
  try {
    const result = await blackHoleManager.install();
    return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("get-audio-devices", async () => {
  if (!blackHoleManager || process.platform !== "darwin") {
    return { success: false, error: "BlackHole manager not available" };
  }
  try {
    const result = await blackHoleManager.getAudioDevices();
    return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("open-blackhole-installer", async () => {
  if (!blackHoleManager || process.platform !== "darwin") {
    return { success: false, error: "BlackHole manager not available" };
  }
  try {
    const result = await blackHoleManager.openPkgForInstallation();
    return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
});

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (microphoneConnection) {
    microphoneConnection.close();
  }
  if (speakerConnection) {
    speakerConnection.close();
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (microphoneConnection) {
    microphoneConnection.close();
  }
  if (speakerConnection) {
    speakerConnection.close();
  }
  if (nativeAudioCapture) {
    nativeAudioCapture.stop();
    nativeAudioCapture = null;
  }
});
