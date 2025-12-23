# HAL AudioServerPlugIn Architecture

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         macOS System                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────┐         ┌────────────────────────────┐  │
│  │  Audio Apps      │────────▶│  CoreAudio HAL             │  │
│  │  (YouTube, etc.) │         │  (Hardware Abstraction)    │  │
│  └──────────────────┘         └──────────────┬─────────────┘  │
│                                               │                │
│                                               ▼                │
│                                    ┌──────────────────────┐   │
│                                    │  HAL AudioServerPlugIn│   │
│                                    │  (Virtual Output)    │   │
│                                    │  - Receives audio    │   │
│                                    │  - Writes to shared  │   │
│                                    │    memory ring buffer│   │
│                                    └──────────┬───────────┘   │
│                                               │                │
└───────────────────────────────────────────────┼────────────────┘
                                                │
                     ┌──────────────────────────┴──────────────┐
                     │      POSIX Shared Memory                │
                     │  /dev/shm/com.growhut.audiodriver.shm   │
                     │  ┌──────────────────────────────────┐  │
                     │  │  AudioRingBuffer                 │  │
                     │  │  - write_position (atomic)       │  │
                     │  │  - read_position (atomic)        │  │
                     │  │  - active flag (atomic)          │  │
                     │  │  - float buffer[96000 frames]    │  │
                     │  └──────────────────────────────────┘  │
                     └────────────────┬───────────────────────┘
                                      │
                    ┌─────────────────┴─────────────────────┐
                    │                                       │
        ┌───────────▼──────────┐            ┌──────────────▼──────────┐
        │  Electron Native     │            │  Physical Audio Output  │
        │  Addon               │            │  (Speakers/Headphones)  │
        │  - Reads from        │            │  - Audio still plays    │
        │    shared memory     │            │    normally             │
        │  - Calls callback    │            │                         │
        └──────────┬───────────┘            └─────────────────────────┘
                   │
        ┌──────────▼───────────┐
        │  Electron Main       │
        │  Process             │
        │  - Converts Float32  │
        │    to Int16          │
        │  - Sends to Deepgram │
        └──────────────────────┘
```

## File Structure

```
native-audio/
├── src/
│   ├── audio_driver/              # HAL AudioServerPlugIn Driver
│   │   ├── audio_driver.h         # Driver header
│   │   ├── audio_driver.c         # Core driver logic (shared memory, ring buffer)
│   │   ├── audio_driver_complete.c # Complete HAL interface implementation
│   │   └── Info.plist             # Driver bundle metadata
│   │
│   ├── speaker_audio_capture_driver.mm  # Electron addon (connects to driver)
│   ├── speaker_audio_capture.mm          # OLD - ScreenCaptureKit (DEPRECATED)
│   └── ...
│
├── index.js                        # Updated wrapper (uses DriverAudioCapture)
└── binding.gyp                     # Build configuration
```

## Data Flow

1. **System Audio Output** → CoreAudio HAL routes audio to virtual output device
2. **HAL Plug-in** → Receives audio via IOProc callback
3. **Ring Buffer** → Downmix stereo→mono, write to shared memory ring buffer
4. **Electron Addon** → Reads from ring buffer in separate thread
5. **JavaScript Callback** → Float32 PCM frames delivered to Node.js
6. **Deepgram** → Converted to Int16, sent via WebSocket

## Key Components

### 1. HAL AudioServerPlugIn (`audio_driver/`)

- **Purpose**: Virtual audio output device that receives system audio
- **Location**: `/Library/Audio/Plug-Ins/HAL/GrowhutAudioDriver.driver`
- **Permissions**: System extension approval required (one-time)
- **Format**: 48kHz Float32 PCM, stereo input → mono output

### 2. Shared Memory Ring Buffer

- **Type**: POSIX shared memory (`/dev/shm/com.growhut.audiodriver.shm`)
- **Size**: 2 seconds @ 48kHz = 96,000 frames × sizeof(float) × 2 channels
- **Access**: Atomic operations for thread-safe read/write
- **Semantics**: Circular buffer, overwrites oldest data when full

### 3. Electron Native Addon (`speaker_audio_capture_driver.mm`)

- **Purpose**: Bridge between shared memory and JavaScript
- **Threading**: Separate read thread polls ring buffer
- **Format**: Float32 PCM mono, 48kHz
- **API**: N-API (Node.js Addon API)

## Installation Flow

1. **Build Driver Bundle**
   ```bash
   cd native-audio
   xcodebuild -project AudioDriver.xcodeproj -scheme GrowhutAudioDriver
   ```

2. **Install to System**
   ```bash
   sudo cp -R GrowhutAudioDriver.driver /Library/Audio/Plug-Ins/HAL/
   sudo chown -R root:wheel /Library/Audio/Plug-Ins/HAL/GrowhutAudioDriver.driver
   ```

3. **Load Driver**
   ```bash
   sudo launchctl kickstart -k system/com.apple.audio.coreaudiod
   ```

4. **User Approval**
   - macOS shows: "System software from developer was blocked"
   - User goes to: System Settings > Privacy & Security
   - Clicks: "Allow" next to Growhut Audio Driver

5. **Set as Output** (optional, can be done programmatically)
   - System Settings > Sound > Output
   - Select "Growhut Audio Driver"

## Code Signing & Notarization

### Entitlements Required

```xml
<key>com.apple.security.app-sandbox</key>
<false/>
<key>com.apple.security.system-extension</key>
<true/>
<key>com.apple.security.device.audio-input</key>
<true/>
```

### Signing Commands

```bash
# Sign driver bundle
codesign --force --deep --sign "Developer ID Application: Your Name" \
  GrowhutAudioDriver.driver

# Sign Electron app
codesign --force --deep --sign "Developer ID Application: Your Name" \
  --entitlements entitlements.plist \
  YourApp.app

# Notarize (requires Apple Developer account)
xcrun notarytool submit YourApp.zip \
  --apple-id your@email.com \
  --team-id YOUR_TEAM_ID \
  --password YOUR_APP_SPECIFIC_PASSWORD
```

## Benefits Over ScreenCaptureKit

✅ **No screen recording indicator**  
✅ **Works with headphones** (no need for Multi-Output Device)  
✅ **No screen recording permission** (only system extension approval)  
✅ **Lower latency** (direct audio path)  
✅ **Silent operation** (no user dialogs after initial approval)  
✅ **Production-grade** (same approach as Granola, BlackHole, etc.)

## Limitations & Risks

⚠️ **System Extension Approval**: One-time user approval required  
⚠️ **macOS Version**: Requires macOS 13+ (Ventura+)  
⚠️ **Installation Complexity**: Requires root/admin privileges for installation  
⚠️ **Audio Routing**: Users may need to set virtual device as output (can be automated)  
⚠️ **Development**: More complex than ScreenCaptureKit (but worth it for production)

