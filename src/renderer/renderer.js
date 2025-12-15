// Main renderer process logic

let audioCapture;
let deepgramApiKey = "";
let microphoneTranscript = "";
let speakerTranscript = "";

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

  // Clear transcripts
  document.getElementById("micTranscriptContent").textContent = "";
  document.getElementById("speakerTranscriptContent").textContent = "";
}

function setupEventListeners() {
  // API Key management
  document.getElementById("saveKey").addEventListener("click", saveApiKey);
  document.getElementById("apiKey").addEventListener("keypress", (e) => {
    if (e.key === "Enter") saveApiKey();
  });

  // Microphone controls
  document
    .getElementById("startMic")
    .addEventListener("click", startMicrophone);
  document.getElementById("stopMic").addEventListener("click", stopMicrophone);

  // Speaker controls
  document
    .getElementById("startSpeaker")
    .addEventListener("click", startSpeaker);
  document.getElementById("stopSpeaker").addEventListener("click", stopSpeaker);

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
      connected ? "Connected" : "Disconnected",
      connected ? "connected" : ""
    );
    document.getElementById("startMic").disabled = connected;
    document.getElementById("stopMic").disabled = !connected;
  });

  window.electronAPI.onSpeakerConnected((connected) => {
    updateStatus(
      "speakerStatus",
      connected ? "Connected" : "Disconnected",
      connected ? "connected" : ""
    );
    document.getElementById("startSpeaker").disabled = connected;
    document.getElementById("stopSpeaker").disabled = !connected;
  });

  window.electronAPI.onMicrophoneError((error) => {
    updateStatus("micStatus", `Error: ${error}`, "error");
    console.error("Microphone error:", error);
  });

  window.electronAPI.onSpeakerError((error) => {
    updateStatus("speakerStatus", `Error: ${error}`, "error");
    console.error("Speaker error:", error);
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
  const apiKey = document.getElementById("apiKey").value.trim();
  if (!apiKey) {
    alert("Please enter a Deepgram API key");
    return;
  }

  deepgramApiKey = apiKey;
  localStorage.setItem("deepgramApiKey", apiKey);

  // Initialize Deepgram
  window.electronAPI.initializeDeepgram(apiKey).then((result) => {
    if (result.success) {
      alert("API key saved and Deepgram initialized successfully!");
      document.getElementById("apiKey").value = "";
    } else {
      alert(`Error initializing Deepgram: ${result.error}`);
    }
  });
}

function loadSavedApiKey() {
  const savedKey = localStorage.getItem("deepgramApiKey");
  if (savedKey) {
    deepgramApiKey = savedKey;
    window.electronAPI.initializeDeepgram(savedKey);
  }
}

async function startMicrophone() {
  if (!deepgramApiKey) {
    alert("Please enter and save your Deepgram API key first");
    return;
  }

  try {
    // Start Deepgram connection
    const result = await window.electronAPI.startMicrophoneCapture(
      deepgramApiKey
    );
    if (!result.success) {
      alert(`Error starting microphone capture: ${result.error}`);
      return;
    }

    // Start audio capture
    const audioResult = await audioCapture.startMicrophoneCapture(
      (audioData, source) => {
        // Send audio data to Deepgram via main process
        window.electronAPI.sendAudioData(audioData, source);
      }
    );

    if (audioResult.success) {
      updateStatus("micStatus", "Recording...", "recording");
      document.getElementById("startMic").disabled = true;
      document.getElementById("stopMic").disabled = false;
    } else {
      alert(`Error starting microphone: ${audioResult.error}`);
      await window.electronAPI.stopMicrophoneCapture();
    }
  } catch (error) {
    console.error("Error starting microphone:", error);
    alert(`Error: ${error.message}`);
  }
}

async function stopMicrophone() {
  audioCapture.stopMicrophoneCapture();
  const result = await window.electronAPI.stopMicrophoneCapture();

  if (result.success) {
    updateStatus("micStatus", "Stopped", "");
    document.getElementById("startMic").disabled = false;
    document.getElementById("stopMic").disabled = true;
  }
}

async function startSpeaker() {
  // Reset transcript tracking for new session
  resetSpeakerTranscriptTracking();
  if (!deepgramApiKey) {
    showError("Please enter and save your Deepgram API key first");
    return;
  }

  // Show info about system audio capture requirements
  const platform = navigator.platform.toLowerCase();
  let platformNote = "";

  if (platform.includes("mac")) {
    platformNote =
      "\n\n📱 macOS: You may need to grant Screen Recording permission in System Preferences > Security & Privacy.";
  } else if (platform.includes("win")) {
    platformNote =
      "\n\n🪟 Windows: For automatic capture, a native WASAPI Loopback module is recommended.";
  }

  try {
    // Start Deepgram connection
    const result = await window.electronAPI.startSpeakerCapture(deepgramApiKey);
    if (!result.success) {
      showError(
        `Error starting speaker capture: ${result.error}${platformNote}`
      );
      return;
    }

    // Start audio capture
    const audioResult = await audioCapture.startSpeakerCapture(
      (audioData, source) => {
        // Send audio data to Deepgram via main process
        window.electronAPI.sendAudioData(audioData, source);
      }
    );

    if (audioResult.success) {
      updateStatus("speakerStatus", "Recording...", "recording");
      document.getElementById("startSpeaker").disabled = true;
      document.getElementById("stopSpeaker").disabled = false;
      // Hide help text when recording
      const helpText = document.getElementById("speakerHelp");
      if (helpText) helpText.style.display = "none";

      // Show reminder about audio sharing
      setTimeout(() => {
        const statusEl = document.getElementById("speakerStatus");
        if (statusEl && statusEl.classList.contains("recording")) {
          // Check if we're getting transcripts (indicates audio is working)
          // If no transcripts after 5 seconds, show reminder
          setTimeout(() => {
            const transcriptContent = document.getElementById(
              "speakerTranscriptContent"
            );
            const hasTranscripts =
              transcriptContent &&
              transcriptContent.querySelectorAll(".final, .interim").length > 0;

            if (!hasTranscripts) {
              showError(
                "⚠️ No audio detected yet!\n\n" +
                  "If you don't see transcripts, make sure:\n" +
                  '1. ✅ "Share audio" was checked in the sharing dialog\n' +
                  "2. Audio is actually playing on your system\n" +
                  "3. Screen recording permission is granted (macOS)\n\n" +
                  "Try stopping and starting again, making sure to enable audio sharing."
              );
            }
          }, 5000);
        }
      }, 2000);
    } else {
      // Show detailed error with platform-specific guidance
      showError(
        `Error starting speaker capture:\n\n${audioResult.error}${platformNote}\n\n` +
          `💡 Tip: In the browser dialog, make sure to select an audio source. ` +
          `For production use, integrate native modules for silent system audio capture.`
      );
      await window.electronAPI.stopSpeakerCapture();
    }
  } catch (error) {
    console.error("Error starting speaker:", error);
    showError(
      `Error: ${error.message}${platformNote}\n\n` +
        `System audio capture requires screen sharing permissions or a native module. ` +
        `See NATIVE_MODULE_NOTES.md for integration details.`
    );
  }
}

function showError(message) {
  // Use a more user-friendly error display
  alert(message);
  // Could be replaced with a custom modal for better UX
}

async function stopSpeaker() {
  audioCapture.stopSpeakerCapture();
  const result = await window.electronAPI.stopSpeakerCapture();

  if (result.success) {
    updateStatus("speakerStatus", "Stopped", "");
    document.getElementById("startSpeaker").disabled = false;
    document.getElementById("stopSpeaker").disabled = true;
    // Show help text again
    const helpText = document.getElementById("speakerHelp");
    if (helpText) helpText.style.display = "block";
  }
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
  const contentDiv = document.getElementById("speakerTranscriptContent");
  if (!contentDiv) {
    console.error("❌ speakerTranscriptContent element not found!");
    return;
  }
  console.log(`✅ Found speakerTranscriptContent element`);

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

    // Display the transcript
    const finalDiv = document.createElement("span");
    finalDiv.className = "final";
    finalDiv.textContent = adjustedText + " ";
    contentDiv.appendChild(finalDiv);

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
    contentDiv.scrollTop = contentDiv.scrollHeight;
    console.log(`📜 Displayed all available transcripts`);
  } else {
    console.log(`ℹ️ No new transcripts to display`);
  }
}

function displayTranscript(text, isFinal, source, eventData = null) {
  console.log(`🎯 [displayTranscript] Called with:`, {
    text,
    isFinal,
    source,
    eventData,
  });

  // Handle file-based transcripts (from MP3 transcription)
  if (source === "speaker" && eventData && eventData.fileIndex !== undefined) {
    const fileIndex = eventData.fileIndex;
    console.log(`📝 Received file-based transcript ${fileIndex}: "${text}"`);
    speakerTranscripts.set(fileIndex, {
      text: text,
      timestamp: eventData.timestamp || Date.now(),
    });

    console.log(
      `📊 Stored transcripts (queue):`,
      Array.from(speakerTranscripts.keys()).sort((a, b) => a - b)
    );

    // Display transcripts in sequential order
    displaySequentialTranscripts();
    return;
  }

  // Handle live/streaming transcripts (no fileIndex)
  console.log(
    `📝 Received live ${source} transcript (${
      isFinal ? "FINAL" : "interim"
    }): "${text}"`
  );

  const contentId =
    source === "microphone"
      ? "micTranscriptContent"
      : "speakerTranscriptContent";
  const contentDiv = document.getElementById(contentId);

  if (isFinal) {
    // Add final transcript
    const finalDiv = document.createElement("span");
    finalDiv.className = "final";
    finalDiv.textContent = text + " ";
    contentDiv.appendChild(finalDiv);

    // Scroll to bottom
    contentDiv.scrollTop = contentDiv.scrollHeight;

    // Update stored transcript
    if (source === "microphone") {
      microphoneTranscript += text + " ";
    } else {
      speakerTranscript += text + " ";
    }
  } else {
    // Update interim transcript (remove previous interim, add new one)
    const existingInterim = contentDiv.querySelector(".interim");
    if (existingInterim) {
      existingInterim.remove();
    }

    if (text) {
      const interimDiv = document.createElement("div");
      interimDiv.className = "interim";
      interimDiv.textContent = text;
      contentDiv.appendChild(interimDiv);
      contentDiv.scrollTop = contentDiv.scrollHeight;
    }
  }
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

  // Update permissions info based on platform
  updatePermissionsInfo(platformText);

  // Update connection status
  const updateConnectionStatus = () => {
    const micConnected =
      document.getElementById("micStatus").classList.contains("connected") ||
      document.getElementById("micStatus").classList.contains("recording");
    const speakerConnected =
      document
        .getElementById("speakerStatus")
        .classList.contains("connected") ||
      document.getElementById("speakerStatus").classList.contains("recording");

    if (micConnected || speakerConnected) {
      document.getElementById("connectionStatus").textContent = "Active";
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

function updatePermissionsInfo(platform) {
  const permissionsContent = document.getElementById("permissionsContent");

  if (platform === "macOS") {
    permissionsContent.innerHTML = `
      <p><strong>Current Method:</strong> Browser screen sharing API</p>
      <ul>
        <li>✅ Works immediately, no setup required</li>
        <li>⚠️ Requires screen sharing permission dialog</li>
        <li>⚠️ User must manually select audio source</li>
      </ul>
      <p><strong>Recommended for Production:</strong></p>
      <ul>
        <li><strong>macOS 13+:</strong> ScreenCaptureKit native module</li>
        <li class="nested-item">→ One-time screen recording permission</li>
        <li class="nested-item">→ Silent, automatic capture</li>
        <li><strong>macOS &lt;13:</strong> BlackHole virtual audio device</li>
        <li class="nested-item">→ Requires BlackHole installation</li>
      </ul>
      <p class="note">📖 See NATIVE_MODULE_NOTES.md for integration guide</p>
    `;
  } else if (platform === "Windows") {
    permissionsContent.innerHTML = `
      <p><strong>Current Method:</strong> Browser screen sharing API</p>
      <ul>
        <li>✅ Works immediately, no setup required</li>
        <li>⚠️ Requires screen sharing permission dialog</li>
        <li>⚠️ User must manually select audio source</li>
      </ul>
      <p><strong>Recommended for Production:</strong></p>
      <ul>
        <li><strong>WASAPI Loopback:</strong> Native module</li>
        <li class="nested-item">→ Zero setup required</li>
        <li class="nested-item">→ Silent, automatic system audio capture</li>
        <li class="nested-item">→ Captures all system audio</li>
      </ul>
      <p class="note">📖 See NATIVE_MODULE_NOTES.md for integration guide</p>
    `;
  } else {
    permissionsContent.innerHTML = `
      <p><strong>Current Method:</strong> Browser screen sharing API</p>
      <ul>
        <li>✅ Works immediately, no setup required</li>
        <li>⚠️ Requires screen sharing permission</li>
        <li>⚠️ User must manually select audio source</li>
      </ul>
      <p><strong>For Production:</strong> Native audio capture module recommended</p>
      <p class="note">📖 See NATIVE_MODULE_NOTES.md for platform-specific integration</p>
    `;
  }
}
