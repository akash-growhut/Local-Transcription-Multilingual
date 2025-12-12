const {
  app,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  dialog,
} = require("electron");
const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
const https = require("https");
const { createClient } = require("@deepgram/sdk");
const {
  ensureVirtualAudioDriver,
  createMultiOutputDevice,
} = require("./driverInstaller");

// Try to load native audio capture module (macOS only)
let NativeAudioModule = null;
let SmartAudioCapture = null;
let nativeAudioCapture = null;
let captureMethod = null; // 'virtualDriver' or 'screenCapture'

if (process.platform === "darwin") {
  try {
    NativeAudioModule = require("../native-audio/index.js");
    SmartAudioCapture = NativeAudioModule.SmartAudioCapture;
    console.log("✅ Native audio capture module loaded");

    // Check available methods
    const smartCapture = new SmartAudioCapture(() => {});
    const methods = smartCapture.getAvailableMethods();

    if (methods.virtualDriver) {
      console.log(
        "✅ Surge Audio driver detected - will capture WITHOUT screen recording icon"
      );
    } else if (methods.screenCapture) {
      console.log("⚠️ Using ScreenCaptureKit (shows recording icon)");
      console.log("   For no icon: cd surge-audio-driver && ./install.sh");
    }
  } catch (error) {
    console.log("⚠️ Native audio capture not available:", error.message);
    console.log("   Falling back to web API method");
  }
}

let mainWindow;
let deepgramClient;
let microphoneConnection = null;
let speakerConnection = null;
let speakerReady = false;
let speakerSendCount = 0;

// File stream for saving audio chunks
let audioChunks = [];
let audioChunkCount = 0;
let audioByteCount = 0; // Track total bytes for duration calculation
let currentAudioFile = null;
let audioStartTime = null;
let audioSampleRate = 16000; // Will be updated based on capture method
let audioChannels = 1; // Will be updated based on capture method
const AUDIO_CHUNK_DURATION_SEC = 3; // Save 3-second chunks

// Function to transcribe audio file with Deepgram using raw PCM data
async function transcribeMP3File(mp3FilePath, fileIndex, rawFilePath) {
  if (!deepgramClient) {
    console.log(
      `⚠️ Deepgram client not initialized, skipping transcription for ${path.basename(
        mp3FilePath
      )}`
    );
    return;
  }

  try {
    console.log(
      `🎤 Transcribing audio file ${fileIndex}: ${path.basename(mp3FilePath)}`
    );

    // Use raw PCM data instead of MP3 for better compatibility
    // Read the raw PCM file (16-bit signed little-endian, 16kHz, mono)
    const pcmBuffer = fs.readFileSync(rawFilePath);

    // Get API key from the client
    const apiKey = deepgramClient.key;
    if (!apiKey) {
      console.error(`❌ Deepgram API key not found`);
      return;
    }

    // Use Deepgram REST API directly for file transcription
    // Send raw PCM data (linear16, 16kHz, mono) which we know works
    const FormData = require("form-data");
    const form = new FormData();
    form.append("file", pcmBuffer, {
      filename: path.basename(rawFilePath) || "audio.raw",
      contentType: "audio/raw",
      knownLength: pcmBuffer.length,
    });

    const options = {
      hostname: "api.deepgram.com",
      path: "/v1/listen?model=nova-3&language=multi&smart_format=true&punctuate=true&encoding=linear16&sample_rate=16000&channels=1",
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        ...form.getHeaders(),
      },
    };

    const response = await new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            const result = JSON.parse(data);
            resolve({ statusCode: res.statusCode, data: result });
          } catch (e) {
            reject(new Error(`Failed to parse response: ${e.message}`));
          }
        });
      });

      req.on("error", (error) => {
        reject(error);
      });

      // Handle form errors
      form.on("error", (error) => {
        reject(error);
      });

      // Pipe the form data to the request
      form.pipe(req);
    });

    if (response.statusCode !== 200) {
      console.error(
        `❌ Deepgram API error (${response.statusCode}):`,
        response.data
      );
      return;
    }

    const transcript =
      response.data?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
    if (transcript) {
      console.log(`💬 Transcript ${fileIndex}: "${transcript}"`);

      // Send transcript to renderer for display (in series order)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("transcript", {
          text: transcript,
          isFinal: true,
          source: "speaker",
          fileIndex: fileIndex,
          timestamp: Date.now(),
        });
      }
    } else {
      console.log(
        `⚠️ No transcript found in Deepgram result for ${path.basename(
          mp3FilePath
        )}`
      );
    }
  } catch (error) {
    console.error(
      `❌ Error transcribing ${path.basename(mp3FilePath)}:`,
      error.message
    );
  }
}

// Function to save audio chunks as MP3
function saveAudioChunksAsMP3() {
  if (audioChunks.length === 0) return;

  const timestamp = Date.now();
  const uniqueId = `${timestamp}_${Math.random().toString(36).substr(2, 9)}`;
  const rawFilePath = path.join(
    __dirname,
    "..",
    "temp_audio",
    `audio_${uniqueId}.raw`
  );
  const resampledRawPath = path.join(
    __dirname,
    "..",
    "temp_audio",
    `audio_${uniqueId}_16k.raw`
  );
  const mp3FilePath = path.join(
    __dirname,
    "..",
    "temp_audio",
    `audio_${uniqueId}.mp3`
  );

  // Track file index for sequential display
  const fileIndex = audioChunkCount;
  audioChunkCount++;

  // Save raw PCM data at original sample rate
  const rawData = Buffer.concat(audioChunks);
  fs.writeFileSync(rawFilePath, rawData);

  // Calculate actual duration
  const bytesPerSample = 2; // Int16
  const durationSec =
    rawData.length / (audioSampleRate * audioChannels * bytesPerSample);

  // Convert to both MP3 and resampled raw (16kHz mono) for Deepgram
  // Step 1: Create resampled raw file for Deepgram transcription
  const resampleCmd = `ffmpeg -f s16le -ar ${audioSampleRate} -ac ${audioChannels} -i "${rawFilePath}" -f s16le -ar 16000 -ac 1 "${resampledRawPath}" -y`;

  exec(resampleCmd, async (resampleError, stdout, stderr) => {
    if (resampleError) {
      console.log(`⚠️ Could not resample audio: ${resampleError.message}`);
    }

    // Step 2: Create MP3 file
    const ffmpegCmd = `ffmpeg -f s16le -ar ${audioSampleRate} -ac ${audioChannels} -i "${rawFilePath}" -codec:a libmp3lame -ar 16000 -ac 1 -b:a 128k "${mp3FilePath}" -y`;

    exec(ffmpegCmd, async (error, stdout, stderr) => {
      if (error) {
        console.log(
          `⚠️ Could not convert to MP3 (ffmpeg not found?): ${error.message}`
        );
        console.log(`💾 Saved raw audio to: ${rawFilePath}`);
      } else {
        // MP3 conversion successful
        console.log(
          `💾 Saved MP3: ${path.basename(mp3FilePath)} (${durationSec.toFixed(
            2
          )}s)`
        );

        // Transcribe using resampled raw PCM data (16kHz mono)
        const transcriptionRawPath = fs.existsSync(resampledRawPath)
          ? resampledRawPath
          : rawFilePath;
        await transcribeMP3File(mp3FilePath, fileIndex, transcriptionRawPath);

        // Delete raw files after transcription
        try {
          fs.unlinkSync(rawFilePath);
          if (fs.existsSync(resampledRawPath)) {
            fs.unlinkSync(resampledRawPath);
          }
        } catch (e) {
          console.log(`⚠️ Could not delete raw files`);
        }
      }
    });
  });

  // Clear chunks for next file
  audioChunks = [];
  audioByteCount = 0;
}

// Initialize Deepgram client
function initializeDeepgram(apiKey) {
  if (!apiKey) {
    console.error("Deepgram API key is required");
    return null;
  }
  return createClient(apiKey);
}

// Create Deepgram connection for microphone
function createMicrophoneConnection(apiKey, onTranscript) {
  if (microphoneConnection) {
    microphoneConnection.finish();
  }

  const client = initializeDeepgram(apiKey);
  if (!client) return null;

  const connection = client.listen.live({
    model: "nova-3",
    language: "multi",
    smart_format: true,
    interim_results: true,
    endpointing: 300,
    utterance_end_ms: 1000,
    encoding: "linear16",
    sample_rate: 16000,
    channels: 1,
  });

  connection.on("open", () => {
    console.log("Microphone Deepgram connection opened");
    mainWindow.webContents.send("microphone-connected", true);
  });

  connection.on("error", (error) => {
    console.error("Microphone Deepgram error:", error);
    mainWindow.webContents.send("microphone-error", error.message);
  });

  connection.on("close", () => {
    console.log("Microphone Deepgram connection closed");
    mainWindow.webContents.send("microphone-connected", false);
  });

  connection.on("metadata", (metadata) => {
    console.log("Microphone metadata:", metadata);
  });

  connection.on("results", (data) => {
    const transcript = data.channel?.alternatives?.[0]?.transcript;
    if (transcript) {
      const isFinal = data.is_final;
      onTranscript(transcript, isFinal, "microphone");
    }
  });

  return connection;
}

// Create Deepgram connection for speaker
function createSpeakerConnection(apiKey, onTranscript) {
  if (speakerConnection) {
    speakerConnection.finish();
  }

  const client = initializeDeepgram(apiKey);
  if (!client) return null;

  const connection = client.listen.live({
    model: "nova-3",
    language: "multi",
    smart_format: true,
    interim_results: true,
    encoding: "linear16",
    sample_rate: 16000,
    channels: 1,
  });

  console.log(
    "📡 Creating speaker Deepgram connection with config: linear16, 16kHz, mono"
  );

  connection.on("open", () => {
    console.log("Speaker Deepgram connection opened");
    speakerReady = true;
    mainWindow.webContents.send("speaker-connected", true);
  });

  connection.on("error", (error) => {
    console.error("Speaker Deepgram error:", error);
    mainWindow.webContents.send("speaker-error", error.message);
  });

  connection.on("close", () => {
    console.log("Speaker Deepgram connection closed");
    speakerReady = false;
    mainWindow.webContents.send("speaker-connected", false);
  });

  connection.on("metadata", (metadata) => {
    console.log("Speaker metadata:", metadata);
  });

  connection.on("results", (data) => {
    console.log("🎤 Speaker results event:", JSON.stringify(data, null, 2));
    const transcript = data.channel?.alternatives?.[0]?.transcript;
    if (transcript) {
      const isFinal = data.is_final;
      console.log(
        `💬 Speaker transcript (${
          isFinal ? "FINAL" : "partial"
        }): "${transcript}"`
      );
      onTranscript(transcript, isFinal, "speaker");
    } else {
      console.log(
        "⚠️ Speaker results but no transcript. Duration:",
        data.duration,
        "Speech final:",
        data.speech_final
      );
    }
  });

  connection.on("warning", (warning) => {
    console.log("⚠️ Speaker Deepgram warning:", warning);
  });

  connection.on("UtteranceEnd", (data) => {
    console.log("🔚 Speaker utterance end:", data);
  });

  connection.on("SpeechStarted", (data) => {
    console.log("🗣️ Speaker speech started:", data);
  });

  // Listen for any unhandled event
  connection.on("unhandledEvent", (event) => {
    console.log("❓ Unhandled Deepgram event:", event);
  });

  return connection;
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
    microphoneConnection = createMicrophoneConnection(
      apiKey,
      (transcript, isFinal, source) => {
        mainWindow.webContents.send("transcript", {
          text: transcript,
          isFinal,
          source,
        });
      }
    );
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("start-speaker-capture", async (event, apiKey) => {
  try {
    // Initialize Deepgram client for file transcription
    if (!deepgramClient) {
      deepgramClient = initializeDeepgram(apiKey);
    }

    speakerConnection = createSpeakerConnection(
      apiKey,
      (transcript, isFinal, source) => {
        mainWindow.webContents.send("transcript", {
          text: transcript,
          isFinal,
          source,
        });
      }
    );

    // Try to start native audio capture if available (macOS)
    // Uses SmartAudioCapture which automatically selects the best method:
    // - AudioTapCapture: Taps default output directly (NO icon, no setup)
    // - VirtualAudioCapture: Uses Surge Audio driver (NO icon, requires setup)
    // - AudioCapture: Uses ScreenCaptureKit (shows recording icon)
    if (SmartAudioCapture && process.platform === "darwin") {
      try {
        if (!nativeAudioCapture) {
          let audioSampleCount = 0;

          // Initialize audio saving
          audioChunks = [];
          audioChunkCount = 0;
          audioByteCount = 0;
          audioStartTime = Date.now();

          // ScreenCaptureKit outputs 16kHz mono (configured in native code)
          audioSampleRate = 16000;
          audioChannels = 1;

          console.log(
            `💾 Will save ${AUDIO_CHUNK_DURATION_SEC}s MP3 chunks to temp_audio/`
          );

          nativeAudioCapture = new SmartAudioCapture((audioBuffer) => {
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
            const int16Data = new Int16Array(floatData.length);
            let hasNonZero = false;
            let absSum = 0;

            for (let i = 0; i < floatData.length; i++) {
              const s = Math.max(-1, Math.min(1, floatData[i]));
              const sample =
                s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
              int16Data[i] = sample;
              absSum += sample * sample;
              if (sample !== 0) hasNonZero = true;
            }
            const rms = Math.sqrt(absSum / int16Data.length) || 0;

            // Log first few samples
            if (audioSampleCount < 5) {
              const maxVal = Math.max(...Array.from(int16Data.slice(0, 100)));
              const minVal = Math.min(...Array.from(int16Data.slice(0, 100)));
              console.log(
                `📊 Audio sample ${audioSampleCount}: ${
                  int16Data.length
                } samples, range: [${minVal}, ${maxVal}], hasNonZero: ${hasNonZero}, rms≈${rms.toFixed(
                  2
                )}`
              );
              audioSampleCount++;
            }

            // Create buffer for saving
            const buffer = Buffer.from(
              int16Data.buffer,
              int16Data.byteOffset,
              int16Data.byteLength
            );

            // Save chunk to array for MP3 conversion
            audioChunks.push(buffer);
            audioByteCount += buffer.length;

            // Calculate current duration
            const bytesPerSample = 2; // Int16
            const currentDuration =
              audioByteCount /
              (audioSampleRate * audioChannels * bytesPerSample);

            // Save as MP3 file every AUDIO_CHUNK_DURATION_SEC seconds
            if (currentDuration >= AUDIO_CHUNK_DURATION_SEC) {
              saveAudioChunksAsMP3();
            }

            // Send to Deepgram (if connected)
            if (speakerConnection && speakerReady) {
              try {
                speakerConnection.send(buffer);
                speakerSendCount++;
                if (speakerSendCount <= 5) {
                  console.log(
                    `📤 Sent audio chunk ${speakerSendCount}, size=${
                      buffer.length
                    } bytes, rms≈${rms.toFixed(2)}`
                  );
                }
              } catch (error) {
                console.error("❌ Error sending to Deepgram:", error);
              }
            } else {
              if (audioSampleCount === 1) {
                console.log("⚠️ Speaker connection not ready or not open yet");
              }
            }
          });
        }

        const result = nativeAudioCapture.start();
        if (result.success) {
          captureMethod = result.method;

          const methodMessages = {
            virtualDriver: "✅ Surge Audio driver started (no recording icon!)",
            screenCapture:
              "⚠️ ScreenCaptureKit started (recording icon visible)",
          };

          console.log(
            methodMessages[result.method] ||
              `✅ Audio capture started: ${result.method}`
          );

          mainWindow.webContents.send("native-audio-started", {
            active: true,
            method: result.method,
            noRecordingIcon: result.method === "virtualDriver",
          });
        } else {
          console.log("⚠️ Native audio capture failed:", result.error);
          mainWindow.webContents.send(
            "speaker-error",
            `Audio capture failed: ${result.error}`
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
  if (microphoneConnection) {
    microphoneConnection.finish();
    microphoneConnection = null;
    return { success: true };
  }
  return { success: false, error: "No active microphone connection" };
});

ipcMain.handle("stop-speaker-capture", async () => {
  // Stop native audio capture if running
  if (nativeAudioCapture) {
    nativeAudioCapture.stop();
    nativeAudioCapture = null;
    console.log("✅ Native audio capture stopped");
  }

  // Save any remaining audio chunks
  if (audioChunks.length > 0) {
    saveAudioChunksAsMP3();
    console.log(`💾 Saved final audio chunk`);
  }

  if (speakerConnection) {
    speakerConnection.finish();
    speakerConnection = null;
    speakerReady = false;
    return { success: true };
  }
  return { success: false, error: "No active speaker connection" };
});

ipcMain.handle("send-audio-data", async (event, audioData, source) => {
  try {
    const connection =
      source === "microphone" ? microphoneConnection : speakerConnection;
    if (connection) {
      // Convert ArrayBuffer to Buffer for Node.js
      const buffer = Buffer.from(audioData);
      connection.send(buffer);
      return { success: true };
    }
    return { success: false, error: "Connection not ready" };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

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

// Check if Surge Audio driver is installed
ipcMain.handle("check-audio-driver", async () => {
  if (!VirtualAudioCapture) {
    return {
      installed: false,
      available: false,
      message: "Native module not loaded",
    };
  }

  try {
    const capture = new VirtualAudioCapture(() => {});
    const installed = capture.isDriverInstalled();
    const deviceInfo = capture.getDeviceInfo();

    return {
      installed,
      available: true,
      deviceInfo,
      message: installed
        ? "Surge Audio driver is installed. Audio capture will NOT show recording icon."
        : "Surge Audio driver not installed. Run: cd surge-audio-driver && ./install.sh",
    };
  } catch (error) {
    return {
      installed: false,
      available: false,
      message: error.message,
    };
  }
});

// Get current audio capture method
ipcMain.handle("get-capture-method", async () => {
  const descriptions = {
    virtualDriver: "Using Surge Audio driver (no recording icon)",
    screenCapture: "Using ScreenCaptureKit (recording icon visible)",
  };

  return {
    method: captureMethod,
    noRecordingIcon: captureMethod === "virtualDriver",
    description: descriptions[captureMethod] || "No capture active",
  };
});

app.whenReady().then(async () => {
  // Ensure temp_audio directory exists
  const tempAudioDir = path.join(__dirname, "..", "temp_audio");
  if (!fs.existsSync(tempAudioDir)) {
    fs.mkdirSync(tempAudioDir, { recursive: true });
    console.log(`📁 Created temp_audio directory: ${tempAudioDir}`);
  }

  createWindow();

  // Check and install virtual audio driver if needed (macOS only)
  if (process.platform === "darwin") {
    try {
      const result = await ensureVirtualAudioDriver(mainWindow);
      if (result.wasInstalled) {
        console.log("🔄 Reloading native audio module after driver install...");
        // Reload the native module to detect the new driver
        delete require.cache[require.resolve("../native-audio/index.js")];
        NativeAudioModule = require("../native-audio/index.js");
        SmartAudioCapture = NativeAudioModule.SmartAudioCapture;
      }
    } catch (error) {
      console.log("⚠️ Driver check failed:", error.message);
    }
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (microphoneConnection) {
    microphoneConnection.finish();
  }
  if (speakerConnection) {
    speakerConnection.finish();
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (microphoneConnection) {
    microphoneConnection.finish();
  }
  if (speakerConnection) {
    speakerConnection.finish();
  }
  if (nativeAudioCapture) {
    nativeAudioCapture.stop();
    nativeAudioCapture = null;
  }
});
