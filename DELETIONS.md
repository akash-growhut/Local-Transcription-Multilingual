# Files to Delete After Migration Verification

Once you've verified the HAL AudioServerPlugIn driver is working correctly, you can safely delete these files that are no longer needed:

## Deprecated Files

### 1. ScreenCaptureKit Implementation

**File**: `native-audio/src/speaker_audio_capture.mm`

**Status**: ❌ Deprecated - Replaced by `speaker_audio_capture_driver.mm`

**Action**: Can be deleted after verifying the new driver-based implementation works

**Why**: This file contains the old ScreenCaptureKit implementation that triggers screen recording indicators and requires screen recording permissions.

---

## Files to Keep

### Do NOT Delete These (They're Still Used)

- ✅ `native-audio/src/microphone_rnnoise.cpp` - Microphone noise cancellation (still used)
- ✅ `native-audio/src/speaker_audio_capture_win.cpp` - Windows audio capture (still used)
- ✅ `native-audio/src/rnnoise/` - RNNoise library (still used)

---

## Verification Before Deletion

Before deleting `speaker_audio_capture.mm`, verify:

1. ✅ Driver builds successfully
2. ✅ Driver installs without errors
3. ✅ Driver is approved in System Settings
4. ✅ Electron addon builds successfully (`npm run rebuild`)
5. ✅ Audio capture works with the new driver
6. ✅ No screen recording indicator appears
7. ✅ Works with headphones
8. ✅ Audio flows to Deepgram correctly

## Safe Deletion Command

Once verified, you can delete the deprecated file:

```bash
# Backup first (optional)
cp native-audio/src/speaker_audio_capture.mm native-audio/src/speaker_audio_capture.mm.backup

# Delete
rm native-audio/src/speaker_audio_capture.mm
```

## Git History

If you want to keep the file in Git history for reference, you can:

```bash
# Delete from working directory but keep in Git
git rm native-audio/src/speaker_audio_capture.mm
git commit -m "Remove deprecated ScreenCaptureKit implementation"
```

The file will still be accessible via `git show` or `git checkout <commit> -- native-audio/src/speaker_audio_capture.mm`

