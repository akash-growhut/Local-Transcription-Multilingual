import { useState, useEffect, useRef, useCallback } from 'react'
import { Room, RoomEvent } from 'livekit-client'
import { KrispNoiseFilter, isKrispNoiseFilterSupported } from '@livekit/krisp-noise-filter'
import muteMicIcon from './assets/svg/muteMic.svg'
import saveKeyIcon from './assets/svg/savekey.svg'
import speakerBubbleIcon from './assets/svg/speakerBubble.svg'
import startAllIcon from './assets/svg/startAll.svg'
import statusItem1Icon from './assets/svg/status-item-1.svg'
import statusItem2Icon from './assets/svg/status-item-2.svg'
import stopRecordingIcon from './assets/svg/stopRecording.svg'
import unmuteMicIcon from './assets/svg/unmuteMic.svg'
import userBubbleIcon from './assets/svg/user-bubble.svg'

const RecordingPage = () => {
  // React refs for instance values
  const speakerTranscripts = useRef(new Map())
  const lastDisplayedText = useRef('')
  const liveKitRoom = useRef(null)
  const liveKitAudioContext = useRef(null)
  const liveKitAudioProcessor = useRef(null)
  const liveKitKrispProcessor = useRef(null)
  const isMicrophoneMutedRef = useRef(false)
  const deepgramMicConnection = useRef(null)
  const deepgramMicSampleRate = useRef(48000)

  // React state for component values
  const [deepgramApiKey, setDeepgramApiKey] = useState('')
  // Transcripts stored for potential export functionality (not currently displayed)
  const [microphoneTranscript, setMicrophoneTranscript] = useState('')
  const [speakerTranscript, setSpeakerTranscript] = useState('')
  const [isMicrophoneMuted, setIsMicrophoneMuted] = useState(false)

  // UI state
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [micStatus, setMicStatus] = useState({ text: 'Not connected', className: '' })
  const [speakerStatus, setSpeakerStatus] = useState({ text: 'Not connected', className: '' })
  const [connectionStatus, setConnectionStatus] = useState('Ready')
  const [isRecording, setIsRecording] = useState(false)
  const [muteButtonDisabled, setMuteButtonDisabled] = useState(true)
  const [showHelpText, setShowHelpText] = useState(true)
  const [platform, setPlatform] = useState('')

  // Use transcripts in dev mode to satisfy linter (stored for potential export functionality)
  if (process.env.NODE_ENV === 'development') {
    void microphoneTranscript
    void speakerTranscript
    void platform
  }

  // Messages state
  const [messages, setMessages] = useState([])
  const chatMessagesRef = useRef(null)

  // Reset transcript tracking when starting new capture
  const resetSpeakerTranscriptTracking = () => {
    speakerTranscripts.current.clear()
    lastDisplayedText.current = ''
  }

  const isAudioContextAvailable = () => {
    try {
      // Check if AudioContext is supported
      if (
        typeof AudioContext === 'undefined' &&
        typeof window?.webkitAudioContext === 'undefined'
      ) {
        console.warn('AudioContext is not supported')
        return false
      }

      // Check if we're in a secure context (required for AudioContext)
      if (!window?.isSecureContext) {
        console.warn('AudioContext requires a secure context (HTTPS or localhost)')
        return false
      }

      return true
    } catch (error) {
      console.warn('AudioContext availability check failed:', error)
      return false
    }
  }

  // Function to lowercase first word if continuing from previous transcript
  const adjustCapitalization = (text, previousText) => {
    if (!previousText) {
      // First transcript, keep as is
      return text
    }

    // Check if previous transcript ended with sentence-ending punctuation
    const endsWithPunctuation = /[.!?]\s*$/.test(previousText.trim())

    if (endsWithPunctuation) {
      // Previous sentence ended, keep capitalization
      return text
    }

    // Previous sentence continues, lowercase first word
    if (text.length > 0) {
      return text.charAt(0).toLowerCase() + text.slice(1)
    }

    return text
  }

  // Function to display transcripts in sequential order
  const displaySequentialTranscripts = useCallback(() => {
    console.log(`🔍 [displaySequentialTranscripts] Starting...`)

    const newMessages = []

    // Keep displaying transcripts while we have any available
    while (speakerTranscripts.current.size > 0) {
      // Get all available indices, sorted
      const sortedIndices = Array.from(speakerTranscripts.current.keys()).sort((a, b) => a - b)

      // Always take the first (lowest) index
      const currentIndex = sortedIndices[0]
      const transcriptData = speakerTranscripts.current.get(currentIndex)

      if (!transcriptData) {
        console.log(`⚠️ Transcript ${currentIndex} exists but has no data`)
        speakerTranscripts.current.delete(currentIndex)
        continue
      }

      // Adjust capitalization based on previous transcript
      const adjustedText = adjustCapitalization(transcriptData.text, lastDisplayedText.current)

      console.log(`✅ Displaying transcript ${currentIndex}: "${adjustedText}"`)

      // Add message to state
      newMessages.push({
        id: `speaker-${currentIndex}-${transcriptData.timestamp}`,
        type: 'message',
        source: 'speaker',
        text: adjustedText,
        isFinal: true,
        timestamp: transcriptData.timestamp
      })

      // Update stored transcript
      setSpeakerTranscript((prev) => prev + adjustedText + ' ')
      lastDisplayedText.current = adjustedText

      // Remove from map after displaying
      speakerTranscripts.current.delete(currentIndex)
      console.log(`🗑️ Removed transcript ${currentIndex} from queue`)
    }

    // Update messages state if we have new messages
    if (newMessages.length > 0) {
      setMessages((prev) => [...prev, ...newMessages])
      console.log(`📜 Displayed all available transcripts`)
    } else {
      console.log(`ℹ️ No new transcripts to display`)
    }
  }, [])

  const displayTranscript = useCallback(
    (text, isFinal, source, eventData = null) => {
      console.log(`🎯 [displayTranscript] Called with:`, {
        text,
        isFinal,
        source,
        eventData
      })

      // Handle file-based transcripts (from MP3 transcription)
      if (source === 'speaker' && eventData && eventData.fileIndex !== undefined) {
        const fileIndex = eventData.fileIndex
        console.log(`📝 Received file-based transcript ${fileIndex}: "${text}"`)
        speakerTranscripts.current.set(fileIndex, {
          text: text,
          timestamp: eventData.timestamp || Date.now()
        })

        console.log(
          `📊 Stored transcripts (queue):`,
          Array.from(speakerTranscripts.current.keys()).sort((a, b) => a - b)
        )

        // Display transcripts in sequential order
        displaySequentialTranscripts()
        return
      }

      // Handle live/streaming transcripts (no fileIndex)
      console.log(
        `📝 Received live ${source} transcript (${isFinal ? 'FINAL' : 'interim'}): "${text}"`
      )

      if (isFinal) {
        // Add final transcript as a message
        const messageId = `${source}-${Date.now()}-${Math.random()}`
        setMessages((prev) => [
          ...prev.filter((msg) => !(msg.source === source && !msg.isFinal)), // Remove interim messages for this source
          {
            id: messageId,
            type: 'message',
            source: source,
            text: text,
            isFinal: true,
            timestamp: Date.now()
          }
        ])

        // Update stored transcript
        if (source === 'microphone') {
          setMicrophoneTranscript((prev) => prev + text + ' ')
        } else {
          setSpeakerTranscript((prev) => prev + text + ' ')
        }
      } else {
        // Update interim transcript (remove previous interim for this source, add new one)
        if (text) {
          const interimId = `interim-${source}`
          setMessages((prev) => {
            const filtered = prev.filter((msg) => msg.id !== interimId)
            return [
              ...filtered,
              {
                id: interimId,
                type: 'message',
                source: source,
                text: text,
                isFinal: false,
                timestamp: Date.now()
              }
            ]
          })
        } else {
          // Remove interim if text is empty
          setMessages((prev) => prev.filter((msg) => msg.id !== `interim-${source}`))
        }
      }
    },
    [displaySequentialTranscripts]
  )

  // Add system message to chat
  const addSystemMessage = useCallback((text) => {
    const systemMsgId = Date.now()
    setMessages((prev) => [
      ...prev,
      { id: systemMsgId, type: 'system', text, timestamp: Date.now() }
    ])

    // Remove system message after 3 seconds
    setTimeout(() => {
      setMessages((prev) => prev.filter((msg) => msg.id !== systemMsgId))
    }, 3000)
  }, [])

  // Helper function to create Deepgram WebSocket connection for microphone
  const createMicrophoneDeepgramConnection = useCallback(
    (apiKey, sampleRate = 48000) => {
      console.log(
        `🔊 [MIC Deepgram] Creating microphone Deepgram WebSocket connection (${sampleRate}Hz)`
      )

      // Close existing connection if any
      if (deepgramMicConnection.current) {
        console.log('🔊 [MIC Deepgram] Closing existing connection')
        deepgramMicConnection.current.close()
        deepgramMicConnection.current = null
      }

      deepgramMicSampleRate.current = sampleRate

      // Build WebSocket URL with query parameters
      // Note: Browser WebSocket API doesn't support custom headers, so we need to pass API key differently
      // For Deepgram, we'll need to use token in URL or create a proxy. For now, let's try URL-based auth
      const params = new URLSearchParams({
        model: 'nova-3',
        language: 'multi',
        encoding: 'linear16',
        sample_rate: sampleRate.toString(),
        channels: '1',
        interim_results: 'true',
        punctuate: 'true',
        smart_format: 'true',
        diarize: 'false',
        token: apiKey // Deepgram supports token in URL for browser usage
      })

      const wsUrl = `wss://api.deepgram.com/v1/listen?${params.toString()}`
      console.log(`🔊 [MIC Deepgram] Connecting to Deepgram WebSocket...`)
      console.log(`🔊 [MIC Deepgram] Sample rate: ${sampleRate}Hz, Model: nova-3`)

      // Create WebSocket connection
      const ws = new WebSocket(wsUrl)
      deepgramMicConnection.current = ws

      ws.onopen = () => {
        console.log('✅ [MIC Deepgram] WebSocket connected')
        setMicStatus({ text: 'Recording', className: 'recording' })
      }

      ws.onerror = (error) => {
        console.error('❌ [MIC Deepgram] WebSocket error:', error)
        setMicStatus({ text: 'Deepgram Error', className: 'error' })
      }

      ws.onclose = () => {
        console.log('🔌 [MIC Deepgram] WebSocket closed')
        deepgramMicConnection.current = null
      }

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          console.log('🔊 [MIC Deepgram] Received message:', data)

          // Check if we have valid channel data
          if (!data.channel) {
            console.log('🔊 [MIC Deepgram] No channel data in message')
            return
          }

          const alternatives = data.channel.alternatives
          if (!alternatives || !alternatives[0]) {
            console.log('🔊 [MIC Deepgram] No alternatives in message')
            return
          }

          const transcript = alternatives[0].transcript
          const isFinal = data.is_final

          // Only process if we have a transcript
          if (!transcript) {
            console.log('🔊 [MIC Deepgram] No transcript in message')
            return
          }

          console.log(
            `🔊 [MIC Deepgram] ${isFinal ? 'FINAL' : 'INTERIM'} transcript: "${transcript}"`
          )

          // Display transcript
          displayTranscript(transcript, isFinal, 'microphone')
        } catch (error) {
          console.error('❌ [MIC Deepgram] Error parsing message:', error)
        }
      }

      return ws
    },
    [displayTranscript]
  )

  // Helper function to send audio data to Deepgram
  const sendAudioToDeepgram = useCallback((int16Array) => {
    if (!deepgramMicConnection.current) {
      console.warn('⚠️ [MIC Deepgram] WebSocket connection not initialized')
      return
    }

    const readyState = deepgramMicConnection.current.readyState
    if (readyState !== WebSocket.OPEN) {
      // Log only occasionally to avoid spam
      if (Math.random() < 0.01) {
        console.warn(
          `⚠️ [MIC Deepgram] WebSocket not ready (state: ${readyState}), skipping audio chunk`
        )
      }
      return
    }

    try {
      // Convert Int16Array to ArrayBuffer
      const buffer = int16Array.buffer
      deepgramMicConnection.current.send(buffer)
    } catch (error) {
      console.error('❌ [MIC Deepgram] Error sending audio:', error)
    }
  }, [])

  // Helper function to process audio from MediaStreamTrack and send to Deepgram
  const processAudioTrackForDeepgram = useCallback(
    (audioTrack, sampleRate = 48000) => {
      console.log(`🔊 [MIC Audio] Processing audio track with sample rate: ${sampleRate}Hz`)

      // Clean up previous audio context and processor if they exist
      if (liveKitAudioProcessor.current) {
        console.log('🔊 [MIC Audio] Cleaning up previous audio processor')
        liveKitAudioProcessor.current.disconnect()
        liveKitAudioProcessor.current = null
      }
      if (liveKitAudioContext.current) {
        console.log('🔊 [MIC Audio] Closing previous audio context')
        liveKitAudioContext.current.close().catch(console.error)
        liveKitAudioContext.current = null
      }

      // Create Deepgram connection if we have API key
      if (deepgramApiKey) {
        console.log('🔊 [MIC Deepgram] Creating Deepgram connection...')
        createMicrophoneDeepgramConnection(deepgramApiKey, sampleRate)
      } else {
        console.warn('⚠️ [MIC Deepgram] No Deepgram API key available')
      }

      // Create new AudioContext
      console.log(`🔊 [MIC Audio] Creating AudioContext at ${sampleRate}Hz`)
      liveKitAudioContext.current = new AudioContext({ sampleRate })
      const source = liveKitAudioContext.current.createMediaStreamSource(
        new MediaStream([audioTrack])
      )
      console.log('🔊 [MIC Audio] AudioContext and source created')

      // Create ScriptProcessorNode to capture audio data
      liveKitAudioProcessor.current = liveKitAudioContext.current.createScriptProcessor(4096, 1, 1)

      let chunkCount = 0
      liveKitAudioProcessor.current.onaudioprocess = (e) => {
        if (!isMicrophoneMutedRef.current) {
          const inputData = e.inputBuffer.getChannelData(0)

          // Log first few chunks for debugging
          if (chunkCount < 3) {
            const rms = Math.sqrt(
              inputData.reduce((sum, val) => sum + val * val, 0) / inputData.length
            )
            console.log(
              `🔊 [MIC Audio] Chunk ${chunkCount}: ${inputData.length} samples, RMS: ${rms.toFixed(4)}`
            )
            chunkCount++
          }

          // Convert Float32Array to Int16Array
          const int16Array = new Int16Array(inputData.length)
          for (let i = 0; i < inputData.length; i++) {
            const s = Math.max(-1, Math.min(1, inputData[i]))
            int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7fff
          }

          // Send audio data to Deepgram
          sendAudioToDeepgram(int16Array)
        }
      }

      source.connect(liveKitAudioProcessor.current)
      liveKitAudioProcessor.current.connect(liveKitAudioContext.current.destination)
      console.log('🔊 [MIC Audio] Audio processing pipeline connected')
    },
    [deepgramApiKey, createMicrophoneDeepgramConnection, sendAudioToDeepgram]
  )

  // Initialize on component mount
  useEffect(() => {
    // Load saved API key
    const savedKey = localStorage.getItem('deepgramApiKey')
    if (savedKey) {
      setDeepgramApiKey(savedKey)
      window.electronAPI?.initializeDeepgram(savedKey)
    }

    // Update platform info
    const platformText = navigator.platform?.includes('Mac')
      ? 'macOS'
      : navigator.platform?.includes('Win')
        ? 'Windows'
        : navigator.platform?.includes('Linux')
          ? 'Linux'
          : navigator.platform || 'Unknown'
    setPlatform(platformText)

    // Setup event listeners
    const unsubscribeTranscript = window.electronAPI?.onTranscript((data) => {
      console.log('📨 [RENDERER] Received transcript event from main process:', data)
      displayTranscript(data.text, data.isFinal, data.source, data)
    })

    const unsubscribeSpeakerConnected = window.electronAPI?.onSpeakerConnected((connected) => {
      setSpeakerStatus({
        text: connected ? 'Recording' : 'Ready',
        className: connected ? 'recording' : ''
      })
    })

    const unsubscribeSpeakerError = window.electronAPI?.onSpeakerError((error) => {
      setSpeakerStatus({ text: `Error: ${error}`, className: 'error' })
      console.error('Speaker error:', error)
    })

    // Listen for audio capture warnings
    const handleAudioWarning = (event) => {
      const warning = event.detail?.message || 'Audio capture warning'
      console.warn('Audio capture warning:', warning)

      setSpeakerStatus((prev) => {
        if (prev.className !== 'error') {
          const originalText = prev.text

          // Set warning status
          setTimeout(() => {
            setSpeakerStatus((current) => {
              if (current.className === 'recording' || current.className === 'connected') {
                return {
                  text: originalText.replace('⚠️ ', ''),
                  className: current.className
                }
              }
              return current
            })
          }, 5000)

          return { text: '⚠️ ' + warning, className: 'error' }
        }
        return prev
      })
    }

    window.addEventListener('audio-capture-warning', handleAudioWarning)

    // Cleanup
    return () => {
      unsubscribeTranscript?.()
      unsubscribeSpeakerConnected?.()
      unsubscribeSpeakerError?.()
      window.removeEventListener('audio-capture-warning', handleAudioWarning)
    }
  }, [displayTranscript, addSystemMessage])

  // Update connection status when recording state changes
  useEffect(() => {
    const micRecording = micStatus.className === 'recording'
    const speakerRecording = speakerStatus.className === 'recording'
    setConnectionStatus(micRecording || speakerRecording ? 'Recording' : 'Ready')
  }, [micStatus.className, speakerStatus.className])

  const saveApiKey = () => {
    const apiKey = apiKeyInput.trim()
    if (!apiKey) {
      alert('Please enter a Deepgram API key')
      return
    }

    setDeepgramApiKey(apiKey)
    localStorage.setItem('deepgramApiKey', apiKey)

    // Initialize Deepgram
    window.electronAPI?.initializeDeepgram(apiKey).then((result) => {
      if (result.success) {
        alert('API key saved and Deepgram initialized successfully!')
        setApiKeyInput('')
      } else {
        alert(`Error initializing Deepgram: ${result.error}`)
      }
    })
  }

  const handleApiKeyKeyPress = (e) => {
    if (e.key === 'Enter') {
      saveApiKey()
    }
  }

  // Unified start function - starts both microphone and speaker
  const startAll = async () => {
    if (!deepgramApiKey) {
      alert('Please enter and save your Deepgram API key first')
      return
    }

    // Reset transcript tracking for new session
    resetSpeakerTranscriptTracking()

    // Reset mute state
    setIsMicrophoneMuted(false)
    isMicrophoneMutedRef.current = false

    // Clear chat messages
    setMessages([])

    try {
      // Update UI state
      setIsRecording(true)
      setMuteButtonDisabled(false)
      setShowHelpText(false)

      // Start microphone with LiveKit
      setMicStatus({ text: 'Starting...', className: 'recording' })

      try {
        // Generate access token for LiveKit from main process
        const participantIdentity = `user-${Date.now()}`
        const tokenResult = await window.electronAPI?.generateLiveKitToken(
          'recording-room',
          participantIdentity,
          'Recording User'
        )

        if (!tokenResult?.success || !tokenResult.token || !tokenResult.wssUrl) {
          throw new Error(
            tokenResult?.error || 'Failed to generate LiveKit token. Please check your .env file.'
          )
        }

        // Create and connect to LiveKit room
        const room = new Room()
        liveKitRoom.current = room

        // Set up event handler for local track published (must be before connecting)
        room.on(RoomEvent.LocalTrackPublished, async (trackPublication) => {
          if (trackPublication.track?.kind === 'audio') {
            console.log('🔊 [LiveKit] localTrackPublished event fired at', new Date().toISOString())
            console.log('🔊 [LiveKit] Track publication:', trackPublication)
            try {
              if (!isKrispNoiseFilterSupported()) {
                console.warn('Krisp noise filter is currently not supported on this browser')
                // Continue without Krisp filter
                const processedAudioTrack = trackPublication.track?.mediaStreamTrack
                if (processedAudioTrack) {
                  const settings = processedAudioTrack.getSettings()
                  const sampleRate = settings.sampleRate || 48000
                  processAudioTrackForDeepgram(processedAudioTrack, sampleRate)
                  setMicStatus({ text: 'Recording', className: 'recording' })
                }
                return
              }

              // Check if audio context is available before creating the noise filter
              if (!isAudioContextAvailable()) {
                console.warn(
                  'Audio context not available, skipping Krisp noise filter initialization'
                )
                // Continue without Krisp filter
                const processedAudioTrack = trackPublication.track?.mediaStreamTrack
                if (processedAudioTrack) {
                  const settings = processedAudioTrack.getSettings()
                  const sampleRate = settings.sampleRate || 48000
                  processAudioTrackForDeepgram(processedAudioTrack, sampleRate)
                  setMicStatus({ text: 'Recording', className: 'recording' })
                }
                return
              }

              // Ensure we have a valid audio track before proceeding
              if (!trackPublication.track || !trackPublication.track.mediaStreamTrack) {
                console.warn('Audio track not available for noise filter processing')
                return
              }

              // Once instantiated, the filter will begin initializing and will download additional resources
              console.log('🔊 [Krisp] Creating Krisp noise filter processor...')
              const krispProcessor = KrispNoiseFilter()
              liveKitKrispProcessor.current = krispProcessor

              // Check if the processor was created successfully
              if (!krispProcessor) {
                console.warn('Failed to create Krisp noise filter processor')
                // Continue without Krisp filter
                const processedAudioTrack = trackPublication.track?.mediaStreamTrack
                if (processedAudioTrack) {
                  const settings = processedAudioTrack.getSettings()
                  const sampleRate = settings.sampleRate || 48000
                  processAudioTrackForDeepgram(processedAudioTrack, sampleRate)
                  setMicStatus({ text: 'Recording', className: 'recording' })
                }
                return
              }

              console.log('🔊 [Krisp] Setting processor on track...')
              await trackPublication.track?.setProcessor(krispProcessor)

              // To enable/disable the noise filter, use setEnabled()
              console.log('🔊 [Krisp] Enabling Krisp noise filter...')
              await krispProcessor.setEnabled(true)
              console.log('✅ [Krisp] Krisp noise filter enabled')

              const processedAudioTrack = trackPublication?.track?.mediaStreamTrack
              if (processedAudioTrack) {
                const settings = processedAudioTrack.getSettings()
                const sampleRate = settings.sampleRate || 48000
                console.log(`🔊 [Krisp] Processed audio track sample rate: ${sampleRate}Hz`)
                processAudioTrackForDeepgram(processedAudioTrack, sampleRate)
                setMicStatus({ text: 'Recording', className: 'recording' })
              } else {
                console.warn('⚠️ [Krisp] No processed audio track available')
              }
            } catch (error) {
              console.error('Failed to initialize Krisp noise filter:', error)
              // Continue without noise filter rather than breaking the audio
              const processedAudioTrack = trackPublication.track?.mediaStreamTrack
              if (processedAudioTrack) {
                const settings = processedAudioTrack.getSettings()
                const sampleRate = settings.sampleRate || 48000
                processAudioTrackForDeepgram(processedAudioTrack, sampleRate)
                setMicStatus({ text: 'Recording', className: 'recording' })
              }
            }
          }
        })

        // Connect to room first
        await room.connect(tokenResult.wssUrl, tokenResult.token)
        console.log('✅ Connected to LiveKit room')

        // Get user media and enable microphone (this will automatically publish the track)
        await room.localParticipant.enableCameraAndMicrophone(false, true)
        console.log('✅ Microphone track published to LiveKit')
      } catch (error) {
        console.error('Error starting microphone with LiveKit:', error)
        setMicStatus({ text: 'Error', className: 'error' })
        showError(`Failed to start microphone: ${error.message || error}`)
        setIsRecording(false)
        setMuteButtonDisabled(true)
      }

      // Start speaker
      setSpeakerStatus({ text: 'Starting...', className: 'recording' })

      // Check if we're in Electron (native capture) or browser (fallback)
      const isElectron = typeof window !== 'undefined' && window.electronAPI

      if (isElectron) {
        // In Electron: Use native audio capture module (speaker_audio_capture.mm)
        // This uses macOS ScreenCaptureKit for automatic system audio capture
        // No user interaction required - direct OS-level access
        const speakerResult = await window.electronAPI.startSpeakerCapture(deepgramApiKey)
        if (!speakerResult?.success) {
          console.error(`Error starting speaker: ${speakerResult?.error}`)
          setSpeakerStatus({ text: 'Error', className: 'error' })
        } else {
          // Native capture is handled entirely in main process
          // Audio flows: ScreenCaptureKit → native module → main.js → Deepgram
          // Status will be updated via onSpeakerConnected event when WebSocket is ready
          console.log(
            '✅ Native speaker capture started in Electron (using speaker_audio_capture.mm)'
          )
        }
      } else {
        // Browser fallback not supported - LiveKit is required
        console.warn('Speaker capture requires Electron environment')
        setSpeakerStatus({ text: 'Error', className: 'error' })
      }

      // Check for audio after 5 seconds
      setTimeout(() => {
        setMessages((currentMessages) => {
          const hasTranscripts = currentMessages.some(
            (msg) => msg.source === 'speaker' && msg.isFinal
          )
          setSpeakerStatus((currentStatus) => {
            if (!hasTranscripts && currentStatus.className === 'recording') {
              console.warn('⚠️ No speaker audio detected after 5 seconds')
            }
            return currentStatus
          })
          return currentMessages
        })
      }, 5000)
    } catch (error) {
      console.error('Error starting recording:', error)
      showError(`Error: ${error.message}`)
      // Re-enable start button if there was an error
      setIsRecording(false)
      setMuteButtonDisabled(true)
    }
  }

  // Unified stop function - stops both microphone and speaker
  const stopAll = async () => {
    try {
      // Stop LiveKit room and cleanup
      if (liveKitRoom.current) {
        try {
          // Disable tracks
          liveKitRoom.current.localParticipant.setMicrophoneEnabled(false)
          // Disconnect from room
          await liveKitRoom.current.disconnect()
          console.log('✅ Disconnected from LiveKit room')
        } catch (error) {
          console.error('Error disconnecting from LiveKit:', error)
        }
        liveKitRoom.current = null
      }

      // Clean up audio processors
      if (liveKitAudioProcessor.current) {
        liveKitAudioProcessor.current.disconnect()
        liveKitAudioProcessor.current = null
      }

      if (liveKitAudioContext.current) {
        await liveKitAudioContext.current.close().catch(console.error)
        liveKitAudioContext.current = null
      }

      // Clean up Krisp processor
      if (liveKitKrispProcessor.current) {
        try {
          await liveKitKrispProcessor.current.setEnabled(false)
        } catch (error) {
          console.error('Error disabling Krisp processor:', error)
        }
        liveKitKrispProcessor.current = null
      }

      // Stop microphone (handled by LiveKit cleanup above)
      setMicStatus({ text: 'Ready', className: '' })

      // Stop speaker
      await window.electronAPI?.stopSpeakerCapture()
      setSpeakerStatus({ text: 'Ready', className: '' })

      // Update UI state
      setIsRecording(false)
      setMuteButtonDisabled(true)

      // Reset mute state
      setIsMicrophoneMuted(false)

      // Show help text again
      setShowHelpText(true)
    } catch (error) {
      console.error('Error stopping recording:', error)
      showError(`Error stopping: ${error.message}`)
    }
  }

  // Toggle microphone mute
  const toggleMute = () => {
    const newMutedState = !isMicrophoneMuted
    setIsMicrophoneMuted(newMutedState)
    isMicrophoneMutedRef.current = newMutedState

    // Update status
    if (newMutedState) {
      setMicStatus({ text: 'Muted', className: 'error' })
      console.log('🔇 Microphone muted')
      addSystemMessage('🔇 Microphone muted - not transcribing')
    } else {
      setMicStatus({ text: 'Recording', className: 'recording' })
      console.log('🎤 Microphone unmuted')
      addSystemMessage('🎤 Microphone unmuted - transcribing resumed')
    }
  }

  // Auto-scroll chat messages to bottom
  useEffect(() => {
    if (chatMessagesRef.current) {
      chatMessagesRef.current.scrollTop = chatMessagesRef.current.scrollHeight
    }
  }, [messages])

  const showError = (message) => {
    // Use a more user-friendly error display
    alert(message)
    // Could be replaced with a custom modal for better UX
  }

  return (
    <div className="app-container">
      <header>
        <div className="logo-section">
          <h1>🎙️ Surge Audio</h1>
          <p className="subtitle">Professional Audio Transcription</p>
        </div>
        <div className={`status-pill ${connectionStatus === 'Recording' ? 'active' : ''}`}>
          {connectionStatus}
        </div>
      </header>

      <main>
        <div className="config-section">
          <div className="input-group">
            <label htmlFor="apiKey">Deepgram API Key</label>
            <div className="input-wrapper">
              <input
                type="password"
                id="apiKey"
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                onKeyPress={handleApiKeyKeyPress}
                placeholder="sk-..."
              />
              <button className="btn-icon" title="Save Key" onClick={saveApiKey}>
                <img src={saveKeyIcon} height={16} width={16} alt="saveKeyIcon" />
              </button>
            </div>
          </div>
        </div>

        <div className="unified-controls">
          <div className="control-header">
            <div className="status-indicators">
              <div className="status-item">
                <img src={statusItem1Icon} height={16} width={16} alt="statusItem1Icon" />
                <span>Microphone</span>
                <div className={`status-badge ${micStatus.className}`}>{micStatus.text}</div>
              </div>
              <div className="status-item">
                <img src={statusItem2Icon} height={16} width={16} alt="statusItem2Icon" />
                <span>Speaker</span>
                <div className={`status-badge ${speakerStatus.className}`}>
                  {speakerStatus.text}
                </div>
              </div>
            </div>
            <div className="control-buttons">
              <button
                className="btn btn-primary btn-large"
                onClick={startAll}
                disabled={isRecording}
              >
                <img src={startAllIcon} height={16} width={16} alt="startAllIcon" />
                Start Recording
              </button>
              <button
                className={`btn btn-secondary btn-icon-large ${isMicrophoneMuted ? 'muted' : ''}`}
                disabled={muteButtonDisabled}
                title={isMicrophoneMuted ? 'Unmute Microphone' : 'Mute Microphone'}
                onClick={toggleMute}
              >
                {isMicrophoneMuted ? (
                  <img src={unmuteMicIcon} height={16} width={16} alt="unmuteMicIcon" />
                ) : (
                  <img src={muteMicIcon} height={16} width={16} alt="muteMicIcon" />
                )}
              </button>
              <button
                className="btn btn-danger btn-large"
                onClick={stopAll}
                disabled={!isRecording}
              >
                <img src={stopRecordingIcon} height={16} width={16} alt="stopRecordingIcon" />
                Stop Recording
              </button>
            </div>
          </div>
          {showHelpText && (
            <div className="help-text">
              Requires screen sharing permission to capture system audio.
            </div>
          )}
        </div>

        <div className="chat-container">
          <div className="chat-header">
            <div className="chat-legend">
              <div className="legend-item">
                <div className="legend-bubble user-bubble-legend"></div>
                <img src={userBubbleIcon} height={14} width={14} alt="userBubbleIcon" />
                <span>My Audio</span>
              </div>
              <div className="legend-item">
                <div className="legend-bubble speaker-bubble-legend"></div>
                <img src={speakerBubbleIcon} height={14} width={14} alt="speakerBubbleIcon" />
                <span>Speaker Audio</span>
              </div>
            </div>
          </div>
          <div ref={chatMessagesRef} className="chat-messages">
            {messages.length === 0 ? (
              <div className="empty-state">
                Start recording to see transcriptions appear here...
              </div>
            ) : (
              messages.map((msg) => {
                if (msg.type === 'system') {
                  return (
                    <div key={msg.id} className="system-message">
                      {msg.text}
                    </div>
                  )
                } else {
                  return (
                    <div
                      key={msg.id}
                      className={`message ${msg.isFinal ? '' : 'interim'} ${
                        msg.source === 'microphone' ? 'user-message' : 'speaker-message'
                      }`}
                      data-source={msg.source}
                    >
                      <span className={msg.isFinal ? 'final' : 'interim'}>{msg.text}</span>
                    </div>
                  )
                }
              })
            )}
          </div>
        </div>
      </main>
    </div>
  )
}

export default RecordingPage
