const { contextBridge, ipcRenderer } = require("electron");

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld("electronAPI", {
  // Deepgram initialization
  initializeDeepgram: (apiKey) =>
    ipcRenderer.invoke("initialize-deepgram", apiKey),

  // Audio capture control - only native methods
  startMicrophoneCapture: (apiKey) =>
    ipcRenderer.invoke("start-microphone-capture", apiKey),
  startSpeakerCapture: (apiKey) =>
    ipcRenderer.invoke("start-speaker-capture", apiKey),
  stopMicrophoneCapture: () => ipcRenderer.invoke("stop-microphone-capture"),
  stopSpeakerCapture: () => ipcRenderer.invoke("stop-speaker-capture"),

  // Native capture methods (exposed for compatibility)
  startNativeCapture: async (type, callback) => {
    // Register callback for native audio data if needed
    if (callback && type === "microphone") {
      ipcRenderer.on("native-microphone-data", (event, data) => callback(data));
    } else if (callback && type === "speaker") {
      ipcRenderer.on("native-speaker-data", (event, data) => callback(data));
    }

    // Start native capture through main process
    if (type === "microphone") {
      return await ipcRenderer.invoke("start-microphone-capture");
    } else if (type === "speaker") {
      return await ipcRenderer.invoke("start-speaker-capture");
    }

    return { success: false, error: "Invalid capture type" };
  },

  stopNativeCapture: async (type) => {
    if (type === "microphone") {
      return await ipcRenderer.invoke("stop-microphone-capture");
    } else if (type === "speaker") {
      return await ipcRenderer.invoke("stop-speaker-capture");
    }
    return { success: false, error: "Invalid capture type" };
  },

  // Send audio data to Deepgram (kept for backward compatibility, but native handles this)
  sendAudioData: (audioData, source) =>
    ipcRenderer.invoke("send-audio-data", audioData, source),

  // Listen for events from main process
  onMicrophoneConnected: (callback) =>
    ipcRenderer.on("microphone-connected", (event, value) => callback(value)),
  onSpeakerConnected: (callback) =>
    ipcRenderer.on("speaker-connected", (event, value) => callback(value)),
  onMicrophoneError: (callback) =>
    ipcRenderer.on("microphone-error", (event, error) => callback(error)),
  onSpeakerError: (callback) =>
    ipcRenderer.on("speaker-error", (event, error) => callback(error)),
  onTranscript: (callback) =>
    ipcRenderer.on("transcript", (event, data) => callback(data)),
  onNativeAudioStarted: (callback) =>
    ipcRenderer.on("native-audio-started", (event, value) => callback(value)),

  // Remove listeners
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),
});
