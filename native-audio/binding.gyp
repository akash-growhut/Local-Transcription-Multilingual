{
  "targets": [
    {
      "target_name": "audio_capture",
      "sources": [
        "src/audio_capture.mm"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "CLANG_CXX_LIBRARY": "libc++",
        "MACOSX_DEPLOYMENT_TARGET": "13.0",
        "OTHER_CPLUSPLUSFLAGS": [
          "-std=c++17",
          "-fmodules",
          "-ObjC++"
        ],
        "OTHER_LDFLAGS": [
          "-framework", "Foundation",
          "-framework", "ScreenCaptureKit",
          "-framework", "AVFoundation",
          "-framework", "CoreMedia"
        ],
        "ENABLE_HARDENED_RUNTIME": "YES"
      },
      "conditions": [
        ["OS=='mac'", {
          "libraries": [
            "-framework Foundation",
            "-framework ScreenCaptureKit",
            "-framework AVFoundation",
            "-framework CoreMedia"
          ]
        }]
      ]
    }
  ]
}

