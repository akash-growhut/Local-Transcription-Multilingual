/**
 * Driver Installer - Automatically installs BlackHole audio driver if not present
 *
 * This module handles:
 * 1. Detecting if a virtual audio driver is installed
 * 2. Downloading and installing BlackHole if needed
 * 3. Showing user-friendly prompts for permission
 */

const { exec, spawn } = require("child_process");
const { dialog, app } = require("electron");
const path = require("path");
const fs = require("fs");
const https = require("https");
const os = require("os");

// BlackHole download URL (using Homebrew cask as source)
const BLACKHOLE_CASK_URL =
  "https://raw.githubusercontent.com/Homebrew/homebrew-cask/master/Casks/b/blackhole-2ch.rb";

/**
 * Check if any virtual audio driver is installed
 */
function checkVirtualAudioDriver() {
  return new Promise((resolve) => {
    exec(
      'system_profiler SPAudioDataType 2>/dev/null | grep -i -E "BlackHole|Loopback|Soundflower"',
      (error, stdout) => {
        resolve(stdout.trim().length > 0);
      }
    );
  });
}

/**
 * Check if BlackHole is specifically installed
 */
function isBlackHoleInstalled() {
  return new Promise((resolve) => {
    exec(
      "ls /Library/Audio/Plug-Ins/HAL/ 2>/dev/null | grep -i blackhole",
      (error, stdout) => {
        resolve(stdout.trim().length > 0);
      }
    );
  });
}

/**
 * Get the BlackHole pkg download URL from Homebrew cask
 */
async function getBlackHoleDownloadUrl() {
  return new Promise((resolve, reject) => {
    https
      .get(BLACKHOLE_CASK_URL, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          // Parse the cask file to find version and construct URL
          const versionMatch = data.match(/version\s+"([^"]+)"/);
          if (versionMatch) {
            resolve(
              `https://existential.audio/downloads/BlackHole2ch-${versionMatch[1]}.pkg`
            );
          } else {
            // Fallback to known working URL
            resolve(
              "https://existential.audio/downloads/BlackHole2ch-0.6.1.pkg"
            );
          }
        });
        res.on("error", () => {
          // Fallback on error
          resolve("https://existential.audio/downloads/BlackHole2ch-0.6.1.pkg");
        });
      })
      .on("error", () => {
        resolve("https://existential.audio/downloads/BlackHole2ch-0.6.1.pkg");
      });
  });
}

/**
 * Download a file from URL
 */
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);

    const request = (urlStr) => {
      const protocol = urlStr.startsWith("https") ? https : require("http");
      protocol
        .get(urlStr, (response) => {
          // Handle redirects
          if (response.statusCode === 301 || response.statusCode === 302) {
            request(response.headers.location);
            return;
          }

          if (response.statusCode !== 200) {
            reject(
              new Error(`Download failed with status ${response.statusCode}`)
            );
            return;
          }

          response.pipe(file);
          file.on("finish", () => {
            file.close();
            resolve(destPath);
          });
        })
        .on("error", (err) => {
          fs.unlink(destPath, () => {});
          reject(err);
        });
    };

    request(url);
  });
}

/**
 * Install BlackHole using the downloaded pkg
 */
function installBlackHole(pkgPath) {
  return new Promise((resolve, reject) => {
    // Use osascript to run installer with admin privileges
    const script = `
      do shell script "installer -pkg '${pkgPath}' -target /" with administrator privileges
    `;

    exec(`osascript -e '${script}'`, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Installation failed: ${stderr || error.message}`));
      } else {
        // Restart coreaudiod to load the new driver
        exec("killall coreaudiod 2>/dev/null || true", () => {
          resolve(true);
        });
      }
    });
  });
}

/**
 * Main function to ensure virtual audio driver is installed
 */
async function ensureVirtualAudioDriver(mainWindow) {
  try {
    // Check if already installed
    const hasDriver = await checkVirtualAudioDriver();
    if (hasDriver) {
      console.log("✅ Virtual audio driver already installed");
      return { installed: true, wasInstalled: false };
    }

    // Ask user for permission to install
    const result = await dialog.showMessageBox(mainWindow, {
      type: "question",
      buttons: ["Install Driver", "Skip (Use Screen Sharing)"],
      defaultId: 0,
      cancelId: 1,
      title: "Audio Driver Required",
      message: "Install BlackHole Audio Driver?",
      detail:
        "To capture speaker audio WITHOUT showing the screen recording icon, " +
        "we need to install the BlackHole virtual audio driver.\n\n" +
        "• This is a one-time installation\n" +
        "• Requires administrator password\n" +
        "• Open source & safe (MIT license)\n\n" +
        "If you skip, the app will use screen sharing (shows recording icon).",
    });

    if (result.response === 1) {
      console.log("⚠️ User skipped driver installation");
      return { installed: false, wasInstalled: false, skipped: true };
    }

    // Show progress
    if (mainWindow) {
      mainWindow.webContents.send("driver-install-status", {
        status: "downloading",
        message: "Downloading BlackHole audio driver...",
      });
    }

    // Download BlackHole (URL from Homebrew cask)
    const downloadUrl =
      "https://existential.audio/downloads/BlackHole2ch-0.6.1.pkg";
    const tempPath = path.join(os.tmpdir(), "BlackHole2ch.pkg");

    console.log("📥 Downloading BlackHole from:", downloadUrl);
    await downloadFile(downloadUrl, tempPath);

    // Verify download (BlackHole pkg is about 100KB)
    const stats = fs.statSync(tempPath);
    if (stats.size < 50000) {
      throw new Error("Download failed - file too small");
    }

    console.log(
      `📦 Downloaded BlackHole (${(stats.size / 1024).toFixed(0)} KB)`
    );

    // Update status
    if (mainWindow) {
      mainWindow.webContents.send("driver-install-status", {
        status: "installing",
        message: "Installing BlackHole (requires password)...",
      });
    }

    // Install
    await installBlackHole(tempPath);

    // Cleanup
    fs.unlinkSync(tempPath);

    // Verify installation
    await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait for coreaudiod
    const installed = await isBlackHoleInstalled();

    if (installed) {
      console.log("✅ BlackHole installed successfully!");

      if (mainWindow) {
        mainWindow.webContents.send("driver-install-status", {
          status: "complete",
          message: "BlackHole installed successfully!",
        });
      }

      // Show success message with instructions
      await dialog.showMessageBox(mainWindow, {
        type: "info",
        title: "Installation Complete",
        message: "BlackHole Audio Driver Installed!",
        detail:
          "To capture speaker audio:\n\n" +
          "1. Open System Settings → Sound\n" +
          "2. Set Output to 'BlackHole 2ch'\n" +
          "   (You won't hear audio directly)\n\n" +
          "OR create a Multi-Output Device in Audio MIDI Setup " +
          "to hear audio while capturing.",
      });

      return { installed: true, wasInstalled: true };
    } else {
      throw new Error("Installation verification failed");
    }
  } catch (error) {
    console.error("❌ Driver installation failed:", error.message);

    if (mainWindow) {
      mainWindow.webContents.send("driver-install-status", {
        status: "error",
        message: error.message,
      });
    }

    await dialog.showMessageBox(mainWindow, {
      type: "error",
      title: "Installation Failed",
      message: "Could not install audio driver",
      detail: `${error.message}\n\nThe app will use screen sharing mode instead.`,
    });

    return { installed: false, wasInstalled: false, error: error.message };
  }
}

/**
 * Create a Multi-Output Device programmatically
 */
async function createMultiOutputDevice() {
  // This requires Audio MIDI Setup which can't be fully automated
  // Open Audio MIDI Setup for the user
  exec('open "/Applications/Utilities/Audio MIDI Setup.app"');

  await dialog.showMessageBox(null, {
    type: "info",
    title: "Create Multi-Output Device",
    message: "Set up Multi-Output Device",
    detail:
      "To hear audio while capturing:\n\n" +
      "1. Click the '+' button (bottom left)\n" +
      "2. Select 'Create Multi-Output Device'\n" +
      "3. Check both:\n" +
      "   ✓ BlackHole 2ch\n" +
      "   ✓ Your speakers/headphones\n" +
      "4. Right-click it → 'Use This Device For Sound Output'",
  });
}

module.exports = {
  checkVirtualAudioDriver,
  isBlackHoleInstalled,
  ensureVirtualAudioDriver,
  createMultiOutputDevice,
};
