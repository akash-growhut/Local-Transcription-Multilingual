{
  "targets": [
    {
      "target_name": "speaker_audio_capture",
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
      "conditions": [
        ["OS=='mac'", {
          "sources": [
            "src/speaker_audio_capture.mm"
          ],
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
              "-framework", "CoreMedia",
              "-framework", "CoreAudio",
              "-framework", "AppKit",
              "-framework", "ApplicationServices"
            ],
            "ENABLE_HARDENED_RUNTIME": "YES"
          },
          "libraries": [
            "-framework Foundation",
            "-framework ScreenCaptureKit",
            "-framework AVFoundation",
            "-framework CoreMedia",
            "-framework CoreAudio",
            "-framework AppKit",
            "-framework ApplicationServices"
          ]
        }],
        ["OS=='win'", {
          "sources": [
            "src/speaker_audio_capture_win.cpp"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": [
                "/std:c++17"
              ]
            }
          },
          "libraries": [
            "ole32.lib",
            "oleaut32.lib"
          ]
        }]
      ]
    },
    {
      "target_name": "rnnoise",
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "src/rnnoise"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
      "conditions": [
        ["OS=='mac'", {
          "sources": [
            "src/microphone_rnnoise.cpp"
          ],
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_CXX_LIBRARY": "libc++",
            "MACOSX_DEPLOYMENT_TARGET": "13.0",
            "OTHER_CPLUSPLUSFLAGS": [
              "-std=c++17"
            ],
            "ENABLE_HARDENED_RUNTIME": "YES"
          }
        }]
      ]
    }
  ]
}

