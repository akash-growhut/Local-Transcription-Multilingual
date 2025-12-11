# ScreenCaptureKit Swift Implementation

## Why Swift is Required

ScreenCaptureKit's async API (`SCShareableContent.excludingDesktopWindows`) is **Swift-only** and uses async/await syntax. To use it from our Objective-C++ native module, we need a Swift bridge.

## Current Status

✅ **Swift code written**: `src/ScreenCaptureKitBridge.swift`  
✅ **Objective-C++ bridge code**: `src/audio_capture.mm`  
❌ **Swift compilation**: Requires full Xcode (not just Command Line Tools)

## The Problem

Command Line Tools have limitations:
- Swift compiler version mismatches with SDK
- Missing PackageDescription libraries  
- Module conflicts with bridging headers

## Solution: Use Full Xcode

### Step 1: Install Xcode
1. Install Xcode from the Mac App Store
2. Open Xcode once to accept license
3. Install additional components if prompted

### Step 2: Set Xcode Path
```bash
sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
```

### Step 3: Build Swift Module
```bash
cd native-audio
./build_swift.sh
```

### Step 4: Build Native Module
```bash
npm run rebuild
```

## Alternative: Use Web API (Current)

The app currently uses `getDisplayMedia` as fallback:
- ✅ Works immediately
- ✅ No compilation needed
- ⚠️ Requires user to select audio in dialog
- ⚠️ Requires screen sharing permission

## Testing Web API

1. Run `npm start`
2. Click "Start Capture" for speaker
3. **In the dialog:**
   - Select a screen/window
   - ✅ **CHECK "Share audio"**
   - Click "Share"
4. Audio should flow to Deepgram

## Once Swift is Compiled

After successful Swift compilation:
- ✅ Silent system audio capture
- ✅ No user interaction (after permission)
- ✅ Automatic primary display selection
- ✅ True native ScreenCaptureKit

The code is ready - it just needs Xcode to compile the Swift bridge!

