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
  const params = new URLSearchParams({
    model,
    language,
    encoding: "linear16",
    sample_rate: sampleRate.toString(),
    channels: channels.toString(),
    interim_results: interimResults.toString(),
    punctuate: punctuate.toString(),
    smart_format: smartFormat.toString(),
    diarize: diarize.toString(),
  });

  const wsUrl = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

  console.log(`📡 Creating Deepgram WebSocket connection:`);
  console.log(`   Model: ${model}`);
  console.log(`   Language: ${language}`);
  console.log(`   Sample Rate: ${sampleRate}Hz`);
  console.log(`   Channels: ${channels}`);
  console.log(`   Interim Results: ${interimResults}`);

  // Create WebSocket connection
  const ws = new WebSocket(wsUrl, {
    headers: {
      Authorization: `Token ${apiKey}`,
    },
  });

  let isConnected = false;
  let lastFinalTranscript = "";

  // WebSocket event handlers
  ws.on("open", () => {
    console.log("✅ Deepgram WebSocket connected");
    isConnected = true;
    if (onOpen) onOpen();
  });

  ws.on("error", (err) => {
    console.error("❌ Deepgram WebSocket error:", err.message);
    if (onError) onError(err);
  });

  ws.on("close", () => {
    console.log("🔌 Deepgram WebSocket closed");
    isConnected = false;
    if (onClose) onClose();
  });

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());

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
        console.log(`💬 FINAL: "${transcript}"`);
        lastFinalTranscript += transcript + " ";
        if (onTranscript) onTranscript(transcript, true, words);
      } else {
        // ⚠️ INTERIM (do not persist)
        console.log(`📝 INTERIM: "${transcript}"`);
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
        console.warn("⚠️ WebSocket not ready, skipping audio chunk");
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
      } catch (error) {
        console.error("❌ Error sending audio:", error);
        if (onError) onError(error);
      }
    },

    /**
     * Close the WebSocket connection gracefully
     */
    close: () => {
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
