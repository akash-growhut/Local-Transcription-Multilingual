#!/usr/bin/env node

/**
 * Script to download or use local BlackHole driver for packaging with Electron app
 * Supports:
 * - Local pkg file (via command line argument or environment variable)
 * - Automatic download from GitHub releases
 */

const https = require("https");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const BLACKHOLE_VERSION = "0.6.1"; // Latest stable version
const BLACKHOLE_URL = `https://github.com/ExistentialAudio/BlackHole/releases/download/${BLACKHOLE_VERSION}/BlackHole.${BLACKHOLE_VERSION}.pkg`;
const OUTPUT_DIR = path.join(__dirname, "..", "resources");
const PKG_PATH = path.join(OUTPUT_DIR, `BlackHole.${BLACKHOLE_VERSION}.pkg`);
const DRIVER_PATH = path.join(OUTPUT_DIR, "BlackHole.driver");

// Support for local pkg file
// Usage: node download-blackhole.js /path/to/BlackHole2ch-0.6.1.pkg
// Or set: BLACKHOLE_PKG_PATH=/path/to/BlackHole2ch-0.6.1.pkg
const LOCAL_PKG_ARG = process.argv[2];
const LOCAL_PKG_ENV = process.env.BLACKHOLE_PKG_PATH;

// Create resources directory if it doesn't exist
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    console.log(`📥 Downloading BlackHole from: ${url}`);
    const file = fs.createWriteStream(dest);

    https
      .get(url, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          // Follow redirect
          return downloadFile(response.headers.location, dest)
            .then(resolve)
            .catch(reject);
        }

        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download: ${response.statusCode}`));
          return;
        }

        const totalSize = parseInt(response.headers["content-length"], 10);
        let downloadedSize = 0;

        response.on("data", (chunk) => {
          downloadedSize += chunk.length;
          const percent = ((downloadedSize / totalSize) * 100).toFixed(1);
          process.stdout.write(`\r📥 Progress: ${percent}%`);
        });

        response.pipe(file);

        file.on("finish", () => {
          file.close();
          console.log("\n✅ Download complete");
          resolve();
        });
      })
      .on("error", (err) => {
        fs.unlinkSync(dest);
        reject(err);
      });
  });
}

function extractDriverFromPkg(pkgPath, outputPath) {
  console.log("📦 Extracting BlackHole driver from package...");

  try {
    // Create temporary extraction directory
    const tempDir = path.join(OUTPUT_DIR, "temp_extract");
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tempDir, { recursive: true });

    // Extract pkg using pkgutil (macOS only)
    if (process.platform !== "darwin") {
      throw new Error("BlackHole extraction only works on macOS");
    }

    // Step 1: Extract pkg with xar
    const xarDir = path.join(tempDir, "xar_extract");
    fs.mkdirSync(xarDir, { recursive: true });

    try {
      execSync(`xar -xf "${pkgPath}" -C "${xarDir}"`, { stdio: "pipe" });
      console.log("✅ Extracted pkg structure");
    } catch (error) {
      console.warn("⚠️ xar extraction failed, trying pkgutil...");
      // Alternative: use pkgutil
      execSync(`pkgutil --expand "${pkgPath}" "${xarDir}"`, {
        stdio: "pipe",
      });
    }

    // Step 2: Find and extract Payload archive
    // Payload could be: Payload, Payload.cpio, Payload.cpio.gz, etc.
    const payloadDir = path.join(tempDir, "payload_extract");
    fs.mkdirSync(payloadDir, { recursive: true });

    function findPayload(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isFile()) {
          const name = entry.name.toLowerCase();
          if (
            name === "payload" ||
            name.startsWith("payload.") ||
            name.includes("payload")
          ) {
            return fullPath;
          }
        } else if (entry.isDirectory()) {
          const found = findPayload(fullPath);
          if (found) return found;
        }
      }
      return null;
    }

    const payloadPath = findPayload(xarDir);
    if (!payloadPath) {
      // If no Payload archive found, search directly for .driver
      console.log(
        "⚠️ No Payload archive found, searching for .driver directly..."
      );
    } else {
      console.log(`📦 Found Payload archive: ${path.basename(payloadPath)}`);

      // Extract Payload based on type
      const payloadName = path.basename(payloadPath).toLowerCase();

      if (payloadName.endsWith(".gz")) {
        // Gunzip first, then extract cpio
        const gunzipped = path.join(tempDir, "payload.cpio");
        execSync(`gunzip -c "${payloadPath}" > "${gunzipped}"`, {
          stdio: "pipe",
        });
        execSync(`cd "${payloadDir}" && cpio -i < "${gunzipped}"`, {
          stdio: "pipe",
        });
      } else if (payloadName.endsWith(".cpio") || payloadName === "payload") {
        // Direct cpio extraction
        execSync(`cd "${payloadDir}" && cpio -i < "${payloadPath}"`, {
          stdio: "pipe",
        });
      } else {
        // Try cpio anyway
        try {
          execSync(`cd "${payloadDir}" && cpio -i < "${payloadPath}"`, {
            stdio: "pipe",
          });
        } catch (e) {
          console.warn("⚠️ cpio extraction failed, trying alternative...");
        }
      }
    }

    // Step 3: Find the .driver bundle (it's a directory, not a file)
    function findDriver(dir) {
      if (!fs.existsSync(dir)) {
        return null;
      }
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        // .driver bundles are directories on macOS
        if (entry.isDirectory() && entry.name.endsWith(".driver")) {
          // Verify it's actually a driver bundle by checking for Contents directory
          const contentsPath = path.join(fullPath, "Contents");
          if (fs.existsSync(contentsPath)) {
            return fullPath;
          }
        } else if (entry.isDirectory()) {
          // Recursively search subdirectories
          // Skip some system directories to speed up search
          if (
            !entry.name.startsWith(".") &&
            entry.name !== "System" &&
            entry.name !== "private"
          ) {
            const found = findDriver(fullPath);
            if (found) return found;
          }
        }
      }
      return null;
    }

    // Search in payload extract first, then xar extract
    let driverPath = findDriver(payloadDir);
    if (!driverPath) {
      driverPath = findDriver(xarDir);
    }
    if (!driverPath) {
      // Last resort: search entire temp directory
      driverPath = findDriver(tempDir);
    }

    if (!driverPath) {
      console.log("\n📂 Package structure:");
      console.log("   Searching in:", tempDir);
      // List what we found for debugging
      function listDir(dir, depth = 0) {
        if (depth > 3) return; // Limit depth
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          const indent = "  ".repeat(depth);
          for (const entry of entries.slice(0, 10)) {
            // Limit to first 10 entries
            console.log(
              `${indent}${entry.isDirectory() ? "📁" : "📄"} ${entry.name}`
            );
            if (entry.isDirectory() && depth < 2) {
              listDir(path.join(dir, entry.name), depth + 1);
            }
          }
        } catch (e) {
          // Ignore errors
        }
      }
      listDir(tempDir);
      throw new Error("Could not find .driver file in package");
    }

    console.log(`✅ Found driver: ${driverPath}`);

    // Copy driver to output location
    if (fs.existsSync(outputPath)) {
      fs.rmSync(outputPath, { recursive: true, force: true });
    }
    fs.cpSync(driverPath, outputPath, { recursive: true });

    // Cleanup
    fs.rmSync(tempDir, { recursive: true, force: true });

    console.log("✅ Driver extracted successfully");
    return true;
  } catch (error) {
    console.error("❌ Error extracting driver:", error.message);
    console.log("\n💡 Alternative: Manually install BlackHole and copy from:");
    console.log("   /Library/Audio/Plug-Ins/HAL/BlackHole.driver");
    console.log(`   to: ${outputPath}`);
    return false;
  }
}

function findLocalPkgFile() {
  // Check command line argument
  if (LOCAL_PKG_ARG && fs.existsSync(LOCAL_PKG_ARG)) {
    return path.resolve(LOCAL_PKG_ARG);
  }

  // Check environment variable
  if (LOCAL_PKG_ENV && fs.existsSync(LOCAL_PKG_ENV)) {
    return path.resolve(LOCAL_PKG_ENV);
  }

  // Check common local locations
  const localPaths = [
    path.join(__dirname, "..", "BlackHole2ch-0.6.1.pkg"),
    path.join(__dirname, "..", "BlackHole.0.6.1.pkg"),
    path.join(__dirname, "..", "resources", "BlackHole2ch-0.6.1.pkg"),
    path.join(__dirname, "..", "resources", "BlackHole.0.6.1.pkg"),
    path.join(process.cwd(), "BlackHole2ch-0.6.1.pkg"),
    path.join(process.cwd(), "BlackHole.0.6.1.pkg"),
  ];

  for (const localPath of localPaths) {
    if (fs.existsSync(localPath)) {
      return localPath;
    }
  }

  return null;
}

async function main() {
  console.log("🔧 BlackHole Download Script");
  console.log("============================\n");

  // Check if driver already exists
  if (fs.existsSync(DRIVER_PATH)) {
    console.log("✅ BlackHole driver already exists");
    console.log(`   Location: ${DRIVER_PATH}`);
    return;
  }

  let pkgPathToUse = null;

  // First, check for local pkg file
  const localPkg = findLocalPkgFile();
  if (localPkg) {
    console.log(`📦 Using local BlackHole pkg file: ${localPkg}`);
    pkgPathToUse = localPkg;
  } else if (fs.existsSync(PKG_PATH)) {
    // Check if pkg already exists in resources
    console.log("✅ Package file already exists in resources");
    pkgPathToUse = PKG_PATH;
  } else {
    // Download the pkg file
    console.log("📥 No local pkg file found, downloading from GitHub...");
    console.log(`   URL: ${BLACKHOLE_URL}`);
    console.log("\n💡 Tip: You can provide a local pkg file:");
    console.log(
      "   - As argument: npm run download-blackhole -- /path/to/BlackHole2ch-0.6.1.pkg"
    );
    console.log(
      "   - Via env var: BLACKHOLE_PKG_PATH=/path/to/BlackHole2ch-0.6.1.pkg npm run download-blackhole"
    );
    console.log("   - Or place it in: resources/BlackHole2ch-0.6.1.pkg\n");

    try {
      await downloadFile(BLACKHOLE_URL, PKG_PATH);
      pkgPathToUse = PKG_PATH;
    } catch (error) {
      console.error("❌ Download failed:", error.message);
      console.log("\n💡 You can manually download BlackHole from:");
      console.log(`   ${BLACKHOLE_URL}`);
      console.log(`   Then run this script with the local file:`);
      console.log(
        `   npm run download-blackhole -- /path/to/BlackHole2ch-0.6.1.pkg`
      );
      process.exit(1);
    }
  }

  // Extract driver from pkg
  if (!extractDriverFromPkg(pkgPathToUse, DRIVER_PATH)) {
    console.log("\n⚠️ Automatic extraction failed.");
    console.log("   Please manually copy BlackHole.driver to:");
    console.log(`   ${DRIVER_PATH}`);
    process.exit(1);
  }

  console.log("\n✅ BlackHole driver ready for packaging!");
  console.log(`   Location: ${DRIVER_PATH}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error("❌ Fatal error:", error);
    process.exit(1);
  });
}

module.exports = { downloadFile, extractDriverFromPkg };
