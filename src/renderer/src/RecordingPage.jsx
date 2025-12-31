import { useState, useEffect, useRef, useCallback } from 'react'
import muteMicIcon from './assets/svg/muteMic.svg'
import saveKeyIcon from './assets/svg/savekey.svg'
import speakerBubbleIcon from './assets/svg/speakerBubble.svg'
import startAllIcon from './assets/svg/startAll.svg'
import statusItem1Icon from './assets/svg/status-item-1.svg'
import statusItem2Icon from './assets/svg/status-item-2.svg'
import stopRecordingIcon from './assets/svg/stopRecording.svg'
import unmuteMicIcon from './assets/svg/unmuteMic.svg'
import userBubbleIcon from './assets/svg/user-bubble.svg'
// Import AudioCapture to make it available on window object
import '../audioCapture.js'

const RecordingPage = () => {
  // React refs for instance values
  const audioCapture = useRef(null)
  const speakerTranscripts = useRef(new Map())
  const lastDisplayedText = useRef('')

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
  const [helpText, setHelpText] = useState(
    'Requires screen sharing permission to capture system audio.'
  )
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

  // Initialize on component mount
  useEffect(() => {
    // Initialize AudioCapture
    if (window.AudioCapture) {
      audioCapture.current = new window.AudioCapture()
    }

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

    // Check system audio support
    if (
      audioCapture.current &&
      typeof audioCapture.current.checkSystemAudioSupport === 'function'
    ) {
      const support = audioCapture.current.checkSystemAudioSupport()
      console.log('System audio support check:', support)

      if (!support.supported) {
        setHelpText(`⚠️ System audio capture not supported: ${support.message}`)
      }
    }

    // Setup event listeners
    const unsubscribeTranscript = window.electronAPI?.onTranscript((data) => {
      console.log('📨 [RENDERER] Received transcript event from main process:', data)
      displayTranscript(data.text, data.isFinal, data.source, data)
    })

    const unsubscribeMicConnected = window.electronAPI?.onMicrophoneConnected((connected) => {
      setMicStatus({
        text: connected ? 'Recording' : 'Ready',
        className: connected ? 'recording' : ''
      })
    })

    const unsubscribeSpeakerConnected = window.electronAPI?.onSpeakerConnected((connected) => {
      setSpeakerStatus({
        text: connected ? 'Recording' : 'Ready',
        className: connected ? 'recording' : ''
      })
    })

    const unsubscribeMicError = window.electronAPI?.onMicrophoneError((error) => {
      setMicStatus({ text: `Error: ${error}`, className: 'error' })
      console.error('Microphone error:', error)
    })

    const unsubscribeSpeakerError = window.electronAPI?.onSpeakerError((error) => {
      setSpeakerStatus({ text: `Error: ${error}`, className: 'error' })
      console.error('Speaker error:', error)
    })

    const unsubscribeMicAppDetected = window.electronAPI?.onMicrophoneAppDetected((appName) => {
      console.log(`🎤 App using microphone detected: ${appName}`)
      addSystemMessage(`🎤 ${appName} is using the microphone`)
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
      unsubscribeMicConnected?.()
      unsubscribeSpeakerConnected?.()
      unsubscribeMicError?.()
      unsubscribeSpeakerError?.()
      unsubscribeMicAppDetected?.()
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

    // Clear chat messages
    setMessages([])

    try {
      // Update UI state
      setIsRecording(true)
      setMuteButtonDisabled(false)
      setShowHelpText(false)

      // Start microphone
      setMicStatus({ text: 'Starting...', className: 'recording' })

      // Ensure AudioCapture is initialized
      if (!audioCapture.current) {
        if (window.AudioCapture) {
          audioCapture.current = new window.AudioCapture()
        } else {
          console.error('AudioCapture class not available on window object')
          setMicStatus({ text: 'Error: AudioCapture not available', className: 'error' })
          showError(
            'AudioCapture module is not available. Please check if the native module is properly built.'
          )
          setIsRecording(false)
          setMuteButtonDisabled(true)
          return
        }
      }

      const micResult = await window.electronAPI?.startMicrophoneCapture(deepgramApiKey)
      if (!micResult?.success) {
        console.error(`Error starting microphone: ${micResult?.error || 'Unknown error'}`)
        setMicStatus({ text: 'Error', className: 'error' })
        setIsRecording(false)
        setMuteButtonDisabled(true)
      } else {
        try {
          const audioResult = await audioCapture.current.startMicrophoneCapture(
            (audioData, source, sampleRate) => {
              window.electronAPI?.sendAudioData(audioData, source, sampleRate)
            }
          )
          if (audioResult && audioResult.success) {
            setMicStatus({ text: 'Recording', className: 'recording' })
          } else {
            const errorMsg = audioResult?.error || 'Unknown error starting audio capture'
            console.error(`Error starting microphone audio: ${errorMsg}`, audioResult)
            setMicStatus({ text: 'Error', className: 'error' })
            showError(`Failed to start microphone audio capture: ${errorMsg}`)
            setIsRecording(false)
            setMuteButtonDisabled(true)
          }
        } catch (error) {
          console.error('Exception starting microphone audio:', error)
          setMicStatus({ text: 'Error', className: 'error' })
          showError(`Exception starting microphone audio: ${error.message || error}`)
          setIsRecording(false)
          setMuteButtonDisabled(true)
        }
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
        // In browser: Use browser-based fallback (getDisplayMedia API)
        // This requires user interaction to select audio source in sharing dialog
        // Fallback path for when running in actual browser (not Electron)
        // eslint-disable-next-line no-unused-vars
        const audioResult = await audioCapture.current?.startSpeakerCapture((audioData, source) => {
          // In browser, audio would need to be sent to a different endpoint
          // This is the fallback path for non-Electron environments
          // Parameters unused in fallback mode
          void audioData
          void source
          console.log('Browser-based speaker capture (fallback mode)')
        })
        if (audioResult?.success) {
          setSpeakerStatus({ text: 'Recording', className: 'recording' })
        } else {
          showError(
            `Speaker capture may not work:\n\n${audioResult?.error}\n\n` +
              `Make sure to:\n` +
              `1. Grant screen recording permission\n` +
              `2. Select an audio source in the sharing dialog\n` +
              `3. Check "Share audio" or "Share system audio"\n\n` +
              `Microphone will continue working.`
          )
          setSpeakerStatus({ text: 'Error', className: 'error' })
        }
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
      // Stop microphone
      audioCapture.current?.stopMicrophoneCapture()
      await window.electronAPI?.stopMicrophoneCapture()
      setMicStatus({ text: 'Ready', className: '' })

      // Stop speaker
      audioCapture.current?.stopSpeakerCapture()
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

    // Update AudioCapture mute state
    if (audioCapture.current) {
      audioCapture.current.setMicrophoneMuted(newMutedState)
    }

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
            <div className={`help-text ${helpText.includes('⚠️') ? 'error-message' : ''}`}>
              {helpText}
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
