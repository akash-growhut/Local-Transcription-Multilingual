# Surge Audio Driver Setup Guide

This guide explains how to set up the Surge Audio virtual driver to capture system audio **without** showing the screen recording icon on macOS.

## Overview

By default, macOS requires Screen Recording permission to capture system audio, which displays a recording icon in the menu bar. The Surge Audio Driver creates a virtual audio device that bypasses this requirement.

### How It Works

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│ System Audio    │ ──▶ │ Surge Audio     │ ──▶ │ Your App        │
│ (Spotify, etc.) │     │ (Virtual Device)│     │ (Captures Input)│
└─────────────────┘     └─────────────────┘     └─────────────────┘
                              │
                              ▼
                        No Recording Icon!
```

## Quick Start

### Step 1: Build the Native Module

```bash
cd native-audio
npm install
npm run rebuild
```

### Step 2: Build and Install the Audio Driver

```bash
cd surge-audio-driver
./install.sh
```

You'll be prompted for your admin password. After installation, the "Surge Audio" device will appear in your sound settings.

### Step 3: Configure System Audio Output

1. Open **System Preferences** → **Sound** → **Output**
2. Select **"Surge Audio"** as your output device

Or via command line:

```bash
# List audio devices
system_profiler SPAudioDataType

# The Surge Audio device should appear in the list
```

### Step 4: Run Your App

```bash
npm start
```

When speaker capture starts, it will automatically use the Surge Audio driver if installed.

## Verification

You can verify the driver is working:

1. **Check device is installed:**

   ```bash
   ls -la /Library/Audio/Plug-Ins/HAL/SurgeAudioDriver.driver
   ```

2. **Check in Audio MIDI Setup:**

   - Open `/Applications/Utilities/Audio MIDI Setup.app`
   - Look for "Surge Audio" in the device list

3. **Check in your app:**
   - The app will log which capture method is being used:
     - `✅ Using Surge Audio virtual driver (no screen recording icon)` - Good!
     - `⚠️ Using ScreenCaptureKit (screen recording icon will appear)` - Driver not installed

## Comparison

| Feature             | With Surge Audio Driver | Without (ScreenCaptureKit) |
| ------------------- | ----------------------- | -------------------------- |
| Recording Icon      | ❌ None                 | ✅ Shows in menu bar       |
| Permission Required | Audio only              | Screen Recording           |
| User Experience     | Seamless                | Permission prompts         |
| Installation        | One-time (admin)        | None                       |

## Troubleshooting

### "Surge Audio driver not installed" Error

Run the installer:

```bash
cd surge-audio-driver
./install.sh
```

### No Audio Being Captured

1. Make sure "Surge Audio" is set as your system output
2. Verify audio is playing
3. Check Console.app for "SurgeAudioDriver" logs

### Driver Not Appearing After Install

Restart Core Audio:

```bash
sudo launchctl kickstart -kp system/com.apple.audio.coreaudiod
```

Or restart your Mac.

### Build Errors

Make sure Xcode Command Line Tools are installed:

```bash
xcode-select --install
```

## Uninstalling

To remove the driver:

```bash
cd surge-audio-driver
./uninstall.sh
```

Or manually:

```bash
sudo rm -rf /Library/Audio/Plug-Ins/HAL/SurgeAudioDriver.driver
sudo launchctl kickstart -kp system/com.apple.audio.coreaudiod
```

## Architecture

```
surge-audio-driver/
├── src/
│   └── SurgeAudioDriver.c    # HAL plugin implementation
├── Info.plist                 # Plugin metadata
├── build.sh                   # Build script
├── install.sh                 # Installer (requires admin)
├── uninstall.sh              # Uninstaller
└── README.md                 # Driver documentation

native-audio/
├── src/
│   ├── audio_capture.mm       # ScreenCaptureKit capture (legacy)
│   └── VirtualAudioCapture.mm # Surge Audio capture (new)
├── index.js                   # JS wrapper with SmartAudioCapture
└── binding.gyp               # Build configuration
```

## API Usage

```javascript
// In main process (main.js)
const { SmartAudioCapture } = require("./native-audio");

// Automatically uses best available method
const capture = new SmartAudioCapture((audioData) => {
  // Process audio...
});

const result = capture.start();
console.log("Capture method:", result.method);
// 'virtualDriver' = Surge Audio (no icon)
// 'screenCapture' = ScreenCaptureKit (with icon)

// Check driver status
const { VirtualAudioCapture } = require("./native-audio");
const vc = new VirtualAudioCapture(() => {});
console.log("Driver installed:", vc.isDriverInstalled());
```

## Security Notes

- The driver is installed to `/Library/Audio/Plug-Ins/HAL/` (system location)
- Requires admin password for installation
- Only captures audio routed to the virtual device
- Does not capture screen content
- No special entitlements required for your app

## Requirements

- macOS 12.0 (Monterey) or later
- Xcode Command Line Tools
- Node.js 16+ (for building native module)
- Administrator access (for driver installation)
