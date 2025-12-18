/**
 * Production-ready Deepgram WebSocket Streaming Module
 * Optimized for low latency, word continuity, and clean final transcripts
 */

const WebSocket = require("ws");

/**
 * Convert Float32 PCM audio to Int16 PCM (required by Deepgram)
 * @param {Float32Array} float32Array - Input audio in Float32 format
 * @returns {Buffer} - Output audio in Int16 format as Buffer
 */
function floatTo16BitPCM(float32Array) {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  let offset = 0;

  for (let i = 0; i < float32Array.length; i++, offset += 2) {
    // Clamp to [-1, 1] range
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    // Convert to 16-bit signed integer
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return Buffer.from(buffer);
}

/**
 * Create a Deepgram WebSocket connection for streaming audio
 * @param {Object} config - Configuration object
 * @param {string} config.apiKey - Deepgram API key
 * @param {string} config.language - Language code (default: "multi")
 * @param {string} config.model - Model name (default: "nova-2")
 * @param {number} config.sampleRate - Sample rate in Hz (default: 16000)
 * @param {number} config.channels - Number of channels (default: 1)
 * @param {boolean} config.interimResults - Enable interim results (default: true)
 * @param {boolean} config.punctuate - Enable punctuation (default: true)
 * @param {boolean} config.smartFormat - Enable smart formatting (default: true)
 * @param {boolean} config.diarize - Enable speaker diarization (default: true)
 * @param {Function} config.onTranscript - Callback for transcripts (transcript, isFinal, words)
 * @param {Function} config.onError - Callback for errors
 * @param {Function} config.onOpen - Callback for connection open
 * @param {Function} config.onClose - Callback for connection close
 * @returns {Object} - Connection object with send, close methods
 */
function createDeepgramConnection(config) {
  const {
    apiKey,
    language = "multi",
    model = "nova-2",
    sampleRate = 16000,
    channels = 1,
    interimResults = true,
    punctuate = true,
    smartFormat = true,
    diarize = true,
    onTranscript,
    onError,
    onOpen,
    onClose,
  } = config;

  if (!apiKey) {
    throw new Error("Deepgram API key is required");
  }

  // Build WebSocket URL with query parameters
  // Simplified settings for reliable transcription
  const params = new URLSearchParams({
    model,
    language,
    encoding: "linear16",
    sample_rate: sampleRate.toString(),
    channels: channels.toString(),
    interim_results: interimResults.toString(),
    punctuate: punctuate.toString(),
    smart_format: smartFormat.toString(),
    // Endpointing - finalize after brief silence
    endpointing: "400",
    // VAD events for speech detection
    vad_events: "true",
  });

  const wsUrl = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

  console.log(`📡 Creating Deepgram WebSocket connection:`);
  console.log(`   URL: ${wsUrl}`);
  console.log(`   Model: ${model}, Language: ${language}, Sample Rate: ${sampleRate}Hz`);

  // Create WebSocket connection
  const ws = new WebSocket(wsUrl, {
    headers: {
      Authorization: `Token ${apiKey}`,
    },
  });

  let isConnected = false;
  let lastFinalTranscript = "";
  let keepAliveInterval = null;
  let lastAudioSentTime = Date.now();

  // WebSocket event handlers
  ws.on("open", () => {
    console.log("✅ Deepgram WebSocket connected");
    isConnected = true;

    // Start keepalive to maintain connection
    // Send a KeepAlive message every 8 seconds to prevent timeout
    keepAliveInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        const timeSinceLastAudio = Date.now() - lastAudioSentTime;
        // Only send keepalive if we haven't sent audio recently
        if (timeSinceLastAudio > 5000) {
          try {
            ws.send(JSON.stringify({ type: "KeepAlive" }));
            console.log("💓 Deepgram keepalive sent");
          } catch (err) {
            console.error("❌ Keepalive error:", err.message);
          }
        }
      }
    }, 8000);

    if (onOpen) onOpen();
  });

  ws.on("error", (err) => {
    let errorMessage = err.message;
    if (err.message.includes("401")) {
      errorMessage = "Invalid API key. Please check your Deepgram API key and try again.";
    }
    console.error("❌ Deepgram WebSocket error:", errorMessage);
    if (onError) onError(new Error(errorMessage));
  });

  ws.on("close", () => {
    console.log("🔌 Deepgram WebSocket closed");
    isConnected = false;

    // Clear keepalive interval
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
      keepAliveInterval = null;
    }

    if (onClose) onClose();
  });

  // Track the last interim transcript to commit on speech end
  let lastInterimTranscript = "";
  let lastInterimWords = [];

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      // Handle speech started event (don't log - too noisy)
      if (data.type === "SpeechStarted") {
        return;
      }

      // Handle utterance end event - commit any pending interim as final
      if (data.type === "UtteranceEnd") {
        if (lastInterimTranscript && lastInterimTranscript.trim()) {
          lastFinalTranscript += lastInterimTranscript + " ";
          if (onTranscript) onTranscript(lastInterimTranscript, true, lastInterimWords);
          lastInterimTranscript = "";
          lastInterimWords = [];
        }
        return;
      }

      // Check if we have valid channel data
      if (!data.channel) return;

      const alternatives = data.channel.alternatives;
      if (!alternatives || !alternatives[0]) return;

      const transcript = alternatives[0].transcript;
      const isFinal = data.is_final;
      const words = alternatives[0].words || [];

      // Only process if we have a transcript
      if (!transcript) return;

      if (isFinal) {
        // ✅ COMMIT FINAL TEXT
        lastFinalTranscript += transcript + " ";
        lastInterimTranscript = ""; // Clear interim since we got a final
        lastInterimWords = [];
        if (onTranscript) onTranscript(transcript, true, words);
      } else {
        // ⚠️ INTERIM (do not persist, but track for utterance end)
        lastInterimTranscript = transcript;
        lastInterimWords = words;
        if (onTranscript) onTranscript(transcript, false, words);
      }
    } catch (error) {
      console.error("❌ Error parsing Deepgram message:", error);
      if (onError) onError(error);
    }
  });

  // Return connection interface
  return {
    /**
     * Send audio data to Deepgram
     * @param {Float32Array|Int16Array|Buffer} audioData - Audio data to send
     */
    send: (audioData) => {
      if (!isConnected || ws.readyState !== WebSocket.OPEN) {
        // Don't log every skip - it's normal during connection setup
        return;
      }

      try {
        let buffer;

        // Convert Float32Array to Int16 PCM
        if (audioData instanceof Float32Array) {
          buffer = floatTo16BitPCM(audioData);
        }
        // Convert Int16Array to Buffer
        else if (audioData instanceof Int16Array) {
          buffer = Buffer.from(
            audioData.buffer,
            audioData.byteOffset,
            audioData.byteLength
          );
        }
        // Use Buffer directly
        else if (Buffer.isBuffer(audioData)) {
          buffer = audioData;
        } else {
          console.error("❌ Invalid audio data type");
          return;
        }

        ws.send(buffer);
        lastAudioSentTime = Date.now(); // Track for keepalive
      } catch (error) {
        console.error("❌ Error sending audio:", error);
        if (onError) onError(error);
      }
    },

    /**
     * Close the WebSocket connection gracefully
     */
    close: () => {
      // Clear keepalive first
      if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
      }

      if (ws.readyState === WebSocket.OPEN) {
        try {
          // Send CloseStream message
          ws.send(JSON.stringify({ type: "CloseStream" }));
          // Close the WebSocket
          ws.close();
          console.log("🛑 Deepgram connection closed gracefully");
        } catch (error) {
          console.error("❌ Error closing connection:", error);
          ws.close();
        }
      }
    },

    /**
     * Check if connection is ready
     */
    isReady: () => {
      return isConnected && ws.readyState === WebSocket.OPEN;
    },

    /**
     * Get the full final transcript so far
     */
    getFinalTranscript: () => {
      return lastFinalTranscript;
    },

    /**
     * Clear the accumulated final transcript
     */
    clearTranscript: () => {
      lastFinalTranscript = "";
    },
  };
}

module.exports = {
  createDeepgramConnection,
  floatTo16BitPCM,
};
