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
let microphoneSampleRate = 48000; // Default, will be updated when microphone starts
let speakerAudioBuffer = []; // Buffer for audio chunks when connection isn't ready
let speakerAudioFileStream = null; // File stream for recording speaker audio
let speakerAudioFileWritten = false; // Flag to track if recording is complete
let speakerKeepAliveInterval = null; // Interval for sending periodic silence keepalive
let speakerMp3Stream = null; // FFmpeg pipe for real-time MP3 encoding
let speakerMp3Path = null; // Path to the MP3 file being written

// Helper function to finalize speaker audio recording
function finalizeSpeakerRecording() {
  if (!speakerAudioFileStream || speakerAudioFileWritten) {
    return;
  }

  try {
    speakerAudioFileWritten = true;
    const stream = speakerAudioFileStream;
    const wavPath = stream.wavPath;
    const mp3Path = stream.mp3Path;
    const dataSize = stream.dataSize || 0;

    stream.end(() => {
      try {
        if (dataSize > 0) {
          const totalFileSize = dataSize + 44;
          const fileData = fs.readFileSync(wavPath);
          fileData.writeUInt32LE(totalFileSize - 8, 4); // File size - 8
          fileData.writeUInt32LE(dataSize, 40); // Data chunk size
          fs.writeFileSync(wavPath, fileData);

          const duration = dataSize / (48000 * 2); // 48kHz, 16-bit (2 bytes), mono
          console.log(`✅ Speaker audio recording saved: ${wavPath}`);
          console.log(
            `   Duration: ${duration.toFixed(2)}s, Size: ${(
              dataSize / 1024
            ).toFixed(2)} KB`
          );

          // Try to convert to MP3 using ffmpeg if available
          exec(`which ffmpeg`, (error) => {
            if (!error) {
              exec(
                `ffmpeg -i "${wavPath}" -acodec libmp3lame -ab 192k "${mp3Path}" -y`,
                (convertError) => {
                  if (!convertError) {
                    console.log(`✅ MP3 conversion complete: ${mp3Path}`);
                    // Optionally remove WAV file to save space
                    // fs.unlinkSync(wavPath);
                  } else {
                    console.log(
                      `⚠️ MP3 conversion failed: ${convertError.message}`
                    );
                    console.log(`   WAV file is available at: ${wavPath}`);
                  }
                }
              );
            } else {
              console.log(`⚠️ ffmpeg not found. WAV file saved: ${wavPath}`);
              console.log(`   To convert to MP3, install ffmpeg and run:`);
              console.log(`   ffmpeg -i "${wavPath}" "${mp3Path}"`);
            }
          });
        } else {
          console.log(
            `⚠️ No audio data recorded, removing empty file: ${wavPath}`
          );
          try {
            fs.unlinkSync(wavPath);
          } catch (e) {
            // Ignore errors
          }
        }
      } catch (e) {
        console.error(`❌ Failed to finalize speaker WAV: ${e.message}`);
      }
    });
  } catch (e) {
    console.error(`❌ Error finalizing speaker recording: ${e.message}`);
  }

  speakerAudioFileStream = null;
}

// Helper function to convert Float32 to Int16 PCM for Deepgram
function float32ToInt16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

// Helper function to downmix stereo to mono
// HAL delivers interleaved stereo (L, R, L, R, ...), Deepgram expects mono
function downmixStereoToMono(float32Stereo) {
  const monoLength = Math.floor(float32Stereo.length / 2);
  const mono = new Float32Array(monoLength);

  for (let i = 0, j = 0; i < monoLength; i++, j += 2) {
    // Average L + R channels
    mono[i] = (float32Stereo[j] + float32Stereo[j + 1]) * 0.5;
  }

  return mono;
}

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

      // CRITICAL: Flush buffered audio immediately when WebSocket opens
      // HAL may have started before Deepgram was ready, so audio was buffered
      // Convert Float32 buffers to Int16 before sending (Deepgram expects Int16 PCM)
      if (speakerAudioBuffer.length > 0) {
        console.log(
          `📤 Flushing ${speakerAudioBuffer.length} buffered audio chunks on open`
        );
        speakerAudioBuffer.forEach((bufferedFloat32) => {
          if (speakerConnection && speakerConnection.isReady()) {
            const int16Data = float32ToInt16(bufferedFloat32);
            speakerConnection.send(int16Data);
          }
        });
        speakerAudioBuffer = [];
      }

      // Send 100ms of silence to prime Deepgram and prevent early silence timeout
      // This is a known Deepgram WebSocket quirk - it expects audio almost immediately
      // Must be Int16, not Float32 (Deepgram expects Linear16 PCM)
      const silence16 = new Int16Array(4800); // 4800 samples = 100ms at 48kHz, already zero-filled
      if (speakerConnection && speakerConnection.isReady()) {
        speakerConnection.send(silence16);
        console.log("🔇 Sent silence keep-alive to Deepgram (100ms Int16)");
      }

      // Start periodic keepalive to prevent Deepgram timeout
      // Send 20ms of silence every second to keep connection alive
      // This is required because Deepgram expects continuous audio, not bursts
      if (speakerKeepAliveInterval) {
        clearInterval(speakerKeepAliveInterval);
      }
      speakerKeepAliveInterval = setInterval(() => {
        if (speakerConnection && speakerConnection.isReady()) {
          const keepAliveSilence = new Int16Array(960); // 960 samples = 20ms at 48kHz
          speakerConnection.send(keepAliveSilence);
        }
      }, 1000); // Every 1 second
      console.log("🔄 Started periodic keepalive (20ms silence every 1s)");

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("speaker-connected", true);
      }
    },
    onClose: (code, reason) => {
      console.log("🔌 Speaker Deepgram WebSocket closed", {
        code: code || "unknown",
        reason: reason || "unknown",
      });
      // Stop keepalive interval
      if (speakerKeepAliveInterval) {
        clearInterval(speakerKeepAliveInterval);
        speakerKeepAliveInterval = null;
      }
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

ipcMain.handle("start-speaker-capture", async (event, apiKey, options = {}) => {
  try {
    // Debug: Log received options
    console.log(
      "🧪 start-speaker-capture received options:",
      JSON.stringify(options)
    );

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

        // Separate counters for HAL frames and Deepgram sends
        // This ensures accurate logging even when Deepgram opens after HAL starts
        let halFrameCount = 0;
        let deepgramFrameCount = 0;
        const SPEAKER_RECORDING_ENABLED = true; // Set to false to disable file recording
        const SPEAKER_RECORDING_DURATION = 10; // Record first 10 seconds for testing

        // Reset file recording state for new capture session
        // Finalize any existing MP3 recording before starting a new one
        if (speakerMp3Stream && !speakerMp3Stream.destroyed) {
          try {
            speakerMp3Stream.end();
          } catch (e) {
            // Ignore errors
          }
          speakerMp3Stream = null;
        }
        speakerAudioFileWritten = false;
        speakerMp3Path = null;

        // Determine capture mode (default: ScreenCaptureKit, experimental: HAL)
        const captureMode = options?.mode || "screencapturekit";
        console.log(
          `🧪 Determined capture mode: "${captureMode}" from options:`,
          options
        );

        if (captureMode === "hal") {
          console.log(
            "🎯 Using HAL capture mode (experimental, Granola-style)"
          );
        } else {
          console.log(
            "📺 Using ScreenCaptureKit mode (default, App Store safe)"
          );
        }

        // CRITICAL: Pass options to constructor, not start()
        // This ensures HAL mode is set BEFORE any ScreenCaptureKit initialization
        const captureOptions = { mode: captureMode };
        console.log(
          "🎙️ Creating new native audio capture instance with options:",
          captureOptions
        );
        // Log callback creation
        console.log(`🔧 Creating NativeAudioCapture with callback function...`);

        nativeAudioCapture = new NativeAudioCapture((audioBuffer) => {
          try {
            // Debug: Log when callback is invoked (first 5 times)
            if (halFrameCount < 5) {
              console.log(
                `🎵 [JS] Audio callback INVOKED #${halFrameCount}, buffer: ${
                  audioBuffer
                    ? `${
                        audioBuffer.length || audioBuffer.byteLength
                      } bytes, type=${audioBuffer.constructor.name}`
                    : "null/undefined"
                }`
              );
            }

            if (!audioBuffer) {
              console.warn(
                `⚠️ [JS] Audio callback received null/undefined buffer`
              );
              return;
            }

            // Log buffer details for first few calls
            if (halFrameCount < 3) {
              console.log(
                `📦 [JS] Buffer details: length=${
                  audioBuffer.length
                }, byteLength=${audioBuffer.byteLength}, byteOffset=${
                  audioBuffer.byteOffset || 0
                }`
              );
            }

            // audioBuffer is a Node Buffer of float32 PCM from native
            // Reinterpret bytes as Float32Array without copying per-element
            const byteOffset = audioBuffer.byteOffset || 0;
            const byteLength =
              audioBuffer.byteLength - (audioBuffer.byteLength % 4);

            // HAL delivers interleaved stereo (L, R, L, R, ...)
            const stereoData = new Float32Array(
              audioBuffer.buffer,
              byteOffset,
              byteLength / 4
            );

            if (halFrameCount < 3) {
              console.log(
                `🔄 [JS] Processing: stereoData.length=${stereoData.length}, byteOffset=${byteOffset}, byteLength=${byteLength}`
              );
            }

            // CRITICAL: Downmix stereo → mono before processing
            // Deepgram expects mono PCM (channels=1), but HAL gives us stereo
            const floatData = downmixStereoToMono(stereoData);

            if (halFrameCount < 3) {
              console.log(
                `🔄 [JS] After downmix: floatData.length=${floatData.length}`
              );
            }

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

            // Calculate average absolute value for audio presence detection
            let sumAbs = 0;
            for (let i = 0; i < normalizedData.length; i++) {
              sumAbs += Math.abs(normalizedData[i]);
            }
            const avgAbs = sumAbs / normalizedData.length;

            // Log first few HAL frames for debugging
            if (halFrameCount < 3) {
              console.log(
                `📊 [JS] HAL frame ${halFrameCount}: ${
                  normalizedData.length
                } samples, original_rms≈${rms.toFixed(
                  4
                )}, normalized_rms≈${normalizedRms.toFixed(
                  4
                )}, peak≈${peak.toFixed(4)}, gain≈${maxSafeGain.toFixed(2)}x`
              );
            } else if (halFrameCount === 3) {
              // Log once that we're receiving audio but not logging every frame
              console.log(
                `📊 [JS] HAL audio flowing (frame logging disabled after 3 frames)`
              );
            }

            // Convert Float32 to Int16 PCM (needed for both MP3 and Deepgram)
            const int16Data = float32ToInt16(normalizedData);

            if (halFrameCount < 3) {
              console.log(
                `🔄 [JS] Converted to Int16: int16Data.length=${int16Data.length}`
              );
            }

            // Save to MP3 BEFORE sending to Deepgram
            // Debug: Log MP3 recording state
            if (halFrameCount <= 5) {
              console.log(
                `🔍 [JS] MP3 Recording Check: enabled=${SPEAKER_RECORDING_ENABLED}, written=${speakerAudioFileWritten}, stream=${!!speakerMp3Stream}, stream.destroyed=${
                  speakerMp3Stream?.destroyed || "N/A"
                }`
              );
            }

            if (SPEAKER_RECORDING_ENABLED && !speakerAudioFileWritten) {
              if (halFrameCount <= 5) {
                console.log(
                  `🔍 [JS] MP3 Recording: enabled=${SPEAKER_RECORDING_ENABLED}, written=${speakerAudioFileWritten}, stream=${!!speakerMp3Stream}`
                );
              }
              if (!speakerMp3Stream) {
                console.log(`🎬 [JS] Initializing MP3 recording stream...`);
                // Initialize MP3 recording stream synchronously
                // We'll check ffmpeg availability but proceed anyway (will fail gracefully)
                const timestamp = new Date()
                  .toISOString()
                  .replace(/[:.]/g, "-");
                speakerMp3Path = path.join(
                  __dirname,
                  "..",
                  "temp_audio",
                  `speaker-hal-test-${timestamp}.mp3`
                );

                console.log(`📁 MP3 file path: ${speakerMp3Path}`);

                // Ensure temp_audio directory exists
                const tempAudioDir = path.join(__dirname, "..", "temp_audio");
                if (!fs.existsSync(tempAudioDir)) {
                  fs.mkdirSync(tempAudioDir, { recursive: true });
                  console.log(
                    `📁 Created temp_audio directory: ${tempAudioDir}`
                  );
                }

                // Start ffmpeg process to encode MP3 in real-time
                // Input: raw PCM (s16le, 48kHz, mono)
                // Output: MP3 file
                // Note: Using -loglevel error to suppress normal ffmpeg output
                const ffmpegCommand = `ffmpeg -loglevel error -f s16le -ar 48000 -ac 1 -i pipe:0 -acodec libmp3lame -ab 192k "${speakerMp3Path}" -y`;
                console.log(
                  `🎬 Starting ffmpeg: ${ffmpegCommand.substring(0, 80)}...`
                );

                const ffmpegProcess = exec(
                  ffmpegCommand,
                  (error, stdout, stderr) => {
                    // This callback fires when ffmpeg process exits
                    if (error) {
                      console.error(
                        `❌ FFmpeg MP3 encoding error: ${error.message}`
                      );
                      if (error.code) {
                        console.error(`   Exit code: ${error.code}`);
                      }
                      if (stderr) {
                        console.error(
                          `   FFmpeg stderr: ${stderr.substring(0, 500)}`
                        );
                      }
                    } else {
                      // Process completed successfully
                      console.log(`✅ FFmpeg MP3 encoding process completed`);
                      // Verify file exists
                      setTimeout(() => {
                        if (fs.existsSync(speakerMp3Path)) {
                          const stats = fs.statSync(speakerMp3Path);
                          console.log(
                            `   MP3 file verified: ${(
                              stats.size / 1024
                            ).toFixed(2)} KB`
                          );
                        } else {
                          console.warn(
                            `⚠️ MP3 file not found at: ${speakerMp3Path}`
                          );
                        }
                      }, 100);
                    }
                  }
                );

                // Capture stderr for debugging (even with -loglevel error, some messages may appear)
                if (ffmpegProcess.stderr) {
                  let stderrBuffer = "";
                  ffmpegProcess.stderr.on("data", (data) => {
                    stderrBuffer += data.toString();
                    // Log errors immediately
                    const str = data.toString();
                    if (
                      str.includes("error") ||
                      str.includes("Error") ||
                      str.includes("No such file") ||
                      str.includes("not found")
                    ) {
                      console.error(
                        `   FFmpeg stderr: ${str.trim().substring(0, 300)}`
                      );
                    }
                  });
                  ffmpegProcess.stderr.on("end", () => {
                    if (stderrBuffer.trim()) {
                      // Log any remaining stderr at end
                      console.log(
                        `   FFmpeg stderr (final): ${stderrBuffer
                          .trim()
                          .substring(0, 200)}`
                      );
                    }
                  });
                }

                // Handle process spawn errors (ffmpeg not found, etc.)
                ffmpegProcess.on("error", (error) => {
                  console.error(
                    `❌ FFmpeg process spawn error: ${error.message}`
                  );
                  console.error(
                    `   This usually means ffmpeg is not installed or not in PATH`
                  );
                  console.error(`   Install: brew install ffmpeg (macOS)`);
                  console.error(`   Check: which ffmpeg`);
                  speakerMp3Stream = null;
                  speakerMp3Path = null;
                });

                if (ffmpegProcess && ffmpegProcess.stdin) {
                  speakerMp3Stream = ffmpegProcess.stdin;
                  speakerMp3Stream.startTime = Date.now();
                  speakerMp3Stream.bytesWritten = 0;
                  console.log(
                    `💾 [JS] Recording speaker audio to MP3: ${speakerMp3Path}`
                  );
                  console.log(
                    `💾 [JS] FFmpeg process stdin stream ready, waiting for audio data...`
                  );
                } else {
                  console.warn(
                    `⚠️ [JS] Failed to create FFmpeg process, MP3 recording disabled`
                  );
                  console.warn(
                    `   [JS] Check if ffmpeg is installed: which ffmpeg`
                  );
                }
              }

              // Write Int16 PCM data to ffmpeg pipe
              if (speakerMp3Stream && !speakerMp3Stream.destroyed) {
                try {
                  // Convert Int16Array to Buffer properly
                  // int16Data.buffer might include extra bytes, so we need to slice correctly
                  const pcmBuffer = Buffer.from(
                    int16Data.buffer,
                    int16Data.byteOffset,
                    int16Data.byteLength
                  );

                  if (pcmBuffer.length === 0) {
                    if (halFrameCount <= 10) {
                      console.warn(
                        `⚠️ [JS] Empty PCM buffer, skipping MP3 write (chunk #${halFrameCount})`
                      );
                    }
                  } else {
                    // Debug: Log first write
                    if (!speakerMp3Stream.hasWritten) {
                      console.log(
                        `📝 [JS] ✨ FIRST MP3 WRITE: ${pcmBuffer.length} bytes to ${speakerMp3Path}`
                      );
                      console.log(
                        `📝 [JS] int16Data: length=${int16Data.length}, byteLength=${int16Data.byteLength}`
                      );
                      speakerMp3Stream.hasWritten = true;
                    }

                    if (halFrameCount < 10) {
                      console.log(
                        `📝 [JS] Writing to MP3: ${
                          pcmBuffer.length
                        } bytes (chunk #${halFrameCount}, total written=${
                          speakerMp3Stream.bytesWritten || 0
                        })`
                      );
                    }
                    const written = speakerMp3Stream.write(pcmBuffer);
                    if (speakerMp3Stream.bytesWritten === undefined) {
                      speakerMp3Stream.bytesWritten = 0;
                    }
                    speakerMp3Stream.bytesWritten += pcmBuffer.length;

                    // Log first few writes for debugging
                    if (
                      speakerMp3Stream.bytesWritten <= 9600 &&
                      halFrameCount < 10
                    ) {
                      // Log first ~100ms of data
                      console.log(
                        `📝 [JS] Writing to MP3: ${pcmBuffer.length} bytes (total: ${speakerMp3Stream.bytesWritten} bytes, chunk #${halFrameCount})`
                      );
                    }

                    if (!written) {
                      // Buffer is full, wait for drain
                      speakerMp3Stream.once("drain", () => {
                        // Ready to write again
                      });
                    }
                  }

                  // Check if recording duration exceeded
                  if (speakerMp3Stream.startTime) {
                    const recordingDuration = SPEAKER_RECORDING_DURATION * 1000;
                    const elapsed = Date.now() - speakerMp3Stream.startTime;
                    if (elapsed >= recordingDuration) {
                      speakerAudioFileWritten = true;
                      if (speakerMp3Stream && !speakerMp3Stream.destroyed) {
                        try {
                          speakerMp3Stream.end();
                          const totalBytes = speakerMp3Stream.bytesWritten || 0;
                          console.log(
                            `✅ Speaker MP3 recording completed: ${speakerMp3Path}`
                          );
                          console.log(
                            `   Duration: ${SPEAKER_RECORDING_DURATION}s, Bytes written: ${(
                              totalBytes / 1024
                            ).toFixed(2)} KB`
                          );
                          // Verify file exists after a short delay (ffmpeg needs time to finalize)
                          setTimeout(() => {
                            if (fs.existsSync(speakerMp3Path)) {
                              const stats = fs.statSync(speakerMp3Path);
                              console.log(
                                `   MP3 file size: ${(
                                  stats.size / 1024
                                ).toFixed(2)} KB`
                              );
                            } else {
                              console.warn(
                                `⚠️ MP3 file not found after completion: ${speakerMp3Path}`
                              );
                            }
                          }, 500);
                        } catch (e) {
                          console.error(
                            `❌ Error closing MP3 stream: ${e.message}`
                          );
                        }
                      }
                      speakerMp3Stream = null;
                    }
                  }
                } catch (e) {
                  console.error(
                    `❌ [JS] Error writing to MP3 stream: ${e.message}`
                  );
                  console.error(`   [JS] Stack: ${e.stack}`);
                  // Don't disable recording on first error, might be transient
                }
              } else if (
                SPEAKER_RECORDING_ENABLED &&
                !speakerAudioFileWritten
              ) {
                // Log why we're not writing (only first few times to avoid spam)
                if (halFrameCount < 5) {
                  if (!speakerMp3Stream) {
                    console.warn(
                      `⚠️ [JS] MP3 stream not initialized yet, audio chunk skipped (chunk #${halFrameCount})`
                    );
                  } else if (speakerMp3Stream.destroyed) {
                    console.warn(
                      `⚠️ [JS] MP3 stream destroyed, cannot write (chunk #${halFrameCount})`
                    );
                  }
                }
              }
            }

            // Send to Deepgram WebSocket - MUST convert Float32 to Int16 PCM
            // Deepgram streaming expects Linear16 (Int16 little-endian), not Float32
            if (speakerConnection && speakerConnection.isReady()) {
              if (deepgramFrameCount < 3) {
                console.log(
                  `🔊 [JS] Sending to Deepgram: ${int16Data.length} frames (chunk #${deepgramFrameCount})`
                );
              }
              speakerConnection.send(int16Data);

              // Log audio flow to Deepgram (first 10 sends)
              // This only logs when Deepgram is actually ready and receiving audio
              if (deepgramFrameCount < 10) {
                console.log(
                  `🔊 [JS] SPEAKER AUDIO → Deepgram | frames=${
                    int16Data.length
                  }, avgAbs=${avgAbs.toFixed(5)}, rms=${normalizedRms.toFixed(
                    5
                  )}, chunk #${deepgramFrameCount}`
                );
                deepgramFrameCount++;
              }
            } else {
              // Buffer audio if connection isn't ready yet (max 50 chunks to prevent memory issues)
              // Store as Float32, will convert to Int16 when flushing
              if (speakerAudioBuffer.length < 50) {
                speakerAudioBuffer.push(normalizedData);
              } else {
                // Drop oldest if buffer is full
                speakerAudioBuffer.shift();
                speakerAudioBuffer.push(normalizedData);
              }
            }

            // Note: MP3 recording is now handled above, before sending to Deepgram
            // The old WAV recording code has been replaced with real-time MP3 encoding

            // Increment frame count at the end
            halFrameCount++;
          } catch (error) {
            console.error(`❌ [JS] Error in audio callback: ${error.message}`);
            console.error(`   [JS] Stack: ${error.stack}`);
            console.error(`   [JS] Error occurred at chunk #${halFrameCount}`);
            // Don't throw - just log and continue
          }
        }, captureOptions); // Pass options to constructor

        console.log(
          `✅ [JS] NativeAudioCapture instance created, callback registered`
        );

        // Start capture - pass options explicitly to ensure they reach native addon
        // The wrapper will use these options when creating the native instance
        const result = nativeAudioCapture.start(null, captureOptions);

        if (result.success) {
          console.log(
            `✅ Native macOS audio capture started (${captureMode} mode)`
          );
          mainWindow.webContents.send("native-audio-started", true);
        } else {
          console.log("⚠️ Native audio capture failed");
          const errorMsg =
            captureMode === "hal"
              ? "HAL capture failed. This is experimental and may not work on all systems."
              : "Native audio capture failed. Please check Screen Recording permissions in System Preferences.";
          mainWindow.webContents.send("speaker-error", errorMsg);
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

  // Finalize MP3 recording if in progress
  if (
    speakerMp3Stream &&
    !speakerMp3Stream.destroyed &&
    !speakerAudioFileWritten
  ) {
    speakerAudioFileWritten = true;
    try {
      speakerMp3Stream.end();
      console.log(`✅ Speaker MP3 recording finalized: ${speakerMp3Path}`);
    } catch (e) {
      console.error(`❌ Error finalizing MP3: ${e.message}`);
    }
    speakerMp3Stream = null;
  }

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

  // Stop keepalive interval
  if (speakerKeepAliveInterval) {
    clearInterval(speakerKeepAliveInterval);
    speakerKeepAliveInterval = null;
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

app.whenReady().then(() => {
  createWindow();

  // Check if ffmpeg is available for MP3 recording
  exec(`which ffmpeg`, (error) => {
    if (error) {
      console.warn(
        `⚠️ FFmpeg not found in PATH. MP3 recording will be disabled.`
      );
      console.warn(`   Install: brew install ffmpeg (macOS)`);
    } else {
      // Verify ffmpeg works
      exec(`ffmpeg -version`, (versionError, stdout) => {
        if (versionError) {
          console.warn(
            `⚠️ FFmpeg found but may not work: ${versionError.message}`
          );
        } else {
          const versionLine = stdout.split("\n")[0];
          console.log(`✅ FFmpeg available: ${versionLine}`);
        }
      });
    }
  });

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
  if (speakerKeepAliveInterval) {
    clearInterval(speakerKeepAliveInterval);
    speakerKeepAliveInterval = null;
  }
  if (nativeAudioCapture) {
    nativeAudioCapture.stop();
    nativeAudioCapture = null;
  }
  // Finalize any pending MP3 recordings
  if (speakerMp3Stream && !speakerMp3Stream.destroyed) {
    try {
      speakerMp3Stream.end();
    } catch (e) {
      // Ignore errors
    }
    speakerMp3Stream = null;
  }
});
