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
              "-framework", "CoreMedia"
            ],
            "ENABLE_HARDENED_RUNTIME": "YES"
          },
          "libraries": [
            "-framework Foundation",
            "-framework ScreenCaptureKit",
            "-framework AVFoundation",
            "-framework CoreMedia"
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
      "target_name": "audio_capture_with_aec",
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "<!@(node -e \"try { const c=require('./check-webrtc.js'); if(c.checkWebRTC()) console.log(c.webrtcIncludeDir); } catch(e) {}\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "<!@(node -e \"try { const c=require('./check-webrtc.js'); if(c.checkWebRTC()) console.log('USE_WEBRTC_AEC3'); } catch(e) {}\")"
      ],
      "conditions": [
        ["OS=='mac'", {
          "sources": [
            "src/audio_capture_with_aec.mm",
            "src/webrtc_aec_wrapper.cpp",
            "<!@(node -e \"try { const c=require('./check-webrtc.js'); if(c.checkWebRTC()) console.log('src/webrtc_aec_wrapper_real.cpp'); } catch(e) {}\")"
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
              "-framework", "AudioToolbox"
            ],
            "ENABLE_HARDENED_RUNTIME": "YES"
          },
          "libraries": [
            "-framework Foundation",
            "-framework ScreenCaptureKit",
            "-framework AVFoundation",
            "-framework CoreMedia",
            "-framework CoreAudio",
            "-framework AudioToolbox",
            "<!@(node -e \"try { const c=require('./check-webrtc.js'); const path=require('path'); if(c.checkWebRTC()) { const lib=path.join(c.webrtcLibDir,'libaudioprocessing.a'); if(require('fs').existsSync(lib)) console.log(lib); } } catch(e) {}\")"
          ],
          "library_dirs": [
            "<!@(node -e \"try { const c=require('./check-webrtc.js'); if(c.checkWebRTC()) console.log(c.webrtcLibDir); } catch(e) {}\")"
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

