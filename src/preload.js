const { contextBridge, ipcRenderer } = require('electron')

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Deepgram initialization
  initializeDeepgram: (apiKey) => ipcRenderer.invoke('initialize-deepgram', apiKey),

  // Audio capture control
  startSpeakerCapture: (apiKey) => ipcRenderer.invoke('start-speaker-capture', apiKey),
  stopSpeakerCapture: () => ipcRenderer.invoke('stop-speaker-capture'),

  // Microphone Deepgram control
  startMicrophoneDeepgram: (apiKey) => ipcRenderer.invoke('start-microphone-deepgram', apiKey),
  stopMicrophoneDeepgram: () => ipcRenderer.invoke('stop-microphone-deepgram'),

  // Send audio data to Deepgram (speaker or microphone)
  sendAudioData: (audioData, source) => ipcRenderer.invoke('send-audio-data', audioData, source),

  // Desktop capture
  getDesktopSources: (options) => ipcRenderer.invoke('get-desktop-sources', options),

  // LiveKit credentials
  getLiveKitCredentials: () => ipcRenderer.invoke('get-livekit-credentials'),
  generateLiveKitToken: (roomName, participantIdentity, participantName) =>
    ipcRenderer.invoke('generate-livekit-token', roomName, participantIdentity, participantName),

  // Listen for events from main process
  onSpeakerConnected: (callback) =>
    ipcRenderer.on('speaker-connected', (event, value) => callback(value)),
  onSpeakerError: (callback) => ipcRenderer.on('speaker-error', (event, error) => callback(error)),
  onMicrophoneConnected: (callback) =>
    ipcRenderer.on('microphone-connected', (event, value) => callback(value)),
  onMicrophoneError: (callback) =>
    ipcRenderer.on('microphone-error', (event, error) => callback(error)),
  onTranscript: (callback) => ipcRenderer.on('transcript', (event, data) => callback(data)),

  // Remove listeners
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
})
