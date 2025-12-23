# HAL AudioServerPlugIn Driver - Quick Start

## What Changed?

Your Electron app now uses a **custom HAL AudioServerPlugIn driver** instead of ScreenCaptureKit for system audio capture. This means:

- ✅ **No screen recording indicator** (no red dot)
- ✅ **Works with headphones** (no Multi-Output Device needed)
- ✅ **No screen recording permission** (only one-time system extension approval)
- ✅ **Silent operation** after initial setup

## Quick Setup

### 1. Build the Driver

```bash
cd native-audio
./scripts/build-driver.sh
```

### 2. Code Sign (Required)

```bash
# Replace with your Developer ID
codesign --force --deep --sign "Developer ID Application: Your Name (TEAM_ID)" \
  --entitlements entitlements-driver.plist \
  --options runtime \
  build/GrowhutAudioDriver.driver
```

### 3. Install

```bash
sudo ./scripts/install-driver.sh
```

### 4. User Approval

macOS will prompt: **"System software from developer was blocked"**

User must:
1. Open **System Settings > Privacy & Security**
2. Click **"Allow"** next to "Growhut Audio Driver"
3. Restart the app if needed

### 5. Build Electron Addon

```bash
cd native-audio
npm install
npm run rebuild
```

### 6. Use in Your App

The JavaScript API is unchanged:

```javascript
const AudioCapture = require('./native-audio');

const capture = new AudioCapture((audioBuffer) => {
  // audioBuffer is Float32Array, 48kHz mono
});

// Check if driver is available
const available = await capture.checkDriverAvailable();

if (available) {
  const result = capture.start();
  // Start capturing system audio
}
```

## Architecture

```
System Audio → HAL Driver → Shared Memory → Electron Addon → Your App → Deepgram
```

See `ARCHITECTURE.md` for detailed architecture documentation.

## File Structure

```
native-audio/
├── src/
│   ├── audio_driver/              # HAL AudioServerPlugIn Driver
│   │   ├── audio_driver.h
│   │   ├── audio_driver.c
│   │   ├── audio_driver_complete.c
│   │   └── Info.plist
│   └── speaker_audio_capture_driver.mm  # Electron addon
└── index.js                        # JavaScript wrapper

scripts/
├── build-driver.sh                 # Build driver bundle
├── install-driver.sh               # Install to /Library/Audio/Plug-Ins/HAL/
└── uninstall-driver.sh             # Remove driver
```

## Troubleshooting

### Driver Not Available

```bash
# Check if installed
ls -la /Library/Audio/Plug-Ins/HAL/GrowhutAudioDriver.driver

# Check if approved
# System Settings > Privacy & Security > Allow Growhut Audio Driver

# Restart CoreAudio
sudo launchctl kickstart -k system/com.apple.audio.coreaudiod
```

### No Audio

1. Set virtual device as system output:
   - System Settings > Sound > Output > **Growhut Audio Driver**
2. Verify audio is playing
3. Check shared memory exists: `ls -la /dev/shm/com.growhut.audiodriver.shm`

### Build Errors

- Ensure macOS 13+ SDK: `xcodebuild -showsdks`
- Install Xcode Command Line Tools: `xcode-select --install`
- Check node-addon-api: `npm install node-addon-api`

## Documentation

- **`ARCHITECTURE.md`** - Complete system architecture
- **`SIGNING.md`** - Code signing and notarization guide
- **`MIGRATION.md`** - Migration guide from ScreenCaptureKit
- **`IMPLEMENTATION_SUMMARY.md`** - Implementation details

## Important Notes

⚠️ **The HAL AudioServerPlugIn implementation provided is a skeleton**. A production-ready implementation requires:

- Complete CoreAudio property handling
- Proper device registration and discovery  
- Stream creation and IOProc management
- Comprehensive error handling

**Recommendation**: Use [BlackHole](https://github.com/ExistentialAudio/BlackHole) as a reference implementation or consider integrating it directly.

## Benefits Over ScreenCaptureKit

| Feature | ScreenCaptureKit | HAL Driver |
|---------|------------------|------------|
| Screen Recording Indicator | ❌ Yes (red dot) | ✅ No |
| Headphones Support | ❌ Needs Multi-Output | ✅ Direct |
| Permission Type | Screen Recording | System Extension (one-time) |
| User Dialog | Screen sharing dialog | None (after approval) |
| Installation | No installation | Driver install required |

## Next Steps

1. Complete HAL implementation (or use BlackHole as reference)
2. Test on clean macOS installation
3. Set up automated signing in CI/CD
4. Add driver installation to app installer
5. Submit for Apple notarization

## Support

For detailed information, see:
- `ARCHITECTURE.md` - System architecture
- `SIGNING.md` - Code signing issues
- `MIGRATION.md` - Migration from ScreenCaptureKit

