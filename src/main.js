const { app, BrowserWindow, ipcMain, desktopCapturer } = require("electron");
const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
const https = require("https");
const { createClient } = require("@deepgram/sdk");
const { createDeepgramConnection } = require("./deepgram-streaming");

// Try to load native audio capture module (macOS only)
let NativeAudioCapture = null;
let nativeAudioCapture = null;

if (process.platform === "darwin") {
  try {
    NativeAudioCapture = require("../native-audio/index.js");
    console.log("✅ Native audio capture module loaded");
  } catch (error) {
    console.log("⚠️ Native audio capture not available:", error.message);
    console.log("   Falling back to web API method");
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
let microphoneSampleRate = 48000; // Default to 48kHz (standard for modern Macs)
let microphoneSampleRateSet = false; // Track if sample rate has been set this session
global.deepgramApiKey = null; // Store API key globally for reconnection

// Initialize Deepgram client (kept for backward compatibility with file-based transcription if needed)
function initializeDeepgram(apiKey) {
  if (!apiKey) {
    console.error("Deepgram API key is required");
    return null;
  }
  return createClient(apiKey);
}

// Create Deepgram WebSocket connection for microphone (streaming)
function createMicrophoneConnection(apiKey, sampleRate = 16000) {
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
    model: "nova-2",
    sampleRate,
    channels: 1,
    interimResults: true,
    punctuate: true,
    smartFormat: true,
    diarize: true,
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

  console.log("📡 Creating speaker Deepgram WebSocket connection (16kHz)");

  speakerConnection = createDeepgramConnection({
    apiKey,
    language: "multi",
    model: "nova-2",
    sampleRate: 16000,
    channels: 1,
    interimResults: true,
    punctuate: true,
    smartFormat: true,
    diarize: true,
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
    // Store API key globally for reconnection
    global.deepgramApiKey = apiKey;
    
    // Reset sample rate tracking for new session
    microphoneSampleRateSet = false;
    microphoneSampleRate = 48000; // Reset to default (48kHz for modern Macs)
    
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

    // Try to start native audio capture if available (macOS)
    if (NativeAudioCapture && process.platform === "darwin") {
      try {
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

        console.log("🎙️ Creating new native audio capture instance...");
        nativeAudioCapture = new NativeAudioCapture((audioBuffer) => {
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

          // Calculate RMS for audio validation
          let sumSquares = 0;
          for (let i = 0; i < floatData.length; i++) {
            sumSquares += floatData[i] * floatData[i];
          }
          const rms = Math.sqrt(sumSquares / floatData.length) || 0;

          // Log first few samples for debugging
          if (audioSampleCount < 3) {
            console.log(
              `📊 Audio sample ${audioSampleCount}: ${
                floatData.length
              } samples, rms≈${rms.toFixed(4)}`
            );
            audioSampleCount++;
          }

          // Send to Deepgram WebSocket (will automatically convert Float32 to Int16)
          if (speakerConnection && speakerConnection.isReady()) {
            // Only send if there's actual audio (basic silence detection)
            speakerConnection.send(floatData);
          }
        });

        const result = nativeAudioCapture.start();
        if (result.success) {
          console.log("✅ Native macOS audio capture started");
          mainWindow.webContents.send("native-audio-started", true);
        } else {
          console.log("⚠️ Native audio capture failed");
          mainWindow.webContents.send(
            "speaker-error",
            "Native audio capture failed. Please check Screen Recording permissions in System Preferences."
          );
        }
      } catch (error) {
        console.log("⚠️ Native audio capture error:", error.message);
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
          speakerConnection.send(int16Array);
        }
        return { success: true };
      }

      // Handle microphone audio (continuous streaming, not batched)
      if (source === "microphone") {
        // Update sample rate if provided - but only recreate once at the start
        if (sampleRate && sampleRate !== microphoneSampleRate && !microphoneSampleRateSet) {
          console.log(`📊 [Microphone] Sample rate detected: ${sampleRate} Hz (was ${microphoneSampleRate})`);
          microphoneSampleRate = sampleRate;
          microphoneSampleRateSet = true; // Only set once per session

          // Recreate connection with correct sample rate
          const storedApiKey = global.deepgramApiKey;
          if (storedApiKey && microphoneConnection) {
            console.log(`🔄 Recreating microphone connection with ${sampleRate}Hz`);
            createMicrophoneConnection(storedApiKey, sampleRate);
            // Wait briefly for connection to establish
            return { success: true };
          }
        } else if (sampleRate && !microphoneSampleRateSet) {
          // First audio chunk with matching sample rate
          microphoneSampleRateSet = true;
          console.log(`✅ [Microphone] Sample rate confirmed: ${sampleRate} Hz`);
        }

        if (microphoneConnection && microphoneConnection.isReady()) {
          // Convert buffer to Int16Array for streaming
          const int16Array = new Int16Array(
            buffer.buffer,
            buffer.byteOffset,
            buffer.length / 2
          );

          // Simple silence detection (optional)
          let sumSquares = 0;
          for (let i = 0; i < int16Array.length; i++) {
            sumSquares += int16Array[i] * int16Array[i];
          }
          const rms = Math.sqrt(sumSquares / int16Array.length);

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
