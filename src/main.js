const { app, BrowserWindow, ipcMain, desktopCapturer, systemPreferences } = require("electron");
const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
const https = require("https");
const { createClient } = require("@deepgram/sdk");

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

let mainWindow;
let deepgramClient;
let microphoneConnection = null;
let speakerConnection = null;
let speakerReady = false;
let speakerSendCount = 0;

// File stream for saving audio chunks
let audioChunks = [];
let audioChunkCount = 0;
let currentAudioFile = null;
let audioStartTime = null;
const CHUNKS_PER_FILE = 150; // ~3 seconds of audio (150 chunks * 20ms = 3s)

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
  const mp3FilePath = path.join(
    __dirname,
    "..",
    "temp_audio",
    `audio_${uniqueId}.mp3`
  );

  // Track file index for sequential display (start at 0)
  const fileIndex = Math.floor(
    (audioChunkCount - audioChunks.length) / CHUNKS_PER_FILE
  );

  // Save raw PCM data
  const rawData = Buffer.concat(audioChunks);
  fs.writeFileSync(rawFilePath, rawData);

  // Convert to MP3 using ffmpeg (if available)
  const ffmpegCmd = `ffmpeg -f s16le -ar 16000 -ac 1 -i "${rawFilePath}" -codec:a libmp3lame -b:a 128k "${mp3FilePath}" -y`;

  exec(ffmpegCmd, async (error, stdout, stderr) => {
    if (error) {
      console.log(
        `⚠️ Could not convert to MP3 (ffmpeg not found?): ${error.message}`
      );
      console.log(`💾 Saved raw audio to: ${rawFilePath}`);
      console.log(
        `📝 To convert manually: ffmpeg -f s16le -ar 16000 -ac 1 -i ${rawFilePath} ${mp3FilePath}`
      );
    } else {
      // MP3 conversion successful
      console.log(
        `💾 Saved MP3: ${path.basename(mp3FilePath)} (${
          audioChunks.length
        } chunks, ${(rawData.length / 32000).toFixed(2)}s)`
      );

      // Transcribe using raw PCM data (before deleting it)
      await transcribeMP3File(mp3FilePath, fileIndex, rawFilePath);

      // Delete raw file after transcription
      try {
        fs.unlinkSync(rawFilePath);
      } catch (e) {
        console.log(
          `⚠️ Could not delete raw file: ${path.basename(rawFilePath)}`
        );
      }
    }
  });

  // Clear chunks for next file
  audioChunks = [];
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
    console.log("🎤 Microphone results event:", JSON.stringify(data, null, 2));
    const transcript = data.channel?.alternatives?.[0]?.transcript;
    if (transcript) {
      const isFinal = data.is_final;
      console.log(`🎤 Microphone transcript (${isFinal ? "FINAL" : "partial"}): "${transcript}"`);
      onTranscript(transcript, isFinal, "microphone");
    } else {
      console.log("🎤 Microphone results but no transcript. Duration:", data.duration, "Speech final:", data.speech_final);
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

  // Handle permission requests from renderer (microphone, camera, etc.)
  mainWindow.webContents.session.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      console.log(`🔐 Permission requested: ${permission}`);
      // Allow microphone and media permissions
      if (permission === "media" || permission === "microphone" || permission === "audio") {
        console.log(`✅ Granting ${permission} permission`);
        callback(true);
      } else {
        callback(true); // Allow other permissions too
      }
    }
  );

  // Handle permission check (for getUserMedia)
  mainWindow.webContents.session.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin, details) => {
      console.log(`🔐 Permission check: ${permission}, mediaType: ${details?.mediaType}`);
      // Allow all media permissions
      if (permission === "media" || details?.mediaType === "audio") {
        return true;
      }
      return true;
    }
  );

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
    if (NativeAudioCapture && process.platform === "darwin") {
      try {
        if (!nativeAudioCapture) {
          let audioSampleCount = 0;

          // Initialize audio saving
          audioChunks = [];
          audioChunkCount = 0;
          audioStartTime = Date.now();
          console.log(`💾 Will save audio as MP3 files with unique names`);

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

            // Send to Deepgram
            if (speakerConnection && speakerReady) {
              const buffer = Buffer.from(
                int16Data.buffer,
                int16Data.byteOffset,
                int16Data.byteLength
              );

              // Save chunk to array
              audioChunks.push(buffer);
              audioChunkCount++;

              // Save as MP3 file every N chunks
              if (audioChunkCount % CHUNKS_PER_FILE === 0) {
                saveAudioChunksAsMP3();
              }

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
    const finalFileIndex = Math.floor(audioChunkCount / CHUNKS_PER_FILE);
    saveAudioChunksAsMP3();
    console.log(`💾 Saved final audio file (${audioChunks.length} chunks)`);
  }

  if (speakerConnection) {
    speakerConnection.finish();
    speakerConnection = null;
    speakerReady = false;
    return { success: true };
  }
  return { success: false, error: "No active speaker connection" };
});

let micSendCount = 0;
ipcMain.handle("send-audio-data", async (event, audioData, source) => {
  try {
    const connection =
      source === "microphone" ? microphoneConnection : speakerConnection;
    if (connection) {
      // Convert ArrayBuffer to Buffer for Node.js
      const buffer = Buffer.from(audioData);
      
      // Log microphone audio being sent
      if (source === "microphone") {
        micSendCount++;
        if (micSendCount <= 5) {
          console.log(`🎤 Sending mic audio chunk ${micSendCount}, size=${buffer.length} bytes`);
        }
      }
      
      connection.send(buffer);
      return { success: true };
    }
    console.log(`⚠️ ${source} connection not ready`);
    return { success: false, error: "Connection not ready" };
  } catch (error) {
    console.error(`❌ Error sending ${source} audio:`, error.message);
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

app.whenReady().then(async () => {
  // Request microphone permission on macOS
  if (process.platform === "darwin") {
    const micStatus = systemPreferences.getMediaAccessStatus("microphone");
    console.log(`🎤 Microphone permission status: ${micStatus}`);
    
    if (micStatus !== "granted") {
      console.log("🎤 Requesting microphone permission...");
      const granted = await systemPreferences.askForMediaAccess("microphone");
      console.log(`🎤 Microphone permission ${granted ? "granted" : "denied"}`);
    }
  }
  
  createWindow();

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
