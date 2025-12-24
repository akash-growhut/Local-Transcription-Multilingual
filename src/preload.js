const { contextBridge, ipcRenderer } = require("electron");

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld("electronAPI", {
  // Deepgram initialization
  initializeDeepgram: (apiKey) =>
    ipcRenderer.invoke("initialize-deepgram", apiKey),

  // Audio capture control
  startMicrophoneCapture: (apiKey) =>
    ipcRenderer.invoke("start-microphone-capture", apiKey),
  startSpeakerCapture: (apiKey) =>
    ipcRenderer.invoke("start-speaker-capture", apiKey),
  stopMicrophoneCapture: () => ipcRenderer.invoke("stop-microphone-capture"),
  stopSpeakerCapture: () => ipcRenderer.invoke("stop-speaker-capture"),

  // Send audio data to Deepgram
  sendAudioData: (audioData, source, sampleRate) =>
    ipcRenderer.invoke("send-audio-data", audioData, source, sampleRate),

  // RNNoise noise cancellation
  checkRNNoise: () => ipcRenderer.invoke("check-rnnoise"),
  initializeRNNoise: () => ipcRenderer.invoke("initialize-rnnoise"),
  processAudioWithRNNoise: (audioData) =>
    ipcRenderer.invoke("process-audio-rnnoise", audioData),
  setRNNoiseEnabled: (enabled) =>
    ipcRenderer.invoke("set-rnnoise-enabled", enabled),
  destroyRNNoise: () => ipcRenderer.invoke("destroy-rnnoise"),

  // Desktop capture
  getDesktopSources: (options) =>
    ipcRenderer.invoke("get-desktop-sources", options),

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
  onMicrophoneAppDetected: (callback) =>
    ipcRenderer.on("microphone-app-detected", (event, appName) => callback(appName)),

  // Remove listeners
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),
});
