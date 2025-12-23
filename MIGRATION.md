# Migration Guide: ScreenCaptureKit → HAL AudioServerPlugIn

## Summary of Changes

This migration removes all ScreenCaptureKit dependencies and replaces them with a custom HAL AudioServerPlugIn driver. This provides:

✅ **No screen recording indicators**  
✅ **Works with headphones**  
✅ **No screen recording permission** (only system extension approval)  
✅ **Silent operation**

## What Was Removed

### Code Files (DEPRECATED - Keep for reference only)

- ❌ `native-audio/src/speaker_audio_capture.mm` - ScreenCaptureKit implementation
  - **Status**: Replaced by `speaker_audio_capture_driver.mm`
  - **Action**: Can be deleted after verification

### Code References Removed

1. **Framework Dependencies**
   - Removed: `ScreenCaptureKit.framework`
   - Removed: `AVFoundation.framework` (was only needed for ScreenCaptureKit)
   - Removed: `CoreMedia.framework` (was only needed for ScreenCaptureKit)
   - Added: `CoreAudio.framework` (for HAL driver)

2. **Build Configuration** (`binding.gyp`)
   - Removed ScreenCaptureKit framework links
   - Updated to use CoreAudio only
   - New target: `driver_audio_capture`

3. **Error Messages**
   - Removed all "Screen Recording permission" references
   - Updated to mention "HAL audio driver" and "system extension approval"

## What Was Added

### New Files

1. **HAL AudioServerPlugIn Driver** (`native-audio/src/audio_driver/`)
   - `audio_driver.h` - Driver header with ring buffer structure
   - `audio_driver.c` - Core driver logic (shared memory, ring buffer)
   - `audio_driver_complete.c` - Complete HAL interface implementation
   - `Info.plist` - Driver bundle metadata

2. **Electron Native Addon** (`native-audio/src/speaker_audio_capture_driver.mm`)
   - Connects to driver via POSIX shared memory
   - Reads from ring buffer and delivers to JavaScript

3. **Build & Installation Scripts** (`scripts/`)
   - `build-driver.sh` - Builds the driver bundle
   - `install-driver.sh` - Installs driver to `/Library/Audio/Plug-Ins/HAL/`
   - `uninstall-driver.sh` - Removes the driver

4. **Documentation**
   - `ARCHITECTURE.md` - Complete architecture overview
   - `SIGNING.md` - Code signing and notarization guide
   - `MIGRATION.md` - This file

### Updated Files

1. **`native-audio/index.js`**
   - Updated to use `DriverAudioCapture` class
   - Added `checkDriverAvailable()` method
   - Updated error messages

2. **`src/main.js`**
   - Removed ScreenCaptureKit error messages
   - Updated to mention HAL driver

3. **`src/renderer/renderer.js`**
   - Updated comments to mention HAL driver instead of ScreenCaptureKit

4. **`src/renderer/audioCapture.js`**
   - Removed ScreenCaptureKit references in error messages
   - Updated to mention HAL driver

## Migration Steps

### 1. Build the Driver

```bash
cd native-audio
./scripts/build-driver.sh
```

### 2. Code Sign the Driver

See `SIGNING.md` for detailed signing instructions.

```bash
codesign --force --deep --sign "Developer ID Application: Your Name" \
  --entitlements entitlements-driver.plist \
  --options runtime \
  build/GrowhutAudioDriver.driver
```

### 3. Install the Driver

```bash
sudo ./scripts/install-driver.sh
```

### 4. User Approval (One-Time)

After installation, macOS will show:
> "System software from developer was blocked"

User must:
1. Open System Settings > Privacy & Security
2. Click "Allow" next to Growhut Audio Driver
3. May need to restart the app

### 5. Build Electron Native Addon

```bash
cd native-audio
npm install
npm run rebuild
```

This will build `driver_audio_capture.node` (the Electron addon).

### 6. Test the Integration

1. Set the virtual audio device as system output:
   ```bash
   # Optional: Can be done programmatically or user sets manually
   # System Settings > Sound > Output > Growhut Audio Driver
   ```

2. Start your Electron app

3. Start speaker capture - should work without screen recording permission!

### 7. Clean Up (After Verification)

Once everything works:

```bash
# Optional: Remove old ScreenCaptureKit file
rm native-audio/src/speaker_audio_capture.mm

# Keep binding.gyp updated (already done)
```

## Differences in Behavior

| Aspect | ScreenCaptureKit (Old) | HAL Driver (New) |
|--------|------------------------|------------------|
| Permission | Screen Recording | System Extension (one-time) |
| Indicator | Red dot in menu bar | None |
| Headphones | Required Multi-Output Device | Works directly |
| User Dialog | Screen sharing dialog | None (after approval) |
| Latency | Medium | Low |
| Installation | No installation | Requires driver install |

## Troubleshooting

### Driver Not Found

**Symptom**: `checkDriverAvailable()` returns false

**Solutions**:
1. Verify driver is installed: `ls /Library/Audio/Plug-Ins/HAL/GrowhutAudioDriver.driver`
2. Check driver was approved in System Settings
3. Restart CoreAudio: `sudo launchctl kickstart -k system/com.apple.audio.coreaudiod`

### No Audio Captured

**Symptom**: Capture starts but no audio data

**Solutions**:
1. Verify virtual device is set as system output
2. Check `atomic_load(&ring_buffer->active)` is true in driver
3. Verify audio is actually playing on the system
4. Check shared memory exists: `ls -la /dev/shm/com.growhut.audiodriver.shm`

### Build Errors

**Symptom**: Native module won't build

**Solutions**:
1. Ensure macOS 13+ SDK is installed
2. Check Xcode Command Line Tools: `xcode-select --install`
3. Verify binding.gyp has correct paths
4. Check node-addon-api is installed: `npm install node-addon-api`

### Code Signing Issues

See `SIGNING.md` for detailed signing troubleshooting.

## Rollback Plan

If you need to rollback to ScreenCaptureKit:

1. Restore `native-audio/src/speaker_audio_capture.mm` (if deleted)
2. Update `binding.gyp` to use ScreenCaptureKit frameworks
3. Update `native-audio/index.js` to use `AudioCapture` instead of `DriverAudioCapture`
4. Rebuild: `npm run rebuild`
5. Uninstall driver: `sudo ./scripts/uninstall-driver.sh`

## Next Steps

1. ✅ Complete migration (this guide)
2. ⏳ Test on clean macOS installation
3. ⏳ Update CI/CD to build and sign driver
4. ⏳ Update user documentation
5. ⏳ Submit for notarization

## Support

For issues or questions:
- Check `ARCHITECTURE.md` for system architecture
- Check `SIGNING.md` for signing issues
- Review Apple's HAL AudioServerPlugIn documentation

