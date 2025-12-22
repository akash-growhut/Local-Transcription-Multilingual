module.exports = {
  appId: "com.growhut.local-transcription",
  productName: "Local Transcription Multilingual",
  directories: {
    output: "dist",
    buildResources: "build",
  },
  files: [
    "src/**/*",
    "native-audio/**/*",
    "package.json",
    "!native-audio/node_modules/**/*",
    "!native-audio/build/**/*",
    "resources/BlackHole.driver",
  ],
  extraResources: [
    {
      from: "resources/BlackHole.driver",
      to: "BlackHole.driver",
      filter: ["**/*"],
    },
  ],
  mac: {
    category: "public.app-category.utilities",
    target: [
      {
        target: "dmg",
        arch: ["x64", "arm64"],
      },
    ],
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    extendInfo: {
      NSMicrophoneUsageDescription:
        "This app needs microphone access to transcribe your voice.",
      NSScreenCaptureUsageDescription:
        "This app needs screen recording access to capture system audio.",
    },
  },
  dmg: {
    contents: [
      {
        x: 410,
        y: 150,
        type: "link",
        path: "/Applications",
      },
      {
        x: 130,
        y: 150,
        type: "file",
      },
    ],
  },
  win: {
    target: "nsis",
  },
  linux: {
    target: "AppImage",
  },
};
