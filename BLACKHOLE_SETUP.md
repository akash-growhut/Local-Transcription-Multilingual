# BlackHole Audio Capture Setup

This app uses **BlackHole** (a virtual audio driver) to capture system audio on macOS. BlackHole creates a virtual audio device that can be used to route audio for capture.

## How It Works

1. **BlackHole Driver**: A virtual audio device that appears in your system audio settings
2. **Multi-Output Device**: Combines your real speakers/headphones with BlackHole so audio plays through both
3. **Audio Capture**: The app captures audio from BlackHole, which receives a copy of all system audio

## Automatic Setup

The app will attempt to:

- ✅ Check if BlackHole is installed
- ✅ Install BlackHole from the bundled driver (if not installed)
- ✅ Verify BlackHole is available

## Manual Setup (First Time)

If automatic setup fails, follow these steps:

### Step 1: Install BlackHole

The app includes BlackHole in the bundle. If installation fails:

1. Download BlackHole manually from: https://github.com/ExistentialAudio/BlackHole/releases
2. Install the `.pkg` file
3. Restart your Mac

### Step 2: Create Multi-Output Device

1. Open **Audio MIDI Setup** (Applications > Utilities, or Spotlight search)
2. Click the **+** button at the bottom left
3. Select **Create Multi-Output Device**
4. Check both:
   - Your current output device (MacBook Speakers, AirPods, etc.)
   - **BlackHole 2ch**
5. Close Audio MIDI Setup

### Step 3: Set as System Output

1. Open **System Settings** > **Sound**
2. Set **Output** to the Multi-Output Device you just created
3. Audio will now play through both your speakers AND BlackHole

### Step 4: Start Capture

1. Start the app's speaker capture
2. Audio should now be captured from BlackHole

## Troubleshooting

### "BlackHole not found"

- Ensure BlackHole is installed: `/Library/Audio/Plug-Ins/HAL/BlackHole.driver`
- Restart your Mac after installation
- Check Audio MIDI Setup to see if BlackHole appears

### "No audio captured"

- Verify Multi-Output Device is set as system output
- Check that both devices are enabled in Multi-Output Device
- Ensure audio is actually playing (play a video, music, etc.)
- Check app console for error messages

### "Installation requires password"

- The app needs admin privileges to install BlackHole
- Enter your password when prompted
- If you prefer, install BlackHole manually (see Step 1 above)

### Audio plays but capture doesn't work

- Verify BlackHole 2ch is checked in Multi-Output Device
- Try unchecking and re-checking BlackHole in Multi-Output Device
- Restart the app

## Technical Details

- **BlackHole Version**: 0.6.1 (2ch version)
- **Audio Format**: 48kHz, Float32, Mono (converted from stereo)
- **Capture Method**: CoreAudio HAL Output AudioUnit
- **Driver Location**: `/Library/Audio/Plug-Ins/HAL/BlackHole.driver`

## Why BlackHole?

On modern macOS, Apple restricts direct hardware audio loopback. BlackHole provides a reliable, App Store-compatible solution that:

- ✅ Works with all audio sources
- ✅ No screen recording permission needed
- ✅ Works with headphones, Bluetooth, HDMI
- ✅ No echo or feedback
- ✅ Low latency

## Alternative Solutions

If BlackHole doesn't work for you:

- **ScreenCaptureKit**: Requires screen recording permission (shows screen share icon)
- **Custom Virtual Driver**: Complex, requires kernel extension (not App Store compatible)
