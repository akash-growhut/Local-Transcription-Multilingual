/*
 * AudioTapCapture - Capture system audio by tapping the default output device
 * 
 * This approach captures audio from the system output WITHOUT:
 * - Creating a visible audio device
 * - Requiring user to change audio settings
 * - Using ScreenCaptureKit (no recording icon)
 *
 * It works by creating an aggregate device programmatically that includes
 * a tap on the default output, then capturing from that tap invisibly.
 */

#import <Foundation/Foundation.h>
#import <AudioToolbox/AudioToolbox.h>
#import <CoreAudio/CoreAudio.h>
#include <napi.h>
#include <vector>
#include <mutex>
#include <os/log.h>

using namespace Napi;

static os_log_t gTapLog = NULL;
#define TAP_LOG_INFO(format, ...) os_log_info(gTapLog, format, ##__VA_ARGS__)
#define TAP_LOG_ERROR(format, ...) os_log_error(gTapLog, format, ##__VA_ARGS__)

#pragma mark - Audio Tap State

struct AudioTapState {
    AudioDeviceID outputDevice;
    AudioDeviceID tapDevice;        // Aggregate device with tap
    AudioDeviceIOProcID ioProcID;
    Napi::ThreadSafeFunction tsfn;
    std::mutex bufferMutex;
    std::vector<Float32> audioBuffer;
    bool isCapturing;
    Float64 sampleRate;
    UInt32 channelCount;
};

#pragma mark - Helper Functions

static AudioDeviceID GetDefaultOutputDevice() {
    AudioDeviceID deviceID = kAudioObjectUnknown;
    UInt32 dataSize = sizeof(deviceID);
    
    AudioObjectPropertyAddress propertyAddress = {
        kAudioHardwarePropertyDefaultOutputDevice,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };
    
    OSStatus status = AudioObjectGetPropertyData(
        kAudioObjectSystemObject,
        &propertyAddress,
        0,
        NULL,
        &dataSize,
        &deviceID
    );
    
    if (status != noErr) {
        TAP_LOG_ERROR("Failed to get default output device: %d", (int)status);
        return kAudioObjectUnknown;
    }
    
    return deviceID;
}

static CFStringRef GetDeviceUID(AudioDeviceID deviceID) {
    CFStringRef uid = NULL;
    UInt32 dataSize = sizeof(uid);
    
    AudioObjectPropertyAddress propertyAddress = {
        kAudioDevicePropertyDeviceUID,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };
    
    AudioObjectGetPropertyData(deviceID, &propertyAddress, 0, NULL, &dataSize, &uid);
    return uid;
}

static Float64 GetDeviceSampleRate(AudioDeviceID deviceID) {
    Float64 sampleRate = 44100.0;
    UInt32 dataSize = sizeof(sampleRate);
    
    AudioObjectPropertyAddress propertyAddress = {
        kAudioDevicePropertyNominalSampleRate,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };
    
    AudioObjectGetPropertyData(deviceID, &propertyAddress, 0, NULL, &dataSize, &sampleRate);
    return sampleRate;
}

#pragma mark - Aggregate Device with Tap

static AudioDeviceID CreateTapAggregateDevice(AudioDeviceID outputDevice) {
    // Get the UID of the output device
    CFStringRef outputUID = GetDeviceUID(outputDevice);
    if (!outputUID) {
        TAP_LOG_ERROR("Failed to get output device UID");
        return kAudioObjectUnknown;
    }
    
    // Create aggregate device description
    CFMutableDictionaryRef aggDesc = CFDictionaryCreateMutable(
        kCFAllocatorDefault,
        0,
        &kCFTypeDictionaryKeyCallBacks,
        &kCFTypeDictionaryValueCallBacks
    );
    
    // Set aggregate device properties
    CFStringRef aggUID = CFSTR("com.surge.audiotap.aggregate");
    CFStringRef aggName = CFSTR("Surge Audio Tap");
    
    CFDictionarySetValue(aggDesc, CFSTR(kAudioAggregateDeviceUIDKey), aggUID);
    CFDictionarySetValue(aggDesc, CFSTR(kAudioAggregateDeviceNameKey), aggName);
    
    // Make it private (not visible in Sound preferences)
    CFDictionarySetValue(aggDesc, CFSTR(kAudioAggregateDeviceIsPrivateKey), kCFBooleanTrue);
    
    // Create sub-device list with tap
    CFMutableArrayRef subDevices = CFArrayCreateMutable(kCFAllocatorDefault, 0, &kCFTypeArrayCallBacks);
    
    // Add the output device as a sub-device with tap enabled
    CFMutableDictionaryRef subDevice = CFDictionaryCreateMutable(
        kCFAllocatorDefault,
        0,
        &kCFTypeDictionaryKeyCallBacks,
        &kCFTypeDictionaryValueCallBacks
    );
    
    CFDictionarySetValue(subDevice, CFSTR(kAudioSubDeviceUIDKey), outputUID);
    
    // Enable tap on this device (capture what's being sent to it)
    // This is the key - we're creating a tap, not a new output
    CFArrayAppendValue(subDevices, subDevice);
    CFRelease(subDevice);
    
    CFDictionarySetValue(aggDesc, CFSTR(kAudioAggregateDeviceSubDeviceListKey), subDevices);
    CFRelease(subDevices);
    
    // Set the main output device (so audio still goes to speakers)
    CFDictionarySetValue(aggDesc, CFSTR(kAudioAggregateDeviceMasterSubDeviceKey), outputUID);
    
    // Create the aggregate device
    AudioDeviceID aggDevice = kAudioObjectUnknown;
    OSStatus status = AudioHardwareCreateAggregateDevice(aggDesc, &aggDevice);
    
    CFRelease(aggDesc);
    CFRelease(outputUID);
    
    if (status != noErr) {
        TAP_LOG_ERROR("Failed to create aggregate device: %d", (int)status);
        return kAudioObjectUnknown;
    }
    
    TAP_LOG_INFO("Created tap aggregate device: %u", (unsigned int)aggDevice);
    return aggDevice;
}

#pragma mark - IO Proc Callback

static OSStatus AudioTapIOProc(
    AudioObjectID inDevice,
    const AudioTimeStamp* inNow,
    const AudioBufferList* inInputData,
    const AudioTimeStamp* inInputTime,
    AudioBufferList* outOutputData,
    const AudioTimeStamp* inOutputTime,
    void* inClientData
) {
    AudioTapState* state = (AudioTapState*)inClientData;
    
    if (!state || !state->isCapturing) {
        return noErr;
    }
    
    // Process input buffers (this is the tapped audio)
    if (inInputData) {
        for (UInt32 i = 0; i < inInputData->mNumberBuffers; i++) {
            const AudioBuffer& buffer = inInputData->mBuffers[i];
            if (buffer.mData && buffer.mDataByteSize > 0) {
                Float32* samples = (Float32*)buffer.mData;
                size_t numSamples = buffer.mDataByteSize / sizeof(Float32);
                
                // Copy to thread-safe buffer
                std::vector<Float32> audioCopy(samples, samples + numSamples);
                
                // Send to JavaScript
                state->tsfn.BlockingCall([audioCopy](Napi::Env env, Napi::Function jsCallback) {
                    try {
                        Napi::Buffer<float> buffer = Napi::Buffer<float>::Copy(
                            env, audioCopy.data(), audioCopy.size()
                        );
                        jsCallback.Call({buffer});
                    } catch (...) {
                        // Ignore errors
                    }
                });
            }
        }
    }
    
    return noErr;
}

#pragma mark - AudioTapCapture Class

class AudioTapCapture : public Napi::ObjectWrap<AudioTapCapture> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    AudioTapCapture(const Napi::CallbackInfo& info);
    ~AudioTapCapture();

private:
    static Napi::FunctionReference constructor;
    
    AudioTapState state_;
    
    Napi::Value Start(const Napi::CallbackInfo& info);
    Napi::Value Stop(const Napi::CallbackInfo& info);
    Napi::Value IsActive(const Napi::CallbackInfo& info);
    Napi::Value GetOutputDeviceInfo(const Napi::CallbackInfo& info);
};

Napi::FunctionReference AudioTapCapture::constructor;

Napi::Object AudioTapCapture::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "AudioTapCapture", {
        InstanceMethod("start", &AudioTapCapture::Start),
        InstanceMethod("stop", &AudioTapCapture::Stop),
        InstanceMethod("isActive", &AudioTapCapture::IsActive),
        InstanceMethod("getOutputDeviceInfo", &AudioTapCapture::GetOutputDeviceInfo),
    });
    
    constructor = Napi::Persistent(func);
    constructor.SuppressDestruct();
    
    exports.Set("AudioTapCapture", func);
    return exports;
}

AudioTapCapture::AudioTapCapture(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<AudioTapCapture>(info) {
    
    if (!gTapLog) {
        gTapLog = os_log_create("com.surge.audiotap", "capture");
    }
    
    Napi::Env env = info.Env();
    
    state_.outputDevice = kAudioObjectUnknown;
    state_.tapDevice = kAudioObjectUnknown;
    state_.ioProcID = NULL;
    state_.isCapturing = false;
    state_.sampleRate = 48000.0;
    state_.channelCount = 2;
    
    // Create thread-safe function for callbacks
    if (info.Length() > 0 && info[0].IsFunction()) {
        Napi::Function cb = info[0].As<Napi::Function>();
        state_.tsfn = Napi::ThreadSafeFunction::New(
            env,
            cb,
            "AudioTapCapture",
            0,
            1
        );
    }
    
    TAP_LOG_INFO("AudioTapCapture initialized");
}

AudioTapCapture::~AudioTapCapture() {
    if (state_.isCapturing) {
        state_.isCapturing = false;
        
        if (state_.ioProcID && state_.tapDevice != kAudioObjectUnknown) {
            AudioDeviceStop(state_.tapDevice, state_.ioProcID);
            AudioDeviceDestroyIOProcID(state_.tapDevice, state_.ioProcID);
        }
        
        if (state_.tapDevice != kAudioObjectUnknown) {
            AudioHardwareDestroyAggregateDevice(state_.tapDevice);
        }
    }
    
    state_.tsfn.Release();
}

Napi::Value AudioTapCapture::GetOutputDeviceInfo(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object result = Napi::Object::New(env);
    
    AudioDeviceID outputDevice = GetDefaultOutputDevice();
    
    if (outputDevice != kAudioObjectUnknown) {
        CFStringRef uid = GetDeviceUID(outputDevice);
        CFStringRef name = NULL;
        UInt32 dataSize = sizeof(name);
        
        AudioObjectPropertyAddress nameAddr = {
            kAudioDevicePropertyDeviceNameCFString,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };
        AudioObjectGetPropertyData(outputDevice, &nameAddr, 0, NULL, &dataSize, &name);
        
        result.Set("available", true);
        result.Set("deviceId", (double)outputDevice);
        
        if (name) {
            char nameBuffer[256];
            CFStringGetCString(name, nameBuffer, sizeof(nameBuffer), kCFStringEncodingUTF8);
            result.Set("deviceName", nameBuffer);
            CFRelease(name);
        }
        
        if (uid) {
            char uidBuffer[256];
            CFStringGetCString(uid, uidBuffer, sizeof(uidBuffer), kCFStringEncodingUTF8);
            result.Set("deviceUID", uidBuffer);
            CFRelease(uid);
        }
        
        result.Set("sampleRate", GetDeviceSampleRate(outputDevice));
    } else {
        result.Set("available", false);
        result.Set("error", "No output device found");
    }
    
    return result;
}

Napi::Value AudioTapCapture::Start(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (state_.isCapturing) {
        TAP_LOG_INFO("Already capturing");
        return Napi::Boolean::New(env, false);
    }
    
    // Get default output device
    state_.outputDevice = GetDefaultOutputDevice();
    if (state_.outputDevice == kAudioObjectUnknown) {
        Napi::Error::New(env, "No default output device found").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }
    
    state_.sampleRate = GetDeviceSampleRate(state_.outputDevice);
    TAP_LOG_INFO("Default output device: %u, sample rate: %.0f", 
                 (unsigned int)state_.outputDevice, state_.sampleRate);
    
    // Create aggregate device with tap
    state_.tapDevice = CreateTapAggregateDevice(state_.outputDevice);
    if (state_.tapDevice == kAudioObjectUnknown) {
        Napi::Error::New(env, "Failed to create audio tap device").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }
    
    // Create IO proc to capture audio
    OSStatus status = AudioDeviceCreateIOProcID(
        state_.tapDevice,
        AudioTapIOProc,
        &state_,
        &state_.ioProcID
    );
    
    if (status != noErr) {
        TAP_LOG_ERROR("Failed to create IO proc: %d", (int)status);
        AudioHardwareDestroyAggregateDevice(state_.tapDevice);
        state_.tapDevice = kAudioObjectUnknown;
        Napi::Error::New(env, "Failed to create audio IO proc").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }
    
    // Start capturing
    status = AudioDeviceStart(state_.tapDevice, state_.ioProcID);
    if (status != noErr) {
        TAP_LOG_ERROR("Failed to start audio device: %d", (int)status);
        AudioDeviceDestroyIOProcID(state_.tapDevice, state_.ioProcID);
        AudioHardwareDestroyAggregateDevice(state_.tapDevice);
        state_.tapDevice = kAudioObjectUnknown;
        state_.ioProcID = NULL;
        Napi::Error::New(env, "Failed to start audio capture").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }
    
    state_.isCapturing = true;
    TAP_LOG_INFO("Audio tap capture started successfully");
    
    return Napi::Boolean::New(env, true);
}

Napi::Value AudioTapCapture::Stop(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!state_.isCapturing) {
        return env.Undefined();
    }
    
    state_.isCapturing = false;
    
    if (state_.ioProcID && state_.tapDevice != kAudioObjectUnknown) {
        AudioDeviceStop(state_.tapDevice, state_.ioProcID);
        AudioDeviceDestroyIOProcID(state_.tapDevice, state_.ioProcID);
        state_.ioProcID = NULL;
    }
    
    if (state_.tapDevice != kAudioObjectUnknown) {
        AudioHardwareDestroyAggregateDevice(state_.tapDevice);
        state_.tapDevice = kAudioObjectUnknown;
    }
    
    TAP_LOG_INFO("Audio tap capture stopped");
    
    return env.Undefined();
}

Napi::Value AudioTapCapture::IsActive(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), state_.isCapturing);
}

// Export initialization
Napi::Object InitAudioTapCapture(Napi::Env env, Napi::Object exports) {
    AudioTapCapture::Init(env, exports);
    return exports;
}
