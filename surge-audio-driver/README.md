# Surge Audio Driver

A virtual audio driver for macOS that enables system audio capture without requiring screen recording permissions or showing the screen recording icon.

## How It Works

The Surge Audio Driver creates a virtual audio device that appears in your system as both an input and output device. When you set it as your system's output device:

1. **All system audio** is routed through the virtual device
2. **Your app** can capture this audio from the device's input
3. **No screen recording permission** is required
4. **No screen recording icon** appears in the menu bar

## Requirements

- macOS 12.0 or later
- Xcode Command Line Tools (`xcode-select --install`)
- Administrator privileges (for installation)

## Installation

### Quick Install

```bash
cd surge-audio-driver
./install.sh
```

This will:

1. Build the driver if not already built
2. Prompt for your admin password
3. Install the driver to `/Library/Audio/Plug-Ins/HAL/`
4. Restart the Core Audio daemon

### Manual Install

```bash
# Build the driver
./build.sh

# Install (requires sudo)
sudo cp -R build/SurgeAudioDriver.driver /Library/Audio/Plug-Ins/HAL/
sudo launchctl kickstart -kp system/com.apple.audio.coreaudiod
```

## Usage

After installation, "Surge Audio" will appear in:

- **System Preferences > Sound** (as both input and output)
- **Audio MIDI Setup** app

### For System Audio Capture

1. **Set Surge Audio as output**: Go to System Preferences > Sound > Output and select "Surge Audio"
2. **Capture from Surge Audio input**: Your app can now record from "Surge Audio" input device
3. **Audio routing**: Audio will be looped from output to input

### In Your Code

```javascript
const { SmartAudioCapture } = require("./native-audio");

const capture = new SmartAudioCapture((audioBuffer) => {
  // Process audio data
  console.log("Received audio:", audioBuffer.length, "samples");
});

// Start capture (automatically uses Surge Audio if installed)
const result = capture.start();
if (result.success) {
  console.log("Capturing with method:", result.method);
  // 'virtualDriver' = Surge Audio (no icon)
  // 'screenCapture' = ScreenCaptureKit (shows icon)
}

// Stop capture
capture.stop();
```

## Uninstallation

```bash
cd surge-audio-driver
./uninstall.sh
```

Or manually:

```bash
sudo rm -rf /Library/Audio/Plug-Ins/HAL/SurgeAudioDriver.driver
sudo launchctl kickstart -kp system/com.apple.audio.coreaudiod
```

## Troubleshooting

### Device Not Appearing

1. Make sure the driver is correctly installed:

   ```bash
   ls -la /Library/Audio/Plug-Ins/HAL/SurgeAudioDriver.driver
   ```

2. Restart Core Audio:

   ```bash
   sudo launchctl kickstart -kp system/com.apple.audio.coreaudiod
   ```

3. Check for errors in Console.app (filter by "SurgeAudioDriver")

### No Audio Being Captured

1. Verify Surge Audio is set as the system output device
2. Make sure audio is actually playing on your system
3. Check that your app is capturing from the correct input device

### Build Errors

Make sure Xcode Command Line Tools are installed:

```bash
xcode-select --install
```

## Technical Details

The driver is implemented as an **AudioServerPlugin** (HAL plugin) that:

- Creates a virtual audio device with both input and output streams
- Uses a ring buffer to route audio from output to input
- Supports sample rates: 44.1kHz, 48kHz, 96kHz, 192kHz
- Supports 2-channel (stereo) 32-bit float audio

## Comparison with ScreenCaptureKit

| Feature                     | Surge Audio Driver | ScreenCaptureKit |
| --------------------------- | ------------------ | ---------------- |
| Screen recording icon       | ❌ No              | ✅ Yes           |
| Screen recording permission | ❌ Not required    | ✅ Required      |
| Audio quality               | Lossless           | Lossless         |
| System-wide capture         | ✅ Yes             | ✅ Yes           |
| Installation required       | ✅ Yes (once)      | ❌ No            |
| Admin privileges            | ✅ For install     | ❌ No            |

## License

MIT License - See LICENSE file for details.
