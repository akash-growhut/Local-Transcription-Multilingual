/*
 * VirtualAudioCapture - Capture audio from Surge Audio virtual device
 * 
 * This module captures audio from the Surge Audio virtual device,
 * eliminating the need for screen recording permissions.
 */

#import <Foundation/Foundation.h>
#import <AudioToolbox/AudioToolbox.h>
#import <CoreAudio/CoreAudio.h>
#include <napi.h>
#include <vector>
#include <functional>
#include <string>
#include <os/log.h>

using namespace Napi;

// Logging
static os_log_t gVALog = NULL;
#define VA_LOG_INFO(format, ...) os_log_info(gVALog, format, ##__VA_ARGS__)
#define VA_LOG_ERROR(format, ...) os_log_error(gVALog, format, ##__VA_ARGS__)

// Constants - Support multiple virtual audio drivers
// Check for: BlackHole, Surge Audio, Loopback, Soundflower
static const char* SUPPORTED_VIRTUAL_DEVICES[] = {
    "BlackHole2ch_UID",          // BlackHole 2ch
    "BlackHole16ch_UID",         // BlackHole 16ch  
    "SurgeAudioDevice_UID",      // Surge Audio
    "com.rogueamoeba.Loopback",  // Loopback
    "SoundflowerEngine:0",       // Soundflower
    NULL
};
#define SAMPLE_RATE 16000.0
#define CHANNELS 1
#define BUFFER_SIZE 4096

#pragma mark - Audio Queue Callback

typedef struct {
    AudioQueueRef queue;
    AudioDeviceID deviceID;
    bool isCapturing;
    Napi::ThreadSafeFunction tsfn;
    std::vector<Float32> conversionBuffer;
} VirtualAudioState;

static void SurgeAudioQueueInputCallback(
    void* userData,
    AudioQueueRef queue,
    AudioQueueBufferRef buffer,
    const AudioTimeStamp* startTime,
    UInt32 numPackets,
    const AudioStreamPacketDescription* packetDescs
) {
    VirtualAudioState* state = (VirtualAudioState*)userData;
    
    if (!state->isCapturing || numPackets == 0) {
        AudioQueueEnqueueBuffer(queue, buffer, 0, NULL);
        return;
    }
    
    // Convert audio data to Float32 if needed
    Float32* audioData = (Float32*)buffer->mAudioData;
    size_t numSamples = buffer->mAudioDataByteSize / sizeof(Float32);
    
    // Copy data for thread safety
    std::vector<Float32> audioCopy(audioData, audioData + numSamples);
    
    // Send to JavaScript
    state->tsfn.BlockingCall([audioCopy](Napi::Env env, Napi::Function jsCallback) {
        try {
            Napi::Buffer<float> buffer = Napi::Buffer<float>::Copy(env, audioCopy.data(), audioCopy.size());
            jsCallback.Call({buffer});
        } catch (...) {
            // Ignore errors
        }
    });
    
    // Re-enqueue the buffer
    AudioQueueEnqueueBuffer(queue, buffer, 0, NULL);
}

#pragma mark - Helper Functions

static AudioDeviceID FindVirtualAudioDevice(const char** outDeviceName) {
    AudioObjectPropertyAddress propertyAddress = {
        kAudioHardwarePropertyDevices,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };
    
    UInt32 dataSize = 0;
    OSStatus status = AudioObjectGetPropertyDataSize(
        kAudioObjectSystemObject,
        &propertyAddress,
        0,
        NULL,
        &dataSize
    );
    
    if (status != noErr) {
        VA_LOG_ERROR("Failed to get device list size: %d", (int)status);
        return kAudioObjectUnknown;
    }
    
    UInt32 deviceCount = dataSize / sizeof(AudioDeviceID);
    std::vector<AudioDeviceID> devices(deviceCount);
    
    status = AudioObjectGetPropertyData(
        kAudioObjectSystemObject,
        &propertyAddress,
        0,
        NULL,
        &dataSize,
        devices.data()
    );
    
    if (status != noErr) {
        VA_LOG_ERROR("Failed to get device list: %d", (int)status);
        return kAudioObjectUnknown;
    }
    
    // Check each device against our list of supported virtual audio devices
    for (AudioDeviceID deviceID : devices) {
        propertyAddress.mSelector = kAudioDevicePropertyDeviceUID;
        propertyAddress.mScope = kAudioObjectPropertyScopeGlobal;
        
        CFStringRef deviceUID = NULL;
        dataSize = sizeof(deviceUID);
        
        status = AudioObjectGetPropertyData(
            deviceID,
            &propertyAddress,
            0,
            NULL,
            &dataSize,
            &deviceUID
        );
        
        if (status == noErr && deviceUID) {
            char uidBuffer[256];
            CFStringGetCString(deviceUID, uidBuffer, sizeof(uidBuffer), kCFStringEncodingUTF8);
            
            // Check against all supported virtual devices
            for (int i = 0; SUPPORTED_VIRTUAL_DEVICES[i] != NULL; i++) {
                if (strstr(uidBuffer, SUPPORTED_VIRTUAL_DEVICES[i]) != NULL ||
                    strcmp(uidBuffer, SUPPORTED_VIRTUAL_DEVICES[i]) == 0) {
                    CFRelease(deviceUID);
                    VA_LOG_INFO("Found virtual audio device: %s (ID: %u)", uidBuffer, (unsigned int)deviceID);
                    if (outDeviceName) *outDeviceName = SUPPORTED_VIRTUAL_DEVICES[i];
                    return deviceID;
                }
            }
            
            // Also check by device name for BlackHole
            CFStringRef deviceName = NULL;
            AudioObjectPropertyAddress nameAddr = {
                kAudioDevicePropertyDeviceNameCFString,
                kAudioObjectPropertyScopeGlobal,
                kAudioObjectPropertyElementMain
            };
            dataSize = sizeof(deviceName);
            if (AudioObjectGetPropertyData(deviceID, &nameAddr, 0, NULL, &dataSize, &deviceName) == noErr && deviceName) {
                char nameBuffer[256];
                CFStringGetCString(deviceName, nameBuffer, sizeof(nameBuffer), kCFStringEncodingUTF8);
                
                if (strstr(nameBuffer, "BlackHole") != NULL ||
                    strstr(nameBuffer, "Loopback") != NULL ||
                    strstr(nameBuffer, "Soundflower") != NULL ||
                    strstr(nameBuffer, "Surge") != NULL) {
                    CFRelease(deviceName);
                    CFRelease(deviceUID);
                    VA_LOG_INFO("Found virtual audio device by name: %s (ID: %u)", nameBuffer, (unsigned int)deviceID);
                    if (outDeviceName) *outDeviceName = nameBuffer;
                    return deviceID;
                }
                CFRelease(deviceName);
            }
            
            CFRelease(deviceUID);
        }
    }
    
    VA_LOG_ERROR("No virtual audio device found (BlackHole, Surge Audio, Loopback, or Soundflower)");
    return kAudioObjectUnknown;
}

// Note: SetupAggregateDevice removed - not needed for virtual audio capture

#pragma mark - VirtualAudioCapture Class

class VirtualAudioCapture : public Napi::ObjectWrap<VirtualAudioCapture> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    VirtualAudioCapture(const Napi::CallbackInfo& info);
    ~VirtualAudioCapture();

private:
    static Napi::FunctionReference constructor;
    
    VirtualAudioState state_;
    AudioQueueBufferRef buffers_[3];
    AudioDeviceID aggregateDeviceID_;
    
    Napi::Value Start(const Napi::CallbackInfo& info);
    Napi::Value Stop(const Napi::CallbackInfo& info);
    Napi::Value IsActive(const Napi::CallbackInfo& info);
    Napi::Value IsDriverInstalled(const Napi::CallbackInfo& info);
    Napi::Value GetDeviceInfo(const Napi::CallbackInfo& info);
};

Napi::FunctionReference VirtualAudioCapture::constructor;

Napi::Object VirtualAudioCapture::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "VirtualAudioCapture", {
        InstanceMethod("start", &VirtualAudioCapture::Start),
        InstanceMethod("stop", &VirtualAudioCapture::Stop),
        InstanceMethod("isActive", &VirtualAudioCapture::IsActive),
        InstanceMethod("isDriverInstalled", &VirtualAudioCapture::IsDriverInstalled),
        InstanceMethod("getDeviceInfo", &VirtualAudioCapture::GetDeviceInfo),
    });
    
    constructor = Napi::Persistent(func);
    constructor.SuppressDestruct();
    
    exports.Set("VirtualAudioCapture", func);
    return exports;
}

VirtualAudioCapture::VirtualAudioCapture(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<VirtualAudioCapture>(info), aggregateDeviceID_(kAudioObjectUnknown) {
    
    if (!gVALog) {
        gVALog = os_log_create("com.surge.virtualaudiocapture", "capture");
    }
    
    Napi::Env env = info.Env();
    
    state_.queue = NULL;
    state_.deviceID = kAudioObjectUnknown;
    state_.isCapturing = false;
    
    // Create thread-safe function for callbacks
    if (info.Length() > 0 && info[0].IsFunction()) {
        Napi::Function cb = info[0].As<Napi::Function>();
        state_.tsfn = Napi::ThreadSafeFunction::New(
            env,
            cb,
            "VirtualAudioCapture",
            0,
            1
        );
    }
    
    VA_LOG_INFO("VirtualAudioCapture initialized");
}

VirtualAudioCapture::~VirtualAudioCapture() {
    if (state_.isCapturing) {
        state_.isCapturing = false;
        if (state_.queue) {
            AudioQueueStop(state_.queue, true);
            AudioQueueDispose(state_.queue, true);
        }
    }
    
    if (aggregateDeviceID_ != kAudioObjectUnknown) {
        AudioHardwareDestroyAggregateDevice(aggregateDeviceID_);
    }
    
    state_.tsfn.Release();
}

Napi::Value VirtualAudioCapture::IsDriverInstalled(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    AudioDeviceID virtualDevice = FindVirtualAudioDevice(NULL);
    return Napi::Boolean::New(env, virtualDevice != kAudioObjectUnknown);
}

Napi::Value VirtualAudioCapture::GetDeviceInfo(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object result = Napi::Object::New(env);
    
    const char* deviceName = NULL;
    AudioDeviceID virtualDevice = FindVirtualAudioDevice(&deviceName);
    result.Set("installed", virtualDevice != kAudioObjectUnknown);
    result.Set("deviceId", virtualDevice != kAudioObjectUnknown ? (double)virtualDevice : 0);
    result.Set("deviceName", deviceName ? deviceName : "None");
    
    return result;
}

Napi::Value VirtualAudioCapture::Start(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (state_.isCapturing) {
        VA_LOG_INFO("Already capturing");
        return Napi::Boolean::New(env, false);
    }
    
    // Find virtual audio device (BlackHole, Surge Audio, Loopback, etc.)
    const char* deviceName = NULL;
    AudioDeviceID virtualDevice = FindVirtualAudioDevice(&deviceName);
    if (virtualDevice == kAudioObjectUnknown) {
        VA_LOG_ERROR("No virtual audio driver installed");
        Napi::Error::New(env, "No virtual audio driver found. Install BlackHole: brew install blackhole-2ch").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }
    
    VA_LOG_INFO("Using virtual audio device: %s", deviceName ? deviceName : "unknown");
    state_.deviceID = virtualDevice;
    
    // Create audio queue for input
    AudioStreamBasicDescription format;
    memset(&format, 0, sizeof(format));
    format.mSampleRate = SAMPLE_RATE;
    format.mFormatID = kAudioFormatLinearPCM;
    format.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagsNativeEndian | kAudioFormatFlagIsPacked;
    format.mBytesPerPacket = sizeof(Float32) * CHANNELS;
    format.mFramesPerPacket = 1;
    format.mBytesPerFrame = sizeof(Float32) * CHANNELS;
    format.mChannelsPerFrame = CHANNELS;
    format.mBitsPerChannel = 32;
    
    OSStatus status = AudioQueueNewInput(
        &format,
        SurgeAudioQueueInputCallback,
        &state_,
        CFRunLoopGetCurrent(),
        kCFRunLoopCommonModes,
        0,
        &state_.queue
    );
    
    if (status != noErr) {
        VA_LOG_ERROR("Failed to create audio queue: %d", (int)status);
        return Napi::Boolean::New(env, false);
    }
    
    // Set the input device to the virtual audio device
    UInt32 dataSize = sizeof(virtualDevice);
    status = AudioQueueSetProperty(
        state_.queue,
        kAudioQueueProperty_CurrentDevice,
        &virtualDevice,
        dataSize
    );
    
    if (status != noErr) {
        VA_LOG_ERROR("Failed to set audio queue device: %d", (int)status);
        AudioQueueDispose(state_.queue, true);
        state_.queue = NULL;
        return Napi::Boolean::New(env, false);
    }
    
    // Allocate and enqueue buffers
    UInt32 bufferSize = BUFFER_SIZE * sizeof(Float32);
    for (int i = 0; i < 3; i++) {
        status = AudioQueueAllocateBuffer(state_.queue, bufferSize, &buffers_[i]);
        if (status != noErr) {
            VA_LOG_ERROR("Failed to allocate buffer %d: %d", i, (int)status);
            AudioQueueDispose(state_.queue, true);
            state_.queue = NULL;
            return Napi::Boolean::New(env, false);
        }
        AudioQueueEnqueueBuffer(state_.queue, buffers_[i], 0, NULL);
    }
    
    // Start the queue
    status = AudioQueueStart(state_.queue, NULL);
    if (status != noErr) {
        VA_LOG_ERROR("Failed to start audio queue: %d", (int)status);
        AudioQueueDispose(state_.queue, true);
        state_.queue = NULL;
        return Napi::Boolean::New(env, false);
    }
    
    state_.isCapturing = true;
    VA_LOG_INFO("Virtual audio capture started");
    
    return Napi::Boolean::New(env, true);
}

Napi::Value VirtualAudioCapture::Stop(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!state_.isCapturing) {
        return env.Undefined();
    }
    
    state_.isCapturing = false;
    
    if (state_.queue) {
        AudioQueueStop(state_.queue, true);
        AudioQueueDispose(state_.queue, true);
        state_.queue = NULL;
    }
    
    VA_LOG_INFO("Virtual audio capture stopped");
    
    return env.Undefined();
}

Napi::Value VirtualAudioCapture::IsActive(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), state_.isCapturing);
}

// Export initialization
Napi::Object InitVirtualAudioCapture(Napi::Env env, Napi::Object exports) {
    VirtualAudioCapture::Init(env, exports);
    return exports;
}
