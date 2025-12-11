# Building Swift ScreenCaptureKit Bridge

## The Challenge

ScreenCaptureKit's async API (`SCShareableContent.excludingDesktopWindows`) is **Swift-only** and uses async/await syntax that doesn't directly translate to Objective-C++. To use it, we need to compile Swift code.

## Current Status

The native module structure is in place, but Swift compilation requires:
- **Full Xcode** (not just Command Line Tools)
- Matching Swift compiler and SDK versions
- Proper module configuration

## Option 1: Use Full Xcode (Recommended)

1. **Install Xcode from App Store** (not just Command Line Tools)

2. **Open Terminal and set Xcode path:**
```bash
sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
```

3. **Build the Swift module:**
```bash
cd native-audio
./build_swift.sh
```

4. **Then build the native module:**
```bash
npm run rebuild
```

## Option 2: Use Web API Fallback (Current)

The app currently falls back to the web API method (`getDisplayMedia`), which:
- ✅ Works immediately
- ✅ No compilation needed
- ⚠️ Requires user to select audio source in dialog each time
- ⚠️ Requires screen sharing permission

## Option 3: Create Separate Swift Framework

Create a standalone Swift framework project in Xcode:

1. Create new Xcode project → Framework
2. Add `ScreenCaptureKitBridge.swift`
3. Build framework
4. Link framework in `binding.gyp`

## Current Implementation

The code is structured to:
1. Try to load Swift bridge at runtime
2. If Swift bridge not available, return `false`
3. Main process falls back to web API method
4. User selects audio source in browser dialog

## Testing

To test the current web API method:
1. Run `npm start`
2. Click "Start Capture" for speaker audio
3. Select a screen/window in the dialog
4. **Check "Share audio" checkbox**
5. Click "Share"

The web API method works, but requires user interaction each time.

## Future: Full Native Implementation

Once Swift is properly compiled:
- ✅ Silent, automatic system audio capture
- ✅ No user interaction needed (after permission)
- ✅ Works in background
- ✅ True native ScreenCaptureKit implementation

