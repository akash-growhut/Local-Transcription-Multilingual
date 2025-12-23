# Code Signing & Notarization Guide

## Overview

The HAL AudioServerPlugIn driver requires proper code signing and notarization to work on macOS. This guide explains the process.

## Prerequisites

1. **Apple Developer Account** (paid membership required for signing)
2. **Developer ID Certificate** for signing
3. **App-Specific Password** for notarization

## Step 1: Obtain Certificates

1. Log in to [Apple Developer Portal](https://developer.apple.com)
2. Go to Certificates, Identifiers & Profiles
3. Create a **Developer ID Application** certificate (for app signing)
4. Create a **Developer ID Installer** certificate (for installer/packages)

## Step 2: Create Entitlements File

Create `entitlements-driver.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.app-sandbox</key>
    <false/>
    <key>com.apple.security.system-extension</key>
    <true/>
    <key>com.apple.security.device.audio-input</key>
    <true/>
    <key>com.apple.security.device.usb</key>
    <false/>
</dict>
</plist>
```

Create `entitlements-app.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.app-sandbox</key>
    <false/>
    <key>com.apple.security.automation.apple-events</key>
    <true/>
</dict>
</plist>
```

## Step 3: Sign the Driver Bundle

```bash
# Sign the driver executable
codesign --force --deep --sign "Developer ID Application: Your Name (TEAM_ID)" \
  --entitlements entitlements-driver.plist \
  --options runtime \
  --timestamp \
  build/GrowhutAudioDriver.driver/Contents/MacOS/GrowhutAudioDriver

# Sign the entire driver bundle
codesign --force --deep --sign "Developer ID Application: Your Name (TEAM_ID)" \
  --entitlements entitlements-driver.plist \
  --options runtime \
  --timestamp \
  build/GrowhutAudioDriver.driver

# Verify signature
codesign --verify --verbose build/GrowhutAudioDriver.driver
spctl --assess --verbose build/GrowhutAudioDriver.driver
```

## Step 4: Sign the Electron App

```bash
# Sign the Electron app
codesign --force --deep --sign "Developer ID Application: Your Name (TEAM_ID)" \
  --entitlements entitlements-app.plist \
  --options runtime \
  --timestamp \
  dist/mac/YourApp.app

# Verify signature
codesign --verify --verbose dist/mac/YourApp.app
```

## Step 5: Notarize the App

```bash
# Create a zip file for notarization
cd dist/mac
zip -r YourApp.zip YourApp.app
cd ../..

# Submit for notarization
xcrun notarytool submit dist/mac/YourApp.zip \
  --apple-id "your@email.com" \
  --team-id "YOUR_TEAM_ID" \
  --password "your-app-specific-password" \
  --wait

# Check notarization status
xcrun notarytool history \
  --apple-id "your@email.com" \
  --team-id "YOUR_TEAM_ID" \
  --password "your-app-specific-password"

# Staple the notarization ticket
xcrun stapler staple dist/mac/YourApp.app
```

## Step 6: Verify Everything

```bash
# Verify driver
codesign --verify --verbose build/GrowhutAudioDriver.driver
spctl --assess --verbose build/GrowhutAudioDriver.driver

# Verify app
codesign --verify --verbose dist/mac/YourApp.app
spctl --assess --verbose dist/mac/YourApp.app

# Check notarization
spctl --assess --type execute --verbose --context context:primary-signature dist/mac/YourApp.app
```

## Automated Build Script

Create `scripts/build-and-sign.sh`:

```bash
#!/bin/bash
set -e

TEAM_ID="YOUR_TEAM_ID"
DEVELOPER_ID="Developer ID Application: Your Name ($TEAM_ID)"
APPLE_ID="your@email.com"
APP_SPECIFIC_PASSWORD="your-app-specific-password"

# Build driver
./scripts/build-driver.sh

# Sign driver
codesign --force --deep --sign "$DEVELOPER_ID" \
  --entitlements entitlements-driver.plist \
  --options runtime \
  --timestamp \
  build/GrowhutAudioDriver.driver

# Build Electron app
npm run build

# Sign app
codesign --force --deep --sign "$DEVELOPER_ID" \
  --entitlements entitlements-app.plist \
  --options runtime \
  --timestamp \
  dist/mac/YourApp.app

# Notarize
cd dist/mac
zip -r YourApp.zip YourApp.app
cd ../..

xcrun notarytool submit dist/mac/YourApp.zip \
  --apple-id "$APPLE_ID" \
  --team-id "$TEAM_ID" \
  --password "$APP_SPECIFIC_PASSWORD" \
  --wait

xcrun stapler staple dist/mac/YourApp.app

echo "✅ Build, signing, and notarization complete!"
```

## Common Issues

### "code object is not signed at all"

- Ensure you've run codesign on all binaries
- Use `--deep` flag to sign nested bundles

### "code signature invalid"

- Check that certificates are installed in Keychain
- Verify certificate hasn't expired

### "unidentified developer"

- Driver must be notarized OR user must allow in System Settings
- After installation, user will see security dialog

### "System software from developer was blocked"

- This is **expected** - user must approve in System Settings
- After approval, driver will load automatically

## References

- [Apple Code Signing Guide](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/)
- [Notarizing macOS Software](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution)
- [Hardened Runtime](https://developer.apple.com/documentation/security/hardened_runtime)

