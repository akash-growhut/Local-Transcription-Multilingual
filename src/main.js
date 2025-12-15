const { app, BrowserWindow, ipcMain, desktopCapturer } = require("electron");
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
let microphoneSampleRate = 16000; // Default, will be updated when microphone starts

// File stream for saving audio chunks - SPEAKER
let audioChunks = [];
let audioChunkCount = 0;
let currentAudioFile = null;
let audioStartTime = null;
// Speaker uses native audio: 320 float32 samples at 16kHz = 20ms per chunk
// For 1.5 seconds: 1500ms / 20ms = 75 chunks
const SPEAKER_CHUNKS_PER_FILE = 75; // ~1.5 seconds of audio (75 chunks * 20ms = 1.5s)

// File stream for saving audio chunks - MICROPHONE
let microphoneAudioChunks = [];
let microphoneAudioChunkCount = 0;
let microphoneAudioStartTime = null;
// Microphone uses Web Audio ScriptProcessor: 4096 samples at native rate (usually 48kHz)
// At 48kHz: 4096 samples = 85.33ms per chunk
// For ~1.5 seconds: 1500ms / 85.33ms = ~18 chunks
// At 16kHz: 4096 samples = 256ms per chunk
// For ~1.5 seconds: 1500ms / 256ms = ~6 chunks
// We'll adjust dynamically based on actual sample rate
const MICROPHONE_CHUNKS_PER_FILE = 20; // Will be recalculated based on actual sample rate

// Function to transcribe audio file with Deepgram using raw PCM data (SPEAKER)
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

    // Check if audio buffer has actual data before sending to Deepgram
    if (pcmBuffer.length === 0) {
      console.log(
        `⏭️ Skipping transcription: ${path.basename(
          mp3FilePath
        )} is empty (0 bytes)`
      );
      return;
    }

    // Check if audio has non-zero samples
    const int16Array = new Int16Array(
      pcmBuffer.buffer,
      pcmBuffer.byteOffset,
      pcmBuffer.length / 2
    );
    let hasNonZero = false;
    let sumSquares = 0;

    for (let i = 0; i < int16Array.length; i++) {
      const sample = int16Array[i];
      if (sample !== 0) hasNonZero = true;
      sumSquares += sample * sample;
    }

    const rms = Math.sqrt(sumSquares / int16Array.length) || 0;
    const RMS_THRESHOLD = 10; // Same threshold as live audio

    if (!hasNonZero || rms <= RMS_THRESHOLD) {
      console.log(
        `⏭️ Skipping transcription: ${path.basename(
          mp3FilePath
        )} contains only silence (rms=${rms.toFixed(
          2
        )}, hasNonZero=${hasNonZero})`
      );
      return;
    }

    console.log(
      `✅ Audio validation passed: rms=${rms.toFixed(
        2
      )}, hasNonZero=${hasNonZero}, size=${pcmBuffer.length} bytes`
    );

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
        const transcriptData = {
          text: transcript,
          isFinal: true,
          source: "speaker",
          fileIndex: fileIndex,
          timestamp: Date.now(),
        };
        console.log(`📤 Sending transcript to renderer:`, transcriptData);
        mainWindow.webContents.send("transcript", transcriptData);
        console.log(`✅ Transcript sent to renderer`);
      } else {
        console.log(`❌ Cannot send transcript: mainWindow not available`);
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

// Function to transcribe audio file with Deepgram using MP3 file (MICROPHONE)
async function transcribeMicrophoneMP3File(
  mp3FilePath,
  fileIndex,
  rawFilePath
) {
  if (!deepgramClient) {
    console.log(
      `⚠️ [Microphone] Deepgram client not initialized, skipping transcription for ${path.basename(
        mp3FilePath
      )}`
    );
    return;
  }

  try {
    console.log(
      `🎤 [Microphone] Transcribing audio file ${fileIndex}: ${path.basename(
        mp3FilePath
      )}`
    );

    // Verify MP3 file exists
    if (!fs.existsSync(mp3FilePath)) {
      console.error(`❌ [Microphone] MP3 file does not exist: ${mp3FilePath}`);
      return;
    }

    // Read MP3 file as binary
    const mp3Buffer = fs.readFileSync(mp3FilePath);

    console.log(`📊 [Microphone] MP3 file size: ${mp3Buffer.length} bytes`);

    // Check if MP3 file has actual data before sending to Deepgram
    if (mp3Buffer.length === 0) {
      console.log(
        `⏭️ [Microphone] Skipping transcription: ${path.basename(
          mp3FilePath
        )} is empty (0 bytes)`
      );
      return;
    }

    // If raw file exists, validate it has non-zero audio data
    if (rawFilePath && fs.existsSync(rawFilePath)) {
      const rawBuffer = fs.readFileSync(rawFilePath);

      if (rawBuffer.length === 0) {
        console.log(
          `⏭️ [Microphone] Skipping transcription: ${path.basename(
            rawFilePath
          )} is empty (0 bytes)`
        );
        return;
      }

      // Check if audio has non-zero samples
      const int16Array = new Int16Array(
        rawBuffer.buffer,
        rawBuffer.byteOffset,
        rawBuffer.length / 2
      );
      let hasNonZero = false;
      let sumSquares = 0;

      for (let i = 0; i < int16Array.length; i++) {
        const sample = int16Array[i];
        if (sample !== 0) hasNonZero = true;
        sumSquares += sample * sample;
      }

      const rms = Math.sqrt(sumSquares / int16Array.length) || 0;
      const RMS_THRESHOLD = 10; // Same threshold as live audio

      if (!hasNonZero || rms <= RMS_THRESHOLD) {
        console.log(
          `⏭️ [Microphone] Skipping transcription: ${path.basename(
            mp3FilePath
          )} contains only silence (rms=${rms.toFixed(
            2
          )}, hasNonZero=${hasNonZero})`
        );
        return;
      }

      console.log(
        `✅ [Microphone] Audio validation passed: rms=${rms.toFixed(
          2
        )}, hasNonZero=${hasNonZero}, size=${rawBuffer.length} bytes`
      );
    }

    // Get API key from the client
    const apiKey = deepgramClient.key;
    if (!apiKey) {
      console.error(`❌ [Microphone] Deepgram API key not found`);
      return;
    }

    // Use Deepgram REST API - send MP3 directly with proper content type
    const options = {
      hostname: "api.deepgram.com",
      path: `/v1/listen?model=nova-3&language=multi&smart_format=true&punctuate=true`,
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "audio/mp3",
        "Content-Length": mp3Buffer.length,
      },
    };

    console.log(`📡 [Microphone] Sending MP3 directly to Deepgram API...`);

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

      // Write MP3 buffer directly to request
      req.write(mp3Buffer);
      req.end();
    });

    console.log(
      `📥 [Microphone] Deepgram response status: ${response.statusCode}`
    );

    if (response.statusCode !== 200) {
      console.error(
        `❌ [Microphone] Deepgram API error (${response.statusCode}):`,
        JSON.stringify(response.data, null, 2)
      );
      return;
    }

    // Log full response for debugging
    console.log(
      `📝 [Microphone] Full Deepgram response:`,
      JSON.stringify(response.data, null, 2)
    );

    const transcript =
      response.data?.results?.channels?.[0]?.alternatives?.[0]?.transcript;

    const confidence =
      response.data?.results?.channels?.[0]?.alternatives?.[0]?.confidence;
    const words =
      response.data?.results?.channels?.[0]?.alternatives?.[0]?.words;

    console.log(`📊 [Microphone] Transcript details:`, {
      hasTranscript: !!transcript,
      transcriptLength: transcript?.length || 0,
      confidence: confidence,
      wordCount: words?.length || 0,
    });

    if (transcript) {
      console.log(`💬 [Microphone] Transcript ${fileIndex}: "${transcript}"`);

      // Send transcript to renderer for display (in series order)
      if (mainWindow && !mainWindow.isDestroyed()) {
        const transcriptData = {
          text: transcript,
          isFinal: true,
          source: "microphone",
          fileIndex: fileIndex,
          timestamp: Date.now(),
        };
        console.log(
          `📤 [Microphone] Sending transcript to renderer:`,
          transcriptData
        );
        mainWindow.webContents.send("transcript", transcriptData);
        console.log(`✅ [Microphone] Transcript sent to renderer`);
      } else {
        console.log(
          `❌ [Microphone] Cannot send transcript: mainWindow not available`
        );
      }
    } else {
      console.log(
        `⚠️ [Microphone] No transcript found in Deepgram result for ${path.basename(
          mp3FilePath
        )}`
      );
      console.log(`📊 [Microphone] Response structure:`, {
        hasResults: !!response.data?.results,
        hasChannels: !!response.data?.results?.channels,
        channelCount: response.data?.results?.channels?.length || 0,
        hasAlternatives: !!response.data?.results?.channels?.[0]?.alternatives,
        alternativeCount:
          response.data?.results?.channels?.[0]?.alternatives?.length || 0,
      });
    }
  } catch (error) {
    console.error(
      `❌ [Microphone] Error transcribing ${path.basename(mp3FilePath)}:`,
      error.message,
      error.stack
    );
  }
}

// Function to save audio chunks as MP3 (SPEAKER)
function saveAudioChunksAsMP3() {
  if (audioChunks.length === 0) return;

  const timestamp = Date.now();
  const uniqueId = `${timestamp}_${Math.random().toString(36).substr(2, 9)}`;
  const rawFilePath = path.join(
    __dirname,
    "..",
    "temp_audio",
    `speaker_audio_${uniqueId}.raw`
  );
  const mp3FilePath = path.join(
    __dirname,
    "..",
    "temp_audio",
    `speaker_audio_${uniqueId}.mp3`
  );

  // Track file index for sequential display (start at 0)
  const fileIndex = Math.floor(
    (audioChunkCount - audioChunks.length) / SPEAKER_CHUNKS_PER_FILE
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

      // Delete MP3 file after transcription
      try {
        fs.unlinkSync(mp3FilePath);
      } catch (e) {
        console.log(
          `⚠️ Could not delete MP3 file: ${path.basename(mp3FilePath)}`
        );
      }
    }
  });

  // Clear chunks for next file
  audioChunks = [];
}

// Function to save audio chunks as MP3 (MICROPHONE)
function saveMicrophoneAudioChunksAsMP3() {
  if (microphoneAudioChunks.length === 0) return;

  const timestamp = Date.now();
  const uniqueId = `${timestamp}_${Math.random().toString(36).substr(2, 9)}`;
  const rawFilePath48k = path.join(
    __dirname,
    "..",
    "temp_audio",
    `microphone_audio_${uniqueId}_48k.raw`
  );
  const rawFilePath = path.join(
    __dirname,
    "..",
    "temp_audio",
    `microphone_audio_${uniqueId}.raw`
  );
  const mp3FilePath = path.join(
    __dirname,
    "..",
    "temp_audio",
    `microphone_audio_${uniqueId}.mp3`
  );

  // Track file index for sequential display (start at 0)
  const fileIndex = Math.floor(
    (microphoneAudioChunkCount - microphoneAudioChunks.length) /
      MICROPHONE_CHUNKS_PER_FILE
  );

  // Save raw PCM data at original sample rate (48kHz)
  const rawData = Buffer.concat(microphoneAudioChunks);
  const chunkCount = microphoneAudioChunks.length; // Store before clearing
  fs.writeFileSync(rawFilePath48k, rawData);

  console.log(
    `💾 [Microphone] Saved 48kHz RAW: ${path.basename(
      rawFilePath48k
    )} (${chunkCount} chunks, ${(
      rawData.length /
      (microphoneSampleRate * 2)
    ).toFixed(2)}s)`
  );

  // Resample from 48kHz to 16kHz using ffmpeg
  const resampleCmd = `ffmpeg -f s16le -ar ${microphoneSampleRate} -ac 1 -i "${rawFilePath48k}" -f s16le -ar 16000 -ac 1 "${rawFilePath}" -y`;

  exec(resampleCmd, async (error, stdout, stderr) => {
    if (error) {
      console.log(`⚠️ [Microphone] Could not resample audio: ${error.message}`);
      // Delete temp file
      try {
        fs.unlinkSync(rawFilePath48k);
      } catch (e) {}
      return;
    }

    // Resampling successful
    const stats16k = fs.statSync(rawFilePath);
    console.log(
      `✅ [Microphone] Resampled to 16kHz: ${path.basename(rawFilePath)} (${
        stats16k.size
      } bytes, ${(stats16k.size / 32000).toFixed(2)}s)`
    );

    // Apply volume normalization to boost quiet audio
    const normalizedPath = path.join(
      __dirname,
      "..",
      "temp_audio",
      `microphone_audio_${uniqueId}_normalized.raw`
    );

    // Normalize audio to -3dB peak (loud enough for Deepgram)
    const normalizeCmd = `ffmpeg -f s16le -ar 16000 -ac 1 -i "${rawFilePath}" -filter:a "loudnorm=I=-16:TP=-1.5:LRA=11" -f s16le -ar 16000 -ac 1 "${normalizedPath}" -y`;

    exec(normalizeCmd, async (error2, stdout2, stderr2) => {
      if (error2) {
        console.log(
          `⚠️ [Microphone] Could not normalize audio, using original: ${error2.message}`
        );
        // Continue with unnormalized audio
        await convertToMP3AndTranscribe(
          rawFilePath,
          mp3FilePath,
          fileIndex,
          rawFilePath48k
        );
      } else {
        // Check normalized audio levels
        const statsNorm = fs.statSync(normalizedPath);
        console.log(
          `✅ [Microphone] Normalized audio: ${path.basename(
            normalizedPath
          )} (${statsNorm.size} bytes) - boosted to proper levels`
        );

        // Replace original with normalized version
        fs.renameSync(normalizedPath, rawFilePath);

        await convertToMP3AndTranscribe(
          rawFilePath,
          mp3FilePath,
          fileIndex,
          rawFilePath48k
        );
      }
    });
  });
}

// Helper function to convert to MP3 and transcribe
const convertToMP3AndTranscribe = async (
  rawFilePath,
  mp3FilePath,
  fileIndex,
  rawFilePath48k
) => {
  // Convert 16kHz raw to MP3 using ffmpeg
  const ffmpegCmd = `ffmpeg -f s16le -ar 16000 -ac 1 -i "${rawFilePath}" -codec:a libmp3lame -b:a 128k "${mp3FilePath}" -y`;

  exec(ffmpegCmd, async (error, stdout, stderr) => {
    if (error) {
      console.log(
        `⚠️ [Microphone] Could not convert to MP3 (ffmpeg not found?): ${error.message}`
      );
      console.log(`💾 [Microphone] Saved raw audio to: ${rawFilePath}`);
    } else {
      // MP3 conversion successful - wait a bit for file to be fully written
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify MP3 file exists and has content
      if (!fs.existsSync(mp3FilePath)) {
        console.error(
          `❌ [Microphone] MP3 file was not created: ${mp3FilePath}`
        );
        return;
      }

      const mp3Stats = fs.statSync(mp3FilePath);
      console.log(
        `💾 [Microphone] Saved MP3: ${path.basename(mp3FilePath)} (${
          mp3Stats.size
        } bytes, 16kHz)`
      );

      // Transcribe using 16kHz RAW PCM file
      await transcribeMicrophoneMP3File(mp3FilePath, fileIndex, rawFilePath);

      // Delete temp 48kHz file
      try {
        fs.unlinkSync(rawFilePath48k);
      } catch (e) {
        console.log(
          `⚠️ [Microphone] Could not delete 48kHz file: ${path.basename(
            rawFilePath48k
          )}`
        );
      }

      // Delete temp 16kHz file
      try {
        fs.unlinkSync(rawFilePath);
      } catch (e) {
        console.log(
          `⚠️ [Microphone] Could not delete 16kHz file: ${path.basename(
            rawFilePath
          )}`
        );
      }

      // Delete temp MP3 file
      try {
        fs.unlinkSync(mp3FilePath);
      } catch (e) {
        console.log(
          `⚠️ [Microphone] Could not delete MP3 file: ${path.basename(
            mp3FilePath
          )}`
        );
      }
    }
  });

  // Clear chunks for next file
  microphoneAudioChunks = [];
};

// Initialize Deepgram client
function initializeDeepgram(apiKey) {
  if (!apiKey) {
    console.error("Deepgram API key is required");
    return null;
  }
  return createClient(apiKey);
}

// Create Deepgram connection for microphone
function createMicrophoneConnection(apiKey, onTranscript, sampleRate = 16000) {
  if (microphoneConnection) {
    microphoneConnection.finish();
  }

  const client = initializeDeepgram(apiKey);
  if (!client) return null;

  console.log(
    `📡 Creating microphone Deepgram connection with config: linear16, ${sampleRate}Hz, mono`
  );

  const connection = client.listen.live({
    model: "nova-3",
    language: "multi",
    smart_format: true,
    interim_results: true,
    endpointing: 300,
    utterance_end_ms: 1000,
    encoding: "linear16",
    sample_rate: sampleRate,
    channels: 1,
  });

  connection.on("open", () => {
    console.log(`Microphone Deepgram connection opened (${sampleRate}Hz)`);
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
    // Initialize Deepgram client for file transcription
    if (!deepgramClient) {
      deepgramClient = initializeDeepgram(apiKey);
    }

    // Initialize microphone audio saving
    microphoneAudioChunks = [];
    microphoneAudioChunkCount = 0;
    microphoneAudioStartTime = Date.now();
    console.log(
      `💾 [Microphone] Will save audio as MP3 files with unique names`
    );

    // We're using file-based transcription, not live streaming
    // Just notify UI that we're connected and ready
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("microphone-connected", true);
    }

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

        // Initialize audio saving
        audioChunks = [];
        audioChunkCount = 0;
        audioStartTime = Date.now();
        console.log(`💾 Will save audio as MP3 files with unique names`);

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

            // Check if audio has actual data before saving or sending
            // Only process if there are non-zero samples and RMS is above threshold
            const RMS_THRESHOLD = 10; // Minimum RMS to consider as actual audio
            const hasAudioData = hasNonZero && rms > RMS_THRESHOLD;

            if (hasAudioData) {
              // Save chunk to array only if it has audio data
              audioChunks.push(buffer);
              audioChunkCount++;

              // Save as MP3 file every N chunks
              if (audioChunkCount % SPEAKER_CHUNKS_PER_FILE === 0) {
                saveAudioChunksAsMP3();
              }

              // Send to live Deepgram connection
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
              // Log occasionally to show we're skipping empty/silent audio
              if (audioSampleCount % 100 === 0) {
                console.log(
                  `⏭️ Skipping empty/silent audio (rms=${rms.toFixed(
                    2
                  )}, hasNonZero=${hasNonZero}) - not saving or sending`
                );
              }
            }
          } else {
            if (audioSampleCount === 1) {
              console.log("⚠️ Speaker connection not ready or not open yet");
            }
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
  // Save any remaining microphone audio chunks
  if (microphoneAudioChunks.length > 0) {
    const finalFileIndex = Math.floor(
      microphoneAudioChunkCount / MICROPHONE_CHUNKS_PER_FILE
    );
    saveMicrophoneAudioChunksAsMP3();
    console.log(
      `💾 [Microphone] Saved final audio file (${microphoneAudioChunks.length} chunks)`
    );
  }

  // Notify UI that we're disconnected
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("microphone-connected", false);
  }

  // Close live connection if it exists (though we're not using it)
  if (microphoneConnection) {
    microphoneConnection.finish();
    microphoneConnection = null;
  }

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

  // Save any remaining audio chunks
  if (audioChunks.length > 0) {
    const finalFileIndex = Math.floor(
      audioChunkCount / SPEAKER_CHUNKS_PER_FILE
    );
    saveAudioChunksAsMP3();
    console.log(`💾 Saved final audio file (${audioChunks.length} chunks)`);
  }

  if (speakerConnection) {
    speakerConnection.finish();
    speakerConnection = null;
    speakerReady = false;
    console.log("✅ Speaker Deepgram connection closed");
    return { success: true };
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

      // Handle speaker audio (uses live connection)
      if (source === "speaker") {
        if (speakerConnection) {
          speakerConnection.send(buffer);
        }
        return { success: true };
      }

      // Handle microphone audio (uses file-based transcription)
      if (source === "microphone") {
        // Update sample rate if provided
        if (sampleRate && sampleRate !== microphoneSampleRate) {
          console.log(`📊 [Microphone] Sample rate detected: ${sampleRate} Hz`);
          microphoneSampleRate = sampleRate;
        }

        // Analyze audio quality first to determine if it has data
        const int16View = new Int16Array(
          buffer.buffer,
          buffer.byteOffset,
          buffer.length / 2
        );
        let sum = 0;
        let peak = 0;
        let nonZeroCount = 0;
        let sumSquares = 0;

        for (let i = 0; i < int16View.length; i++) {
          const abs = Math.abs(int16View[i]);
          const val = int16View[i];
          sum += abs;
          sumSquares += val * val;
          if (abs > peak) peak = abs;
          if (abs > 0) nonZeroCount++;
        }

        const avg = sum / int16View.length;
        const rms = Math.sqrt(sumSquares / int16View.length);
        const hasNonZero = nonZeroCount > 0;

        // Check if audio has actual data before saving
        const RMS_THRESHOLD = 10; // Same threshold as speaker audio
        const hasAudioData = hasNonZero && rms > RMS_THRESHOLD;

        if (hasAudioData) {
          // Save microphone audio chunks to file only if it has data
          microphoneAudioChunks.push(buffer);
          microphoneAudioChunkCount++;

          // Log first few chunks for debugging with audio quality info
          if (microphoneAudioChunkCount <= 3) {
            console.log(`📊 [Microphone] Chunk ${microphoneAudioChunkCount}:`, {
              bytes: buffer.length,
              samples: int16View.length,
              sampleRate: sampleRate || microphoneSampleRate,
              avg: avg.toFixed(2),
              rms: rms.toFixed(2),
              peak: peak,
              nonZero: nonZeroCount,
              percentNonZero:
                ((nonZeroCount / int16View.length) * 100).toFixed(2) + "%",
            });

            // Warn if audio level is too low
            if (peak < 1000) {
              console.warn(
                `⚠️ [Microphone] WARNING: Audio level is very low (peak: ${peak})!`
              );
              console.warn(
                `   For clear transcription, peak should be 5000-15000.`
              );
              console.warn(
                `   Please check: 1) Correct microphone selected, 2) Microphone volume in System Preferences`
              );

              // Send warning to renderer
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send(
                  "microphone-error",
                  `⚠️ Microphone level too low (peak: ${peak}). Please increase microphone volume in System Preferences > Sound > Input.`
                );
              }
            } else if (peak >= 1000 && peak < 5000) {
              console.log(
                `📢 [Microphone] Audio level is low but usable (peak: ${peak}). For best results, increase microphone volume.`
              );
            } else {
              console.log(
                `✅ [Microphone] Audio level is good (peak: ${peak})`
              );
            }
          }

          // Save as MP3 file every N chunks
          if (microphoneAudioChunkCount % MICROPHONE_CHUNKS_PER_FILE === 0) {
            console.log(
              `📦 [Microphone] Reached ${microphoneAudioChunkCount} chunks, saving to file...`
            );
            saveMicrophoneAudioChunksAsMP3();
          }
        } else {
          // Log occasionally to show we're skipping empty/silent audio
          if (microphoneAudioChunkCount % 100 === 0) {
            console.log(
              `⏭️ [Microphone] Skipping empty/silent audio (rms=${rms.toFixed(
                2
              )}, hasNonZero=${hasNonZero}) - not saving`
            );
          }
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
