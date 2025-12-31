const { app, BrowserWindow, ipcMain, desktopCapturer } = require('electron')
const path = require('path')
const { createClient } = require('@deepgram/sdk')
const { createDeepgramConnection } = require('./deepgram-streaming')
const { AccessToken } = require('livekit-server-sdk')
require('dotenv').config()

// Try to load native audio capture module (macOS only)
let NativeAudioCapture = null
let nativeAudioCapture = null

if (process.platform === 'darwin') {
  try {
    const nativeModule = require('../native-audio/index.js')
    NativeAudioCapture = nativeModule
    console.log('✅ Native audio capture module loaded')
  } catch (error) {
    console.log('⚠️ Native audio capture not available:', error.message)
    console.log('   Falling back to web API method')
  }
}

let mainWindow
let deepgramClient
let speakerConnection = null
let speakerAudioBuffer = [] // Buffer for audio chunks when connection isn't ready
let microphoneConnection = null
let microphoneAudioBuffer = [] // Buffer for audio chunks when connection isn't ready

// Initialize Deepgram client (kept for backward compatibility with file-based transcription if needed)
function initializeDeepgram(apiKey) {
  if (!apiKey) {
    console.error('Deepgram API key is required')
    return null
  }
  return createClient(apiKey)
}

// Create Deepgram WebSocket connection for speaker (streaming)
function createSpeakerConnection(apiKey) {
  if (speakerConnection) {
    speakerConnection.close()
    speakerConnection = null
  }

  console.log('📡 Creating speaker Deepgram WebSocket connection (48kHz)')

  speakerConnection = createDeepgramConnection({
    apiKey,
    language: 'multi',
    model: 'nova-3',
    sampleRate: 48000,
    channels: 1,
    interimResults: true,
    punctuate: true,
    smartFormat: true,
    diarize: false,
    type: 'speaker',
    onTranscript: (transcript, isFinal, words) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('transcript', {
          text: transcript,
          isFinal,
          source: 'speaker',
          timestamp: Date.now(),
          words: words
        })
      }
    },
    onError: (error) => {
      console.error('❌ Speaker Deepgram error:', error)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('speaker-error', error.message)
      }
    },
    onOpen: () => {
      console.log('✅ Speaker Deepgram WebSocket connected')
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('speaker-connected', true)
      }
    },
    onClose: () => {
      console.log('🔌 Speaker Deepgram WebSocket closed')
      // Clear audio buffer on close
      speakerAudioBuffer = []
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('speaker-connected', false)
      }
    }
  })

  return speakerConnection
}

// Create Deepgram WebSocket connection for microphone (streaming)
function createMicrophoneConnection(apiKey) {
  if (microphoneConnection) {
    microphoneConnection.close()
    microphoneConnection = null
  }

  console.log('🎤 Creating microphone Deepgram WebSocket connection (48kHz)')

  microphoneConnection = createDeepgramConnection({
    apiKey,
    language: 'multi',
    model: 'nova-3',
    sampleRate: 48000,
    channels: 1,
    interimResults: true,
    punctuate: true,
    smartFormat: true,
    diarize: false,
    type: 'microphone',
    onTranscript: (transcript, isFinal, words) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('transcript', {
          text: transcript,
          isFinal,
          source: 'microphone',
          timestamp: Date.now(),
          words: words
        })
      }
    },
    onError: (error) => {
      console.error('❌ Microphone Deepgram error:', error)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('microphone-error', error.message)
      }
    },
    onOpen: () => {
      console.log('✅ Microphone Deepgram WebSocket connected')
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('microphone-connected', true)
      }
    },
    onClose: () => {
      console.log('🔌 Microphone Deepgram WebSocket closed')
      microphoneAudioBuffer = []
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('microphone-connected', false)
      }
    }
  })

  return microphoneConnection
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      // Enable features needed for screen/audio capture
      webSecurity: true
    }
  })

  // Load from Vite dev server in development, or from built files in production
  const isDev = process.argv.includes('--dev') || process.env.NODE_ENV === 'development'
  if (isDev) {
    // In development, load from Vite dev server (default port 3000 from electron.vite.config.mjs)
    const port = process.env.VITE_PORT || 3000
    mainWindow.loadURL(`http://localhost:${port}`)
    mainWindow.webContents.openDevTools()
  } else {
    // In production, load from built files
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  }
}

// IPC Handlers
ipcMain.handle('initialize-deepgram', async (event, apiKey) => {
  try {
    deepgramClient = initializeDeepgram(apiKey)
    return { success: true }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('start-speaker-capture', async (event, apiKey) => {
  try {
    // Initialize Deepgram client for backward compatibility
    if (!deepgramClient) {
      deepgramClient = initializeDeepgram(apiKey)
    }

    // Create WebSocket streaming connection for speaker
    createSpeakerConnection(apiKey)

    // Try to start native audio capture if available (macOS)
    if (NativeAudioCapture && process.platform === 'darwin') {
      try {
        // Always create a fresh instance to avoid state issues
        if (nativeAudioCapture) {
          console.log('⚠️ Cleaning up existing native audio capture instance...')
          try {
            nativeAudioCapture.stop()
          } catch (e) {
            console.log('⚠️ Error stopping existing instance:', e.message)
          }
          nativeAudioCapture = null
          // Small delay to ensure cleanup
          await new Promise((resolve) => setTimeout(resolve, 100))
        }

        let audioSampleCount = 0

        console.log('🎙️ Creating new native audio capture instance...')
        nativeAudioCapture = new NativeAudioCapture((audioBuffer) => {
          // audioBuffer is a Node Buffer of float32 PCM from native
          // Reinterpret bytes as Float32Array without copying per-element
          const byteOffset = audioBuffer.byteOffset || 0
          const byteLength = audioBuffer.byteLength - (audioBuffer.byteLength % 4)
          const floatData = new Float32Array(audioBuffer.buffer, byteOffset, byteLength / 4)

          // Apply audio gain normalization to boost system audio levels
          // System audio can be quieter, so we amplify it for better transcription
          const normalizedData = new Float32Array(floatData.length)

          // Calculate RMS to determine audio level
          let sumSquares = 0
          for (let i = 0; i < floatData.length; i++) {
            sumSquares += floatData[i] * floatData[i]
          }
          const rms = Math.sqrt(sumSquares / floatData.length) || 0

          // Find peak value to prevent clipping
          let peak = 0
          for (let i = 0; i < floatData.length; i++) {
            const absValue = Math.abs(floatData[i])
            if (absValue > peak) peak = absValue
          }

          // Calculate optimal gain: boost quiet audio, prevent clipping on loud audio
          // Target RMS around 0.1-0.15 for optimal transcription quality
          // More conservative gains to avoid distortion and preserve audio quality
          let gainMultiplier = 1.0
          if (rms > 0 && rms < 0.03) {
            // Very quiet audio - boost moderately (reduced from 3.0 to avoid distortion)
            gainMultiplier = 2.0
          } else if (rms < 0.08) {
            // Quiet audio - boost moderately (reduced from 2.5)
            gainMultiplier = 1.8
          } else if (rms < 0.15) {
            // Moderate audio - slight boost (reduced from 1.5)
            gainMultiplier = 1.3
          }
          // For loud audio (rms >= 0.15), use gainMultiplier = 1.0 (no boost)

          // Prevent clipping: if peak * gain would exceed 0.95, reduce gain
          const maxSafeGain = peak > 0 ? Math.min(gainMultiplier, 0.95 / peak) : gainMultiplier

          // Apply gain normalization
          for (let i = 0; i < floatData.length; i++) {
            normalizedData[i] = Math.max(-1, Math.min(1, floatData[i] * maxSafeGain))
          }

          // Calculate RMS for audio validation (after normalization)
          let normalizedSumSquares = 0
          for (let i = 0; i < normalizedData.length; i++) {
            normalizedSumSquares += normalizedData[i] * normalizedData[i]
          }
          const normalizedRms = Math.sqrt(normalizedSumSquares / normalizedData.length) || 0

          // Log first few samples for debugging
          if (audioSampleCount < 3) {
            console.log(
              `📊 Audio sample ${audioSampleCount}: ${
                normalizedData.length
              } samples, original_rms≈${rms.toFixed(4)}, normalized_rms≈${normalizedRms.toFixed(
                4
              )}, peak≈${peak.toFixed(4)}, gain≈${maxSafeGain.toFixed(2)}x`
            )
            audioSampleCount++
          }

          // Send to Deepgram WebSocket (will automatically convert Float32 to Int16)
          if (speakerConnection && speakerConnection.isReady()) {
            speakerConnection.send(normalizedData)

            // Flush any buffered audio chunks (Deepgram handles silence automatically)
            if (speakerAudioBuffer.length > 0) {
              console.log(`📤 Flushing ${speakerAudioBuffer.length} buffered audio chunks`)
              speakerAudioBuffer.forEach((bufferedData) => {
                speakerConnection.send(bufferedData)
              })
              speakerAudioBuffer = []
            }
          } else {
            // Buffer audio if connection isn't ready yet (max 50 chunks to prevent memory issues)
            if (speakerAudioBuffer.length < 50) {
              speakerAudioBuffer.push(normalizedData)
            } else {
              // Drop oldest if buffer is full
              speakerAudioBuffer.shift()
              speakerAudioBuffer.push(normalizedData)
            }
          }
        })

        const result = nativeAudioCapture.start()
        if (result.success) {
          console.log('✅ Native macOS audio capture started')
          mainWindow.webContents.send('native-audio-started', true)
        } else {
          console.log('⚠️ Native audio capture failed')
          mainWindow.webContents.send(
            'speaker-error',
            'Native audio capture failed. Please check Screen Recording permissions in System Preferences.'
          )
        }
      } catch (error) {
        console.log('⚠️ Native audio capture error:', error.message)
        // Continue with web API fallback
      }
    }

    return { success: true }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('stop-speaker-capture', async () => {
  console.log('🛑 Stopping speaker capture...')

  // Stop native audio capture if running
  if (nativeAudioCapture) {
    try {
      const stopResult = nativeAudioCapture.stop()
      console.log('✅ Native audio capture stopped:', stopResult)
    } catch (error) {
      console.error('❌ Error stopping native audio capture:', error.message)
    }

    // Clear the reference to allow proper cleanup
    nativeAudioCapture = null

    // Give a small delay to ensure native cleanup is complete
    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  // Close WebSocket connection
  if (speakerConnection) {
    speakerConnection.close()
    speakerConnection = null
    console.log('✅ Speaker Deepgram connection closed')
  }

  // Clear audio buffer
  speakerAudioBuffer = []

  console.log('✅ Speaker capture stopped successfully')
  return { success: true }
})

ipcMain.handle('start-microphone-deepgram', async (event, apiKey) => {
  try {
    if (!deepgramClient) {
      deepgramClient = initializeDeepgram(apiKey)
    }

    createMicrophoneConnection(apiKey)
    return { success: true }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('stop-microphone-deepgram', async () => {
  console.log('🛑 Stopping microphone Deepgram connection...')

  if (microphoneConnection) {
    microphoneConnection.close()
    microphoneConnection = null
    console.log('✅ Microphone Deepgram connection closed')
  }

  microphoneAudioBuffer = []

  console.log('✅ Microphone Deepgram stopped successfully')
  return { success: true }
})

ipcMain.handle('send-audio-data', async (event, audioData, source) => {
  try {
    // Convert ArrayBuffer to Buffer for Node.js
    const buffer = Buffer.from(audioData)

    if (source === 'speaker') {
      if (speakerConnection && speakerConnection.isReady()) {
        // Convert buffer to Int16Array for streaming
        const int16Array = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2)
        speakerConnection.send(int16Array)
      } else {
        // Buffer audio if connection not ready
        const int16Array = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2)
        if (speakerAudioBuffer.length < 50) {
          speakerAudioBuffer.push(int16Array)
        }
      }
      return { success: true }
    }

    if (source === 'microphone') {
      if (microphoneConnection && microphoneConnection.isReady()) {
        // Convert buffer to Int16Array for streaming
        const int16Array = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2)
        microphoneConnection.send(int16Array)

        // Flush buffered audio if any
        if (microphoneAudioBuffer.length > 0) {
          console.log(
            `📤 Flushing ${microphoneAudioBuffer.length} buffered microphone audio chunks`
          )
          microphoneAudioBuffer.forEach((bufferedData) => {
            microphoneConnection.send(bufferedData)
          })
          microphoneAudioBuffer = []
        }
      } else {
        // Buffer audio if connection not ready
        const int16Array = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2)
        if (microphoneAudioBuffer.length < 50) {
          microphoneAudioBuffer.push(int16Array)
        }
      }
      return { success: true }
    }

    return { success: false, error: 'Unknown source' }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

// Get desktop sources for screen/audio capture
ipcMain.handle('get-desktop-sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 0, height: 0 }, // No thumbnails needed
      fetchWindowIcons: false
    })
    return { success: true, sources }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

// Get LiveKit credentials from environment variables
ipcMain.handle('get-livekit-credentials', async () => {
  try {
    return {
      success: true,
      wssUrl: process.env.LIVEKIT_WSS_URL || '',
      apiKey: process.env.LIVEKIT_API_KEY || '',
      apiSecret: process.env.LIVEKIT_API_SECRET || ''
    }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

// Generate LiveKit access token
ipcMain.handle(
  'generate-livekit-token',
  async (event, roomName, participantIdentity, participantName) => {
    try {
      const apiKey = process.env.LIVEKIT_API_KEY
      const apiSecret = process.env.LIVEKIT_API_SECRET

      if (!apiKey || !apiSecret) {
        return { success: false, error: 'LiveKit credentials not configured' }
      }

      const at = new AccessToken(apiKey, apiSecret, {
        identity: participantIdentity || `user-${Date.now()}`,
        name: participantName || 'Recording User'
      })

      at.addGrant({
        room: roomName || 'recording-room',
        roomJoin: true,
        canPublish: true,
        canSubscribe: false
      })

      const token = await at.toJwt()

      return {
        success: true,
        token,
        wssUrl: process.env.LIVEKIT_WSS_URL || ''
      }
    } catch (error) {
      console.error('Error generating LiveKit token:', error)
      return { success: false, error: error.message }
    }
  }
)

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (speakerConnection) {
    speakerConnection.close()
  }
  if (microphoneConnection) {
    microphoneConnection.close()
  }
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  if (speakerConnection) {
    speakerConnection.close()
  }
  if (microphoneConnection) {
    microphoneConnection.close()
  }
  if (nativeAudioCapture) {
    nativeAudioCapture.stop()
    nativeAudioCapture = null
  }
})
