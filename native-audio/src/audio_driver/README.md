# HAL AudioServerPlugIn Driver

Complete implementation of a HAL AudioServerPlugIn driver for system audio capture.

## Files

- **audio_driver.h** - Header file with data structures and function declarations
- **audio_driver.c** - Core driver logic (shared memory, ring buffer, audio processing)
- **audio_driver_properties.c** - Complete CoreAudio property handling
- **audio_driver_complete.c** - HAL interface implementation (IOProc, device management)
- **main.c** - Entry point (currently minimal, factory is in audio_driver_complete.c)
- **Info.plist** - Driver bundle metadata
- **Makefile** - Build system (alternative to build script)

## Building

### Using the build script (recommended):
```bash
cd native-audio
./scripts/build-driver.sh
```

### Using Makefile:
```bash
cd native-audio/src/audio_driver
make
```

### Manual build:
```bash
clang -std=c11 -fPIC -Wall -Wextra -O2 \
    -I. \
    -framework CoreAudio \
    -framework CoreFoundation \
    -framework IOKit \
    -dynamiclib \
    -install_name "@rpath/GrowhutAudioDriver" \
    -compatibility_version 1.0.0 \
    -current_version 1.0.0 \
    -mmacosx-version-min=13.0 \
    -o GrowhutAudioDriver \
    audio_driver.c \
    audio_driver_properties.c \
    audio_driver_complete.c
```

## Architecture

1. **Driver Initialization**: HAL loads the plug-in, calls `AudioDriverPlugInFactory`
2. **Device Creation**: Driver creates virtual audio output device
3. **Shared Memory**: Creates POSIX shared memory ring buffer for audio data
4. **Audio Capture**: IOProc callback receives system audio, writes to ring buffer
5. **Electron Integration**: Native addon reads from ring buffer and delivers to JavaScript

## Key Features

- ✅ Complete CoreAudio property handling
- ✅ Virtual audio output device
- ✅ Shared memory ring buffer (thread-safe, atomic operations)
- ✅ Stereo to mono downmix
- ✅ 48kHz Float32 PCM format
- ✅ Low latency audio capture

## Installation

After building and code signing:
```bash
sudo ./scripts/install-driver.sh
```

Or manually:
```bash
sudo cp -R build/GrowhutAudioDriver.driver /Library/Audio/Plug-Ins/HAL/
sudo chown -R root:wheel /Library/Audio/Plug-Ins/HAL/GrowhutAudioDriver.driver
sudo launchctl kickstart -k system/com.apple.audio.coreaudiod
```

## Code Signing

The driver **must** be code signed before installation:

```bash
codesign --force --deep --sign "Developer ID Application: Your Name (TEAM_ID)" \
  --entitlements entitlements-driver.plist \
  --options runtime \
  build/GrowhutAudioDriver.driver
```

## User Approval

After installation, users must approve the driver in:
**System Settings > Privacy & Security > Allow Growhut Audio Driver**

This is a one-time approval per user.

