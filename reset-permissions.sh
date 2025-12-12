#!/bin/bash

# Script to reset TCC permissions for Electron app
# This is needed when changing permission types

echo "🔄 Resetting TCC permissions for Electron..."

# Reset Screen Recording permission (old one)
tccutil reset ScreenCapture

# Reset System Audio Recording permission (new one)  
tccutil reset SystemPolicyAllFiles

echo "✅ Permissions reset!"
echo ""
echo "⚠️  IMPORTANT: You must now:"
echo "1. Quit the app completely if it's running"
echo "2. Start the app again with: npm start"
echo "3. Grant the 'System Audio Recording' permission when prompted"
echo ""
echo "📝 Note: The app will now request 'System Audio Recording' permission"
echo "   instead of 'Screen Recording' permission"
