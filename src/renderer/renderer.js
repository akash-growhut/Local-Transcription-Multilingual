// Main renderer process logic

let audioCapture;
let deepgramApiKey = "";
let microphoneTranscript = "";
let speakerTranscript = "";
let isMicrophoneMuted = false;

// Deduplication: Track recent speaker transcripts to filter echo from mic
// When not using headphones, mic picks up speaker audio - we filter it out
const recentSpeakerTexts = [];
const DEDUPE_WINDOW_MS = 2000; // 2 second window for deduplication
const DEDUPE_SIMILARITY_THRESHOLD = 0.85; // 85% similarity = very likely echo (less aggressive)

// Initialize on page load
document.addEventListener("DOMContentLoaded", () => {
  audioCapture = new AudioCapture();
  initializeUI();
  setupEventListeners();
  loadSavedApiKey();
  updatePlatformInfo();
});

function initializeUI() {
  // Set up status indicators
  updateStatus("micStatus", "Not connected", "");
  updateStatus("speakerStatus", "Not connected", "");

  // Clear chat messages
  const chatMessages = document.getElementById("chatMessages");
  if (chatMessages) {
    chatMessages.innerHTML =
      '<div class="empty-state">Start recording to see transcriptions appear here...</div>';
  }
}

function setupEventListeners() {
  // API Key management
  document.getElementById("saveKey").addEventListener("click", saveApiKey);
  document.getElementById("apiKey").addEventListener("keypress", (e) => {
    if (e.key === "Enter") saveApiKey();
  });

  // Unified controls - Start both mic and speaker
  document.getElementById("startAll").addEventListener("click", startAll);
  document.getElementById("stopAll").addEventListener("click", stopAll);

  // Mute button
  document.getElementById("muteMic").addEventListener("click", toggleMute);

  // Listen for transcript events (including file-based transcripts)
  window.electronAPI.onTranscript((data) => {
    console.log(
      "📨 [RENDERER] Received transcript event from main process:",
      data
    );
    displayTranscript(data.text, data.isFinal, data.source, data);
  });

  // Listen for Deepgram events
  window.electronAPI.onMicrophoneConnected((connected) => {
    updateStatus(
      "micStatus",
      connected ? "Recording" : "Ready",
      connected ? "recording" : ""
    );
  });

  window.electronAPI.onSpeakerConnected((connected) => {
    updateStatus(
      "speakerStatus",
      connected ? "Recording" : "Ready",
      connected ? "recording" : ""
    );
  });

  window.electronAPI.onMicrophoneError((error) => {
    updateStatus("micStatus", `Error: ${error}`, "error");
    console.error("Microphone error:", error);
  });

  window.electronAPI.onSpeakerError((error) => {
    updateStatus("speakerStatus", `Error: ${error}`, "error");
    console.error("Speaker error:", error);
  });

  // Listen for speaker audio energy (for echo suppression when not using headphones)
  window.electronAPI.onSpeakerAudioEnergy((rms) => {
    if (audioCapture) {
      audioCapture.updateSpeakerEnergy(rms);
    }
  });

  // NOTE: onTranscript listener already registered above (line 47-50), removing duplicate

  // Listen for audio capture warnings
  window.addEventListener("audio-capture-warning", (event) => {
    const warning = event.detail?.message || "Audio capture warning";
    console.warn("Audio capture warning:", warning);

    // Show warning in UI
    const speakerStatus = document.getElementById("speakerStatus");
    if (speakerStatus && !speakerStatus.classList.contains("error")) {
      const originalText = speakerStatus.textContent;
      updateStatus("speakerStatus", "⚠️ " + warning, "error");

      // Reset after 5 seconds if still connected
      setTimeout(() => {
        if (
          speakerStatus.classList.contains("connected") ||
          speakerStatus.classList.contains("recording")
        ) {
          updateStatus(
            "speakerStatus",
            originalText.replace("⚠️ ", ""),
            speakerStatus.classList.contains("recording")
              ? "recording"
              : "connected"
          );
        }
      }, 5000);
    }
  });
}

function updateStatus(elementId, text, className) {
  const element = document.getElementById(elementId);
  element.textContent = text;
  // Preserve base class 'status-badge'
  element.className = "status-badge " + className;
}

function saveApiKey() {
  const apiKeyInput = document.getElementById("apiKey");
  const apiKey = apiKeyInput.value.trim();
  
  if (!apiKey) {
    alert("Please enter a Deepgram API key");
    return;
  }

  deepgramApiKey = apiKey;
  localStorage.setItem("deepgramApiKey", apiKey);

  // Initialize Deepgram
  window.electronAPI.initializeDeepgram(apiKey).then((result) => {
    if (result.success) {
      // Show masked key to indicate it's saved
      apiKeyInput.value = maskApiKey(apiKey);
      apiKeyInput.setAttribute("data-saved", "true");
      console.log("✅ API key saved and Deepgram initialized");
    } else {
      alert(`Error initializing Deepgram: ${result.error}`);
    }
  });
}

function maskApiKey(key) {
  if (!key || key.length < 8) return key;
  return key.substring(0, 4) + "..." + key.substring(key.length - 4);
}

function loadSavedApiKey() {
  const savedKey = localStorage.getItem("deepgramApiKey");
  const apiKeyInput = document.getElementById("apiKey");
  
  if (savedKey) {
    deepgramApiKey = savedKey;
    // Show masked version in input
    apiKeyInput.value = maskApiKey(savedKey);
    apiKeyInput.setAttribute("data-saved", "true");
    
    // Initialize Deepgram automatically
    window.electronAPI.initializeDeepgram(savedKey).then((result) => {
      if (result.success) {
        console.log("✅ Deepgram initialized with saved API key");
      } else {
        console.error("Failed to initialize Deepgram:", result.error);
        // Clear the saved key if it's invalid
        apiKeyInput.value = "";
        apiKeyInput.removeAttribute("data-saved");
      }
    });
  }
}

// Clear masked key when user focuses on input to enter a new key
document.addEventListener("DOMContentLoaded", () => {
  const apiKeyInput = document.getElementById("apiKey");
  if (apiKeyInput) {
    apiKeyInput.addEventListener("focus", () => {
      if (apiKeyInput.getAttribute("data-saved") === "true") {
        apiKeyInput.value = "";
        apiKeyInput.removeAttribute("data-saved");
      }
    });
    
    // If user clicks away without entering anything, restore masked key
    apiKeyInput.addEventListener("blur", () => {
      if (apiKeyInput.value === "" && deepgramApiKey) {
        apiKeyInput.value = maskApiKey(deepgramApiKey);
        apiKeyInput.setAttribute("data-saved", "true");
      }
    });
  }
});

// Unified start function - starts both microphone and speaker
async function startAll() {
  if (!deepgramApiKey || deepgramApiKey.length < 10) {
    alert("Please enter your Deepgram API key and click the Save button first.\n\nThe API key should look like: 0107cf2f62345e007fbaf64e27bd7f4923c6a735");
    document.getElementById("apiKey").focus();
    return;
  }

  // Reset transcript tracking for new session
  resetSpeakerTranscriptTracking();

  // Reset mute state
  isMicrophoneMuted = false;

  // Keep previous chat messages - only remove empty state if exists
  const chatMessages = document.getElementById("chatMessages");
  if (chatMessages) {
    const emptyState = chatMessages.querySelector(".empty-state");
    if (emptyState) emptyState.remove();
    
    // Remove any interim messages from previous session
    chatMessages.querySelectorAll(".interim").forEach(el => el.remove());
    
    // Add separator if there are existing messages
    if (chatMessages.children.length > 0) {
      const separator = document.createElement("div");
      separator.className = "session-separator";
      separator.innerHTML = `<span>New Session - ${new Date().toLocaleTimeString()}</span>`;
      chatMessages.appendChild(separator);
    }
  }

  try {
    // Disable start button, enable stop and mute buttons
    document.getElementById("startAll").disabled = true;
    document.getElementById("stopAll").disabled = false;
    document.getElementById("muteMic").disabled = false;

    // Hide help text when recording
    const helpText = document.getElementById("speakerHelp");
    if (helpText) helpText.style.display = "none";

    // Start microphone
    updateStatus("micStatus", "Starting...", "recording");
    const micResult = await window.electronAPI.startMicrophoneCapture(
      deepgramApiKey
    );
    if (!micResult.success) {
      console.error(`Error starting microphone: ${micResult.error}`);
      updateStatus("micStatus", "Error", "error");
    } else {
      const audioResult = await audioCapture.startMicrophoneCapture(
        (audioData, source, sampleRate) => {
          window.electronAPI.sendAudioData(audioData, source, sampleRate);
        }
      );
      if (audioResult.success) {
        updateStatus("micStatus", "Recording", "recording");
      } else {
        console.error(`Error starting microphone audio: ${audioResult.error}`);
        updateStatus("micStatus", "Error", "error");
      }
    }

    // Start speaker
    updateStatus("speakerStatus", "Starting...", "recording");
    const speakerResult = await window.electronAPI.startSpeakerCapture(
      deepgramApiKey
    );
    if (!speakerResult.success) {
      console.error(`Error starting speaker: ${speakerResult.error}`);
      updateStatus("speakerStatus", "Error", "error");
    } else {
      const audioResult = await audioCapture.startSpeakerCapture(
        (audioData, source) => {
          window.electronAPI.sendAudioData(audioData, source);
        }
      );
      if (audioResult.success) {
        updateStatus("speakerStatus", "Recording", "recording");
      } else {
        // Show error message but don't stop everything
        showError(
          `Speaker capture may not work:\n\n${audioResult.error}\n\n` +
            `Make sure to:\n` +
            `1. Grant screen recording permission (macOS)\n` +
            `2. Select an audio source in the sharing dialog\n` +
            `3. Check "Share audio" or "Share system audio"\n\n` +
            `Microphone will continue working.`
        );
        updateStatus("speakerStatus", "Error", "error");
      }
    }

    // Check for audio after 5 seconds
    setTimeout(() => {
      const chatMessages = document.getElementById("chatMessages");
      const hasTranscripts =
        chatMessages &&
        chatMessages.querySelectorAll(".speaker-message").length > 0;

      if (
        !hasTranscripts &&
        document.getElementById("speakerStatus").classList.contains("recording")
      ) {
        console.warn("⚠️ No speaker audio detected after 5 seconds");
      }
    }, 5000);
  } catch (error) {
    console.error("Error starting recording:", error);
    showError(`Error: ${error.message}`);
    // Re-enable start button if there was an error
    document.getElementById("startAll").disabled = false;
    document.getElementById("stopAll").disabled = true;
  }
}

// Unified stop function - stops both microphone and speaker
async function stopAll() {
  try {
    // Stop microphone
    audioCapture.stopMicrophoneCapture();
    await window.electronAPI.stopMicrophoneCapture();
    updateStatus("micStatus", "Ready", "");

    // Stop speaker
    audioCapture.stopSpeakerCapture();
    await window.electronAPI.stopSpeakerCapture();
    updateStatus("speakerStatus", "Ready", "");

    // Update buttons
    document.getElementById("startAll").disabled = false;
    document.getElementById("stopAll").disabled = true;
    document.getElementById("muteMic").disabled = true;

    // Reset mute state and button
    isMicrophoneMuted = false;
    updateMuteButton();

    // Show help text again
    const helpText = document.getElementById("speakerHelp");
    if (helpText) helpText.style.display = "block";
  } catch (error) {
    console.error("Error stopping recording:", error);
    showError(`Error stopping: ${error.message}`);
  }
}

// Toggle microphone mute
function toggleMute() {
  isMicrophoneMuted = !isMicrophoneMuted;

  // Update AudioCapture mute state
  if (audioCapture) {
    audioCapture.setMicrophoneMuted(isMicrophoneMuted);
  }

  // Update UI
  updateMuteButton();

  // Update status
  if (isMicrophoneMuted) {
    updateStatus("micStatus", "Muted", "error");
    console.log("🔇 Microphone muted");
    // Add system message to chat
    addSystemMessage("🔇 Microphone muted - not transcribing");
  } else {
    updateStatus("micStatus", "Recording", "recording");
    console.log("🎤 Microphone unmuted");
    // Add system message to chat
    addSystemMessage("🎤 Microphone unmuted - transcribing resumed");
  }
}

// Add system message to chat
function addSystemMessage(text) {
  const chatMessages = document.getElementById("chatMessages");
  if (!chatMessages) return;

  const systemMsg = document.createElement("div");
  systemMsg.className = "system-message";
  systemMsg.textContent = text;
  chatMessages.appendChild(systemMsg);

  // Auto-scroll to bottom
  chatMessages.scrollTop = chatMessages.scrollHeight;

  // Remove system message after 3 seconds
  setTimeout(() => {
    if (systemMsg.parentNode) {
      systemMsg.style.opacity = "0";
      setTimeout(() => systemMsg.remove(), 300);
    }
  }, 3000);
}

// Update mute button appearance
function updateMuteButton() {
  const muteBtn = document.getElementById("muteMic");
  const muteIcon = document.getElementById("muteIcon");
  const unmuteIcon = document.getElementById("unmuteIcon");

  if (isMicrophoneMuted) {
    muteBtn.classList.add("muted");
    muteBtn.title = "Unmute Microphone";
    muteIcon.style.display = "none";
    unmuteIcon.style.display = "block";
  } else {
    muteBtn.classList.remove("muted");
    muteBtn.title = "Mute Microphone";
    muteIcon.style.display = "block";
    unmuteIcon.style.display = "none";
  }
}

function showError(message) {
  // Use a more user-friendly error display
  alert(message);
  // Could be replaced with a custom modal for better UX
}

// Store transcripts by file index for sequential display
let speakerTranscripts = new Map();
let lastDisplayedText = ""; // Track last displayed text for capitalization

// Reset transcript tracking when starting new capture
function resetSpeakerTranscriptTracking() {
  speakerTranscripts.clear();
  lastDisplayedText = "";
}

// Function to lowercase first word if continuing from previous transcript
function adjustCapitalization(text, previousText) {
  if (!previousText) {
    // First transcript, keep as is
    return text;
  }

  // Check if previous transcript ended with sentence-ending punctuation
  const endsWithPunctuation = /[.!?]\s*$/.test(previousText.trim());

  if (endsWithPunctuation) {
    // Previous sentence ended, keep capitalization
    return text;
  }

  // Previous sentence continues, lowercase first word
  if (text.length > 0) {
    return text.charAt(0).toLowerCase() + text.slice(1);
  }

  return text;
}

// Function to display transcripts in sequential order
function displaySequentialTranscripts() {
  console.log(`🔍 [displaySequentialTranscripts] Starting...`);
  const chatMessages = document.getElementById("chatMessages");
  if (!chatMessages) {
    console.error("❌ chatMessages element not found!");
    return;
  }
  console.log(`✅ Found chatMessages element`);

  let displayedAny = false;

  // Keep displaying transcripts while we have any available
  while (speakerTranscripts.size > 0) {
    // Get all available indices, sorted
    const sortedIndices = Array.from(speakerTranscripts.keys()).sort(
      (a, b) => a - b
    );

    // Always take the first (lowest) index
    const currentIndex = sortedIndices[0];
    const transcriptData = speakerTranscripts.get(currentIndex);

    if (!transcriptData) {
      console.log(`⚠️ Transcript ${currentIndex} exists but has no data`);
      speakerTranscripts.delete(currentIndex);
      continue;
    }

    // Adjust capitalization based on previous transcript
    const adjustedText = adjustCapitalization(
      transcriptData.text,
      lastDisplayedText
    );

    console.log(`✅ Displaying transcript ${currentIndex}: "${adjustedText}"`);

    // Remove empty state if exists
    const emptyState = chatMessages.querySelector(".empty-state");
    if (emptyState) {
      emptyState.remove();
    }

    // Display the transcript as a message bubble (speaker message on the right)
    const messageDiv = document.createElement("div");
    messageDiv.className = "message speaker-message";

    const textSpan = document.createElement("span");
    textSpan.className = "final";
    textSpan.textContent = adjustedText;

    messageDiv.appendChild(textSpan);
    chatMessages.appendChild(messageDiv);

    // Update stored transcript
    speakerTranscript += adjustedText + " ";
    lastDisplayedText = adjustedText;
    displayedAny = true;

    // Remove from map after displaying
    speakerTranscripts.delete(currentIndex);
    console.log(`🗑️ Removed transcript ${currentIndex} from queue`);
  }

  // Scroll to bottom if we displayed anything
  if (displayedAny) {
    chatMessages.scrollTop = chatMessages.scrollHeight;
    console.log(`📜 Displayed all available transcripts`);
  } else {
    console.log(`ℹ️ No new transcripts to display`);
  }
}

function displayTranscript(text, isFinal, source, eventData = null) {
  // Handle file-based transcripts (from MP3 transcription)
  if (source === "speaker" && eventData && eventData.fileIndex !== undefined) {
    const fileIndex = eventData.fileIndex;
    speakerTranscripts.set(fileIndex, {
      text: text,
      timestamp: eventData.timestamp || Date.now(),
    });
    displaySequentialTranscripts();
    return;
  }

  const chatMessages = document.getElementById("chatMessages");
  if (!chatMessages) return;

  // Clean up old entries from deduplication cache
  const now = Date.now();
  while (recentSpeakerTexts.length > 0 && now - recentSpeakerTexts[0].time > DEDUPE_WINDOW_MS) {
    recentSpeakerTexts.shift();
  }

  // DEDUPLICATION: If this is from microphone, check if it's echo from speaker
  if (source === "microphone" && isFinal && text.trim()) {
    const normalizedText = text.toLowerCase().trim();
    
    // Check if similar text was recently spoken by speaker
    for (const entry of recentSpeakerTexts) {
      const similarity = calculateSimilarity(normalizedText, entry.text.toLowerCase().trim());
      if (similarity >= DEDUPE_SIMILARITY_THRESHOLD) {
        console.log(`🔇 [DEDUPE] Filtered mic echo: "${text}" (similar to speaker: "${entry.text}", similarity: ${(similarity * 100).toFixed(0)}%)`);
        // Remove any interim for mic since we're filtering this
        const existingInterim = chatMessages.querySelector(`.interim[data-source="microphone"]`);
        if (existingInterim) existingInterim.remove();
        return; // Don't display - it's echo
      }
    }
  }

  // Track speaker transcripts for deduplication
  if (source === "speaker" && isFinal && text.trim()) {
    recentSpeakerTexts.push({ text: text, time: now });
  }

  // Remove empty state if exists
  const emptyState = chatMessages.querySelector(".empty-state");
  if (emptyState) {
    emptyState.remove();
  }

  const messageClass = source === "microphone" ? "user-message" : "speaker-message";

  if (isFinal) {
    // FINAL transcript - remove any interim for this source, add final at end
    const existingInterim = chatMessages.querySelector(`.interim[data-source="${source}"]`);
    if (existingInterim) {
      existingInterim.remove();
    }

    // Create final message with unique ID for tracking
    const messageDiv = document.createElement("div");
    messageDiv.className = `message ${messageClass} final-message`;
    messageDiv.setAttribute("data-timestamp", Date.now());
    messageDiv.innerHTML = `<span class="final">${escapeHtml(text)}</span>`;
    chatMessages.appendChild(messageDiv);
    
    console.log(`💬 [UI] Added FINAL ${source}: "${text}"`);

    // Scroll to bottom
    chatMessages.scrollTop = chatMessages.scrollHeight;

    // Update stored transcript
    if (source === "microphone") {
      microphoneTranscript += text + " ";
    } else {
      speakerTranscript += text + " ";
    }
  } else {
    // INTERIM transcript - update existing or create new at bottom
    if (!text) return;
    
    let existingInterim = chatMessages.querySelector(`.interim[data-source="${source}"]`);
    
    if (existingInterim) {
      // Update text only (no DOM manipulation)
      existingInterim.textContent = text;
    } else {
      // Create new interim at bottom
      const interimDiv = document.createElement("div");
      interimDiv.className = `message interim ${messageClass}`;
      interimDiv.setAttribute("data-source", source);
      interimDiv.textContent = text;
      chatMessages.appendChild(interimDiv);
    }
    
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}

// Calculate text similarity (Jaccard similarity on words)
function calculateSimilarity(text1, text2) {
  const words1 = new Set(text1.split(/\s+/).filter(w => w.length > 0));
  const words2 = new Set(text2.split(/\s+/).filter(w => w.length > 0));
  
  if (words1.size === 0 && words2.size === 0) return 1;
  if (words1.size === 0 || words2.size === 0) return 0;
  
  const intersection = new Set([...words1].filter(w => words2.has(w)));
  const union = new Set([...words1, ...words2]);
  
  return intersection.size / union.size;
}

// Helper to escape HTML
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function updatePlatformInfo() {
  const platform = navigator.platform || "Unknown";
  const platformText = platform.includes("Mac")
    ? "macOS"
    : platform.includes("Win")
    ? "Windows"
    : platform.includes("Linux")
    ? "Linux"
    : platform;
  document.getElementById("platform").textContent = platformText;

  // Check system audio support
  if (
    audioCapture &&
    typeof audioCapture.checkSystemAudioSupport === "function"
  ) {
    const support = audioCapture.checkSystemAudioSupport();
    console.log("System audio support check:", support);

    // Update UI based on support level
    if (!support.supported) {
      const speakerHelp = document.getElementById("speakerHelp");
      if (speakerHelp) {
        speakerHelp.innerHTML = `
          <small>⚠️ <strong>System audio capture not supported:</strong> ${support.message}<br>
          💡 For production use, integrate native modules (see NATIVE_MODULE_NOTES.md)</small>
        `;
        speakerHelp.classList.add("error-message");
      }
    }
  }

  // Update connection status
  const updateConnectionStatus = () => {
    const micRecording = document
      .getElementById("micStatus")
      .classList.contains("recording");
    const speakerRecording = document
      .getElementById("speakerStatus")
      .classList.contains("recording");

    if (micRecording || speakerRecording) {
      document.getElementById("connectionStatus").textContent = "Recording";
      document.getElementById("connectionStatus").classList.add("active");
    } else {
      document.getElementById("connectionStatus").textContent = "Ready";
      document.getElementById("connectionStatus").classList.remove("active");
    }
  };

  // Update status periodically
  setInterval(updateConnectionStatus, 1000);
  updateConnectionStatus();
}
