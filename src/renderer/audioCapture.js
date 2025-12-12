// Audio capture utilities using ONLY native modules
// Main process handles all native audio capture

class AudioCapture {
  constructor() {
    this.isMicrophoneCapturing = false;
    this.isSpeakerCapturing = false;
  }

  // Check if native audio is available
  _checkNativeSupport() {
    if (!window.electronAPI) {
      throw new Error(
        "Electron API not available.\n\n" +
          "This application requires Electron with proper preload script.\n" +
          "Make sure the app is running in Electron, not a web browser."
      );
    }

    if (
      !window.electronAPI.startMicrophoneCapture ||
      !window.electronAPI.startSpeakerCapture
    ) {
      throw new Error(
        "Native audio capture methods not available.\n\n" +
          "This application requires native audio capture support.\n" +
          "Please ensure the native module is properly built:\n\n" +
          "  npm run build-native\n\n" +
          "macOS: Requires ScreenCaptureKit (macOS 13+)\n" +
          "Windows: Requires WASAPI Loopback\n\n" +
          "See BUILD_NATIVE.md for details."
      );
    }
  }

  // Start microphone capture
  // Note: Main process handles the actual capture and Deepgram streaming
  // The onAudioData callback is not used since main process handles it
  async startMicrophoneCapture(onAudioData) {
    try {
      this._checkNativeSupport();

      // Note: onAudioData parameter is ignored
      // Main process handles audio capture and sends directly to Deepgram
      // This is just a compatibility wrapper

      const result = await window.electronAPI.startMicrophoneCapture();

      if (result && result.success) {
        this.isMicrophoneCapturing = true;
        return { success: true };
      } else {
        throw new Error(result?.error || "Failed to start microphone capture");
      }
    } catch (error) {
      console.error("Microphone capture error:", error);
      return {
        success: false,
        error: this._formatError(error, "microphone"),
      };
    }
  }

  // Start speaker/system audio capture
  // Note: Main process handles the actual capture and Deepgram streaming
  // The onAudioData callback is not used since main process handles it
  async startSpeakerCapture(onAudioData) {
    try {
      this._checkNativeSupport();

      // Note: onAudioData parameter is ignored
      // Main process handles audio capture and sends directly to Deepgram
      // This is just a compatibility wrapper

      const result = await window.electronAPI.startSpeakerCapture();

      if (result && result.success) {
        this.isSpeakerCapturing = true;
        return { success: true };
      } else {
        throw new Error(result?.error || "Failed to start speaker capture");
      }
    } catch (error) {
      console.error("Speaker capture error:", error);
      return {
        success: false,
        error: this._formatError(error, "speaker"),
      };
    }
  }

  // Stop microphone capture
  async stopMicrophoneCapture() {
    try {
      this.isMicrophoneCapturing = false;

      if (window.electronAPI && window.electronAPI.stopMicrophoneCapture) {
        await window.electronAPI.stopMicrophoneCapture();
      }

      return { success: true };
    } catch (error) {
      console.error("Error stopping microphone:", error);
      return { success: true }; // Always return success for stop
    }
  }

  // Stop speaker capture
  async stopSpeakerCapture() {
    try {
      this.isSpeakerCapturing = false;

      if (window.electronAPI && window.electronAPI.stopSpeakerCapture) {
        await window.electronAPI.stopSpeakerCapture();
      }

      return { success: true };
    } catch (error) {
      console.error("Error stopping speaker:", error);
      return { success: true }; // Always return success for stop
    }
  }

  // Format error messages with helpful information
  _formatError(error, captureType) {
    let message = error.message || error.toString();

    // Check for permission errors
    if (
      message.includes("permission") ||
      message.includes("denied") ||
      message.includes("TCC")
    ) {
      if (captureType === "speaker") {
        return (
          "🔒 Permission Required: Screen & System Audio Recording\n\n" +
          '⚠️ macOS requires "Screen & System Audio Recording" permission\n' +
          "   even though this app only captures audio (not screen).\n" +
          "   This is an Apple platform limitation.\n\n" +
          "To grant permission:\n" +
          "1. Open System Settings → Privacy & Security\n" +
          '2. Click "Screen & System Audio Recording"\n' +
          "3. Toggle ON for this app (Electron)\n" +
          "4. Restart the app\n\n" +
          "Or run in terminal:\n" +
          "  tccutil reset ScreenCapture\n" +
          "  npm start\n\n" +
          'Then click "Allow" when prompted.'
        );
      } else {
        return (
          "🔒 Permission Required: Microphone Access\n\n" +
          "To grant permission:\n" +
          "1. Open System Settings → Privacy & Security\n" +
          '2. Click "Microphone"\n' +
          "3. Toggle ON for this app (Electron)\n" +
          "4. Restart the app"
        );
      }
    }

    // Check for module not found
    if (message.includes("not available") || message.includes("not found")) {
      return (
        "❌ Native Audio Module Not Available\n\n" +
        "The native audio capture module is not properly installed.\n\n" +
        "To fix this:\n" +
        "1. Build the native module:\n" +
        "   npm run build-native\n\n" +
        "2. Restart the app:\n" +
        "   npm start\n\n" +
        "Requirements:\n" +
        "• macOS 13+: ScreenCaptureKit\n" +
        "• Windows: WASAPI Loopback\n\n" +
        "See BUILD_NATIVE.md for details."
      );
    }

    // Return the original error message
    return message;
  }

  // Check if native audio capture is available
  checkNativeSupport() {
    const checks = {
      electronAPI: !!window.electronAPI,
      startMicrophoneCapture: !!(
        window.electronAPI && window.electronAPI.startMicrophoneCapture
      ),
      startSpeakerCapture: !!(
        window.electronAPI && window.electronAPI.startSpeakerCapture
      ),
      stopMicrophoneCapture: !!(
        window.electronAPI && window.electronAPI.stopMicrophoneCapture
      ),
      stopSpeakerCapture: !!(
        window.electronAPI && window.electronAPI.stopSpeakerCapture
      ),
    };

    const isSupported =
      checks.electronAPI &&
      checks.startMicrophoneCapture &&
      checks.startSpeakerCapture &&
      checks.stopMicrophoneCapture &&
      checks.stopSpeakerCapture;

    let message = "";
    let supportLevel = "none";

    if (isSupported) {
      supportLevel = "full";
      message = "✅ Native audio capture is available";
    } else if (checks.electronAPI) {
      supportLevel = "partial";
      message =
        "⚠️ Electron API available but some native capture methods missing";
    } else {
      supportLevel = "none";
      message = "❌ Electron API not available. Not running in Electron?";
    }

    return {
      supported: isSupported,
      supportLevel,
      message,
      checks,
    };
  }

  // Get status of captures
  getStatus() {
    return {
      microphone: {
        capturing: this.isMicrophoneCapturing,
        native: true,
      },
      speaker: {
        capturing: this.isSpeakerCapturing,
        native: true,
      },
    };
  }
}

// Export for use in renderer
window.AudioCapture = AudioCapture;
