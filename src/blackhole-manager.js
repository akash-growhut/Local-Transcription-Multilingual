const { exec, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
const execAsync = promisify(exec);

// Get Electron app instance safely
function getApp() {
  try {
    return require("electron").app;
  } catch (e) {
    return null;
  }
}

const BLACKHOLE_DRIVER_PATH = "/Library/Audio/Plug-Ins/HAL/BlackHole.driver";
const BLACKHOLE_2CH_DRIVER_PATH =
  "/Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver";
const BLACKHOLE_2CH = "BlackHole 2ch"; // We only need 2ch (stereo) for system audio capture
// Note: 16ch and 64ch versions exist but are unnecessary for this use case
// They're for professional multi-channel audio routing, not system audio capture

/**
 * BlackHole Manager - Handles installation, checking, and audio routing setup
 */
class BlackHoleManager {
  constructor() {
    this.isInstalled = null;
    this.originalOutputDevice = null;
  }

  /**
   * Check if BlackHole is installed
   */
  async checkInstalled() {
    try {
      // Check for both possible driver names
      const exists =
        fs.existsSync(BLACKHOLE_DRIVER_PATH) ||
        fs.existsSync(BLACKHOLE_2CH_DRIVER_PATH);
      this.isInstalled = exists;
      return exists;
    } catch (error) {
      console.error("❌ Error checking BlackHole installation:", error);
      this.isInstalled = false;
      return false;
    }
  }

  /**
   * Get the path to bundled BlackHole driver
   */
  getBundledBlackHolePath() {
    // In packaged Electron app - check extraResources location
    if (process.resourcesPath) {
      const bundledPath = path.join(process.resourcesPath, "BlackHole.driver");
      if (fs.existsSync(bundledPath)) {
        return bundledPath;
      }
    }

    // In development - check relative to app path
    const electronApp = getApp();
    if (electronApp) {
      try {
        const appPath = electronApp.getAppPath();
        const devPath = path.join(
          appPath,
          "..",
          "resources",
          "BlackHole.driver"
        );
        if (fs.existsSync(devPath)) {
          return devPath;
        }
      } catch (e) {
        // App might not be ready yet
      }
    }

    // Also check in project root resources (development)
    const rootPath = path.join(
      __dirname,
      "..",
      "resources",
      "BlackHole.driver"
    );
    if (fs.existsSync(rootPath)) {
      return rootPath;
    }

    // Check in current working directory (fallback)
    const cwdPath = path.join(process.cwd(), "resources", "BlackHole.driver");
    if (fs.existsSync(cwdPath)) {
      return cwdPath;
    }

    return null;
  }

  /**
   * Open BlackHole pkg file for manual installation
   */
  async openPkgForInstallation() {
    try {
      const { exec } = require("child_process");
      const { promisify } = require("util");
      const execAsync = promisify(exec);

      // Try to find the pkg file
      const pkgPaths = [
        path.join(__dirname, "..", "resources", "BlackHole2ch-0.6.1.pkg"),
        path.join(__dirname, "..", "resources", "BlackHole.0.6.1.pkg"),
        path.join(process.cwd(), "resources", "BlackHole2ch-0.6.1.pkg"),
      ];

      let pkgPath = null;
      for (const pkg of pkgPaths) {
        if (fs.existsSync(pkg)) {
          pkgPath = pkg;
          break;
        }
      }

      if (pkgPath) {
        console.log(`📦 Opening BlackHole installer: ${pkgPath}`);
        await execAsync(`open "${pkgPath}"`);
        return { success: true, pkgPath };
      } else {
        return {
          success: false,
          error:
            "BlackHole pkg file not found. Please download from https://github.com/ExistentialAudio/BlackHole/releases",
        };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Install BlackHole driver (requires admin privileges)
   */
  async install() {
    try {
      // Check if already installed
      if (await this.checkInstalled()) {
        console.log("✅ BlackHole is already installed");
        return { success: true, alreadyInstalled: true };
      }

      // Get bundled driver path
      const bundledPath = this.getBundledBlackHolePath();
      if (!bundledPath || !fs.existsSync(bundledPath)) {
        return {
          success: false,
          error:
            "BlackHole driver not found in app bundle. Please download it manually.",
        };
      }

      console.log(`📦 Installing BlackHole from: ${bundledPath}`);

      // Copy driver to system location (requires sudo)
      // Note: This will prompt for password
      // Install as BlackHole2ch.driver (the standard name)
      const installCommand = `sudo cp -R "${bundledPath}" "${BLACKHOLE_2CH_DRIVER_PATH}" && sudo chown -R root:wheel "${BLACKHOLE_2CH_DRIVER_PATH}" && sudo chmod -R 755 "${BLACKHOLE_2CH_DRIVER_PATH}"`;

      try {
        const { stdout, stderr } = await execAsync(installCommand, {
          timeout: 60000, // Longer timeout for password entry
          maxBuffer: 1024 * 1024, // 1MB buffer
        });

        if (
          stderr &&
          !stderr.includes("Password:") &&
          !stderr.includes("password")
        ) {
          console.warn("⚠️ Installation warning:", stderr);
        }

        // Wait a moment for system to recognize the driver
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Verify installation
        if (await this.checkInstalled()) {
          console.log("✅ BlackHole installed successfully");
          return { success: true, alreadyInstalled: false };
        } else {
          return {
            success: false,
            error:
              "Installation completed but driver not found. Please restart your Mac for the driver to be recognized.",
            needsRestart: true,
          };
        }
      } catch (error) {
        // Handle different error cases
        if (error.signal === "SIGTERM" || error.killed) {
          // Try to open the pkg file for manual installation
          const openResult = await this.openPkgForInstallation();
          return {
            success: false,
            error:
              "Installation was interrupted. " +
              (openResult.success
                ? "The BlackHole installer has been opened. Please follow the installation wizard, then restart your Mac."
                : "Please install BlackHole manually from https://github.com/ExistentialAudio/BlackHole/releases and restart your Mac."),
            needsManualInstall: true,
            installerOpened: openResult.success,
          };
        }

        if (error.code === 1 || error.message.includes("Password")) {
          // Try to open the pkg file for manual installation
          const openResult = await this.openPkgForInstallation();
          return {
            success: false,
            error:
              "Installation requires administrator privileges. " +
              (openResult.success
                ? "The BlackHole installer has been opened. Please follow the installation wizard, then restart your Mac."
                : "Please install BlackHole manually from https://github.com/ExistentialAudio/BlackHole/releases and restart your Mac."),
            needsPassword: true,
            needsManualInstall: true,
            installerOpened: openResult.success,
          };
        }

        console.error("❌ Installation error:", error.message);
        return {
          success: false,
          error: `Installation failed: ${error.message}. Please install BlackHole manually from https://github.com/ExistentialAudio/BlackHole/releases and restart your Mac.`,
          needsManualInstall: true,
        };
      }
    } catch (error) {
      console.error("❌ Error installing BlackHole:", error);
      return {
        success: false,
        error: error.message || "Unknown error during installation",
      };
    }
  }

  /**
   * Get current default output device
   */
  async getDefaultOutputDevice() {
    try {
      const { stdout } = await execAsync(
        `osascript -e 'tell application "System Events" to tell process "System Settings" to set frontmost to true' 2>/dev/null || echo "" && system_profiler SPAudioDataType | grep -A 2 "Default Output Device" | head -3`
      );

      // Better method using CoreAudio
      const { stdout: deviceOutput } = await execAsync(
        `system_profiler SPAudioDataType -json 2>/dev/null | grep -i "default" || echo ""`
      );

      // Use SwitchAudioSource if available, or fallback to system_profiler
      try {
        const { stdout: switchOutput } = await execAsync(
          `switchaudiosource -c 2>/dev/null || echo ""`
        );
        if (switchOutput && switchOutput.trim()) {
          return switchOutput.trim();
        }
      } catch (e) {
        // switchaudiosource not available, continue with other methods
      }

      // Fallback: try to get from system preferences
      try {
        const { stdout: prefOutput } = await execAsync(
          `defaults read com.apple.audio.SystemAudioDeviceID 2>/dev/null || echo ""`
        );
        // This is a device ID, not a name, but we can use it
      } catch (e) {
        // Continue
      }

      return null;
    } catch (error) {
      console.warn(
        "⚠️ Could not determine default output device:",
        error.message
      );
      return null;
    }
  }

  /**
   * Set default output device using AppleScript (requires accessibility permissions)
   */
  async setDefaultOutputDevice(deviceName) {
    try {
      const script = `
        tell application "System Events"
          tell application process "System Settings"
            set frontmost to true
            -- Navigate to sound settings
            -- This is complex and may not work reliably
          end tell
        end tell
      `;

      // Better approach: use command line tools if available
      // For now, we'll create a Multi-Output Device instead
      console.log(
        `📢 Note: Setting output device requires manual setup or Multi-Output Device`
      );
      return { success: true, note: "Manual setup may be required" };
    } catch (error) {
      console.error("❌ Error setting output device:", error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Create or get Multi-Output Device that includes BlackHole and current output
   */
  async setupMultiOutputDevice() {
    try {
      // Get current default output
      const currentOutput = await this.getDefaultOutputDevice();

      // Use Audio MIDI Setup command line (if available) or provide instructions
      console.log("🔧 Setting up Multi-Output Device...");
      console.log("   This combines your current output with BlackHole");

      // Check if Multi-Output Device already exists
      try {
        const { stdout } = await execAsync(
          `system_profiler SPAudioDataType | grep -i "multi-output" || echo ""`
        );
        if (stdout && stdout.trim()) {
          console.log("✅ Multi-Output Device may already exist");
        }
      } catch (e) {
        // Continue
      }

      // Provide instructions for manual setup
      return {
        success: true,
        instructions: [
          "1. Open 'Audio MIDI Setup' (Applications > Utilities)",
          "2. Click the '+' button and select 'Create Multi-Output Device'",
          "3. Check both your current output device and 'BlackHole 2ch'",
          "4. Set this Multi-Output Device as your system output",
          "5. Audio will play through both devices simultaneously",
        ],
        note: "Automatic Multi-Output Device creation requires additional permissions. Manual setup is recommended for first-time use.",
      };
    } catch (error) {
      console.error("❌ Error setting up Multi-Output Device:", error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get list of available audio devices
   */
  async getAudioDevices() {
    try {
      const { stdout } = await execAsync(
        `system_profiler SPAudioDataType -json 2>/dev/null || echo "{}"`
      );

      try {
        const devices = JSON.parse(stdout);
        return { success: true, devices };
      } catch (e) {
        // Fallback: parse text output
        const { stdout: textOutput } = await execAsync(
          `system_profiler SPAudioDataType 2>/dev/null || echo ""`
        );
        return { success: true, devices: textOutput, format: "text" };
      }
    } catch (error) {
      console.error("❌ Error getting audio devices:", error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Check if BlackHole device is available for capture
   */
  async checkBlackHoleAvailable() {
    try {
      const devices = await this.getAudioDevices();
      if (!devices.success) {
        return { available: false, error: devices.error };
      }

      // Check if BlackHole appears in device list
      const deviceList = JSON.stringify(devices.devices);
      const hasBlackHole =
        deviceList.includes("BlackHole") ||
        deviceList.includes("blackhole") ||
        fs.existsSync(BLACKHOLE_DRIVER_PATH) ||
        fs.existsSync(BLACKHOLE_2CH_DRIVER_PATH);

      return { available: hasBlackHole };
    } catch (error) {
      return { available: false, error: error.message };
    }
  }

  /**
   * Complete setup: check, install if needed, and provide routing instructions
   */
  async setup() {
    console.log("🔧 Setting up BlackHole for audio capture...");

    // Step 1: Check if installed
    const isInstalled = await this.checkInstalled();
    if (!isInstalled) {
      console.log("📦 BlackHole not installed. Attempting installation...");
      const installResult = await this.install();
      if (!installResult.success) {
        return {
          success: false,
          error: installResult.error,
          needsPassword: installResult.needsPassword,
        };
      }
    }

    // Step 2: Verify BlackHole is available
    const availability = await this.checkBlackHoleAvailable();
    if (!availability.available) {
      return {
        success: false,
        error: "BlackHole installed but not detected. Please restart your Mac.",
        needsRestart: true,
      };
    }

    // Step 3: Setup routing instructions
    const routingSetup = await this.setupMultiOutputDevice();

    return {
      success: true,
      installed: true,
      routing: routingSetup,
      message:
        "BlackHole is ready. Please set up Multi-Output Device for audio routing.",
    };
  }
}

module.exports = new BlackHoleManager();
