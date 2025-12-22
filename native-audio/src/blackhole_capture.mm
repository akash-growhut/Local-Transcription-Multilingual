#import <Foundation/Foundation.h>
#import <CoreAudio/CoreAudio.h>
#import <AudioUnit/AudioUnit.h>
#import <AudioToolbox/AudioToolbox.h>
#include <napi.h>
#include <vector>
#include <functional>
#include <string>

using namespace Napi;

// Forward declaration
class BlackHoleCaptureAddon;

// Global callback
std::function<void(const float*, size_t)> g_audioCallback;
BlackHoleCaptureAddon* g_captureInstance = nullptr;

// Main addon class
class BlackHoleCaptureAddon : public Napi::ObjectWrap<BlackHoleCaptureAddon> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    BlackHoleCaptureAddon(const Napi::CallbackInfo& info);
    ~BlackHoleCaptureAddon();
    
    AudioUnit audioUnit_;
    bool isCapturing_;
    Napi::ThreadSafeFunction tsfn_;
    Napi::FunctionReference callback_;

private:
    static Napi::FunctionReference constructor;
    
    Napi::Value Start(const Napi::CallbackInfo& info);
    Napi::Value Stop(const Napi::CallbackInfo& info);
    Napi::Value IsActive(const Napi::CallbackInfo& info);
    
    void OnAudioData(const float* data, size_t length);
    bool SetupAudioUnit();
    void CleanupAudioUnit();
    AudioDeviceID FindBlackHoleDevice();
};

Napi::FunctionReference BlackHoleCaptureAddon::constructor;

// AudioUnit input callback - this is called when audio is available from the device
// Must be defined after the class definition to access class members
static OSStatus AudioInputCallback(
    void* inRefCon,
    AudioUnitRenderActionFlags* ioActionFlags,
    const AudioTimeStamp* inTimeStamp,
    UInt32 inBusNumber,
    UInt32 inNumberFrames,
    AudioBufferList* ioData) {
    
    BlackHoleCaptureAddon* instance = (BlackHoleCaptureAddon*)inRefCon;
    if (!instance || !g_audioCallback) {
        return noErr;
    }
    
    // Allocate buffer to receive audio data
    // BlackHole 2ch provides stereo, so we need 2 channels
    AudioBufferList bufferList;
    bufferList.mNumberBuffers = 1;
    bufferList.mBuffers[0].mNumberChannels = 2; // Stereo from BlackHole
    bufferList.mBuffers[0].mDataByteSize = inNumberFrames * 2 * sizeof(float);
    bufferList.mBuffers[0].mData = malloc(inNumberFrames * 2 * sizeof(float));
    
    if (!bufferList.mBuffers[0].mData) {
        return -1;
    }
    
    // Render audio from the input bus (this reads from the device)
    OSStatus status = AudioUnitRender(
        instance->audioUnit_,
        ioActionFlags,
        inTimeStamp,
        1, // Input bus (element 1 is input)
        inNumberFrames,
        &bufferList
    );
    
    if (status == noErr) {
        float* floatData = (float*)bufferList.mBuffers[0].mData;
        
        // Diagnostic: Check if we're getting actual audio (not just silence)
        static int callbackCount = 0;
        static bool hasLoggedAudio = false;
        float peak = 0.0f;
        for (UInt32 i = 0; i < inNumberFrames * 2; i++) {
            peak = fmaxf(peak, fabsf(floatData[i]));
        }
        
        callbackCount++;
        if (callbackCount <= 5 || (peak > 0.0001f && !hasLoggedAudio)) {
            NSLog(@"🎵 Audio callback #%d: %u frames, peak=%.6f", callbackCount, inNumberFrames, peak);
            if (peak > 0.0001f) {
                hasLoggedAudio = true;
                NSLog(@"🔊 BlackHole ACTIVE - audio is flowing! peak=%.6f", peak);
            }
        }
        
        // Convert from interleaved stereo (LRLRLR) to mono by averaging channels
        float* monoData = (float*)malloc(inNumberFrames * sizeof(float));
        for (UInt32 i = 0; i < inNumberFrames; i++) {
            float left = floatData[i * 2];      // Even indices: left channel
            float right = floatData[i * 2 + 1]; // Odd indices: right channel
            monoData[i] = (left + right) / 2.0f;
        }
        
        if (g_audioCallback) {
            g_audioCallback(monoData, inNumberFrames);
        }
        free(monoData);
    } else {
        static int errorCount = 0;
        if (errorCount < 5) {
            NSLog(@"⚠️ AudioUnitRender error: %d (paramErr=-50 means format mismatch) callback #%d", (int)status, ++errorCount);
        }
    }
    
    free(bufferList.mBuffers[0].mData);
    return noErr;
}

Napi::Object BlackHoleCaptureAddon::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "BlackHoleCapture", {
        InstanceMethod("start", &BlackHoleCaptureAddon::Start),
        InstanceMethod("stop", &BlackHoleCaptureAddon::Stop),
        InstanceMethod("isActive", &BlackHoleCaptureAddon::IsActive),
    });
    
    constructor = Napi::Persistent(func);
    constructor.SuppressDestruct();
    
    exports.Set("BlackHoleCapture", func);
    return exports;
}

BlackHoleCaptureAddon::BlackHoleCaptureAddon(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<BlackHoleCaptureAddon>(info), audioUnit_(nullptr), isCapturing_(false) {
    
    Napi::Env env = info.Env();
    
    // Create thread-safe function for callbacks
    if (info.Length() > 0 && info[0].IsFunction()) {
        try {
            Napi::Function cb = info[0].As<Napi::Function>();
            callback_ = Napi::Persistent(cb);
            
            tsfn_ = Napi::ThreadSafeFunction::New(
                env,
                cb,
                "BlackHoleCapture",
                0,
                1
            );
        } catch (const Napi::Error& e) {
            NSLog(@"⚠️ Error creating thread-safe function: %s", e.Message().c_str());
        } catch (...) {
            NSLog(@"⚠️ Unknown error creating thread-safe function");
        }
    }
    
    g_captureInstance = this;
}

BlackHoleCaptureAddon::~BlackHoleCaptureAddon() {
    NSLog(@"🧹 BlackHoleCapture destructor called, cleaning up...");
    
    if (g_captureInstance == this) {
        g_captureInstance = nullptr;
    }
    
    CleanupAudioUnit();
    
    try {
        if (tsfn_) {
            tsfn_.Release();
        }
    } catch (...) {
        NSLog(@"⚠️ Error releasing thread-safe function in destructor");
    }
    
    NSLog(@"✅ BlackHoleCapture destructor completed");
}

AudioDeviceID BlackHoleCaptureAddon::FindBlackHoleDevice() {
    AudioDeviceID deviceID = kAudioDeviceUnknown;
    
    // Try to find BlackHole device by name
    UInt32 dataSize = 0;
    AudioObjectPropertyAddress propertyAddress = {
        kAudioHardwarePropertyDevices,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };
    
    OSStatus status = AudioObjectGetPropertyDataSize(
        kAudioObjectSystemObject,
        &propertyAddress,
        0,
        NULL,
        &dataSize
    );
    
    if (status != noErr) {
        NSLog(@"❌ Error getting device list size: %d", (int)status);
        return kAudioDeviceUnknown;
    }
    
    UInt32 deviceCount = dataSize / sizeof(AudioDeviceID);
    AudioDeviceID* deviceIDs = (AudioDeviceID*)malloc(dataSize);
    
    if (!deviceIDs) {
        return kAudioDeviceUnknown;
    }
    
    status = AudioObjectGetPropertyData(
        kAudioObjectSystemObject,
        &propertyAddress,
        0,
        NULL,
        &dataSize,
        deviceIDs
    );
    
    if (status != noErr) {
        NSLog(@"❌ Error getting device list: %d", (int)status);
        free(deviceIDs);
        return kAudioDeviceUnknown;
    }
    
    // Search for BlackHole device
    bool foundBlackHole = false;
    for (UInt32 i = 0; i < deviceCount; i++) {
        CFStringRef deviceName = NULL;
        propertyAddress.mSelector = kAudioDevicePropertyDeviceNameCFString;
        propertyAddress.mScope = kAudioObjectPropertyScopeGlobal;
        propertyAddress.mElement = kAudioObjectPropertyElementMain;
        
        dataSize = sizeof(CFStringRef);
        status = AudioObjectGetPropertyData(
            deviceIDs[i],
            &propertyAddress,
            0,
            NULL,
            &dataSize,
            &deviceName
        );
        
        if (status == noErr && deviceName) {
            char nameBuffer[256];
            if (CFStringGetCString(deviceName, nameBuffer, 256, kCFStringEncodingUTF8)) {
                NSString* deviceNameStr = [NSString stringWithUTF8String:nameBuffer];
                // Prefer "BlackHole 2ch" specifically
                if ([deviceNameStr isEqualToString:@"BlackHole 2ch"]) {
                    NSLog(@"✅ Found BlackHole 2ch device (preferred)");
                    deviceID = deviceIDs[i];
                    foundBlackHole = true;
                    CFRelease(deviceName);
                    break;
                } else if ([deviceNameStr containsString:@"BlackHole"] || 
                           [deviceNameStr containsString:@"blackhole"]) {
                    if (!foundBlackHole) {
                        NSLog(@"✅ Found BlackHole device: %@", deviceNameStr);
                        deviceID = deviceIDs[i];
                        foundBlackHole = true;
                    }
                }
            }
            CFRelease(deviceName);
        }
    }
    
    free(deviceIDs);
    
    if (!foundBlackHole) {
        NSLog(@"❌ BlackHole device not found. Please ensure BlackHole is installed and your Mac has been restarted.");
        return kAudioDeviceUnknown;
    }
    
    return deviceID;
}

bool BlackHoleCaptureAddon::SetupAudioUnit() {
    // Find BlackHole device
    AudioDeviceID deviceID = FindBlackHoleDevice();
    if (deviceID == kAudioDeviceUnknown) {
        NSLog(@"❌ Could not find BlackHole device. Please:");
        NSLog(@"   1. Install BlackHole from the app bundle");
        NSLog(@"   2. Restart your Mac");
        NSLog(@"   3. Ensure BlackHole 2ch appears in Audio MIDI Setup");
        return false;
    }
    
    // Create AudioComponentDescription for HAL output
    AudioComponentDescription desc;
    desc.componentType = kAudioUnitType_Output;
    desc.componentSubType = kAudioUnitSubType_HALOutput;
    desc.componentManufacturer = kAudioUnitManufacturer_Apple;
    desc.componentFlags = 0;
    desc.componentFlagsMask = 0;
    
    // Find the component
    AudioComponent component = AudioComponentFindNext(NULL, &desc);
    if (!component) {
        NSLog(@"❌ Could not find HAL output component");
        return false;
    }
    
    // Create the audio unit
    OSStatus status = AudioComponentInstanceNew(component, &audioUnit_);
    if (status != noErr) {
        NSLog(@"❌ Error creating audio unit: %d", (int)status);
        return false;
    }
    
    // Enable input on the audio unit
    UInt32 enableIO = 1;
    status = AudioUnitSetProperty(
        audioUnit_,
        kAudioOutputUnitProperty_EnableIO,
        kAudioUnitScope_Input,
        1, // Input element
        &enableIO,
        sizeof(enableIO)
    );
    
    if (status != noErr) {
        NSLog(@"❌ Error enabling input: %d", (int)status);
        CleanupAudioUnit();
        return false;
    }
    
    // Disable output
    enableIO = 0;
    status = AudioUnitSetProperty(
        audioUnit_,
        kAudioOutputUnitProperty_EnableIO,
        kAudioUnitScope_Output,
        0, // Output element
        &enableIO,
        sizeof(enableIO)
    );
    
    // Set the device
    status = AudioUnitSetProperty(
        audioUnit_,
        kAudioOutputUnitProperty_CurrentDevice,
        kAudioUnitScope_Global,
        0,
        &deviceID,
        sizeof(deviceID)
    );
    
    if (status != noErr) {
        NSLog(@"❌ Error setting device: %d", (int)status);
        CleanupAudioUnit();
        return false;
    }
    
    // Get the device's input format
    AudioStreamBasicDescription deviceFormat;
    UInt32 propertySize = sizeof(deviceFormat);
    status = AudioUnitGetProperty(
        audioUnit_,
        kAudioUnitProperty_StreamFormat,
        kAudioUnitScope_Input,
        1, // Input element
        &deviceFormat,
        &propertySize
    );
    
    if (status != noErr) {
        NSLog(@"❌ Error getting device input format: %d", (int)status);
        CleanupAudioUnit();
        return false;
    }
    
    NSLog(@"🎚️ Device input format: sampleRate=%.0f, channels=%u, format=%u",
          deviceFormat.mSampleRate, deviceFormat.mChannelsPerFrame, deviceFormat.mFormatID);
    
    // Set our desired format for the output scope (what we'll receive)
    // Use INTERLEAVED format (LRLRLR layout) - this matches BlackHole's output
    AudioStreamBasicDescription desiredFormat;
    desiredFormat.mSampleRate = 48000.0;
    desiredFormat.mFormatID = kAudioFormatLinearPCM;
    desiredFormat.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked;
    // ❌ DO NOT add kAudioFormatFlagIsNonInterleaved - we use interleaved
    
    desiredFormat.mChannelsPerFrame = 2; // Stereo from BlackHole 2ch
    desiredFormat.mBitsPerChannel = 32;
    desiredFormat.mFramesPerPacket = 1;
    desiredFormat.mBytesPerFrame = sizeof(float) * 2; // 2 channels interleaved
    desiredFormat.mBytesPerPacket = desiredFormat.mBytesPerFrame;
    
    status = AudioUnitSetProperty(
        audioUnit_,
        kAudioUnitProperty_StreamFormat,
        kAudioUnitScope_Output,
        1, // Output from input element
        &desiredFormat,
        sizeof(desiredFormat)
    );
    
    if (status != noErr) {
        NSLog(@"❌ Error setting stream format: %d", (int)status);
        CleanupAudioUnit();
        return false;
    }
    
    // Set input callback - this receives audio from the device
    AURenderCallbackStruct callbackStruct;
    callbackStruct.inputProc = AudioInputCallback;
    callbackStruct.inputProcRefCon = this;
    
    status = AudioUnitSetProperty(
        audioUnit_,
        kAudioOutputUnitProperty_SetInputCallback,
        kAudioUnitScope_Global,
        0,
        &callbackStruct,
        sizeof(callbackStruct)
    );
    
    if (status != noErr) {
        NSLog(@"❌ Error setting input callback: %d", (int)status);
        CleanupAudioUnit();
        return false;
    }
    
    // Initialize the audio unit
    status = AudioUnitInitialize(audioUnit_);
    if (status != noErr) {
        NSLog(@"❌ Error initializing audio unit: %d", (int)status);
        CleanupAudioUnit();
        return false;
    }
    
    NSLog(@"✅ AudioUnit setup complete");
    return true;
}

void BlackHoleCaptureAddon::CleanupAudioUnit() {
    if (audioUnit_) {
        if (isCapturing_) {
            AudioOutputUnitStop(audioUnit_);
            isCapturing_ = false;
        }
        AudioUnitUninitialize(audioUnit_);
        AudioComponentInstanceDispose(audioUnit_);
        audioUnit_ = nullptr;
    }
}

void BlackHoleCaptureAddon::OnAudioData(const float* data, size_t length) {
    if (!isCapturing_ || length == 0 || !data) {
        return;
    }
    
    // Copy data for thread safety
    std::vector<float> audioData(data, data + length);
    
    try {
        if (!tsfn_) {
            return;
        }
        
        tsfn_.NonBlockingCall([audioData](Napi::Env env, Napi::Function jsCallback) {
            try {
                if (jsCallback.IsEmpty() || jsCallback.IsUndefined()) {
                    return;
                }
                Napi::Buffer<float> buffer = Napi::Buffer<float>::Copy(env, audioData.data(), audioData.size());
                jsCallback.Call({buffer});
            } catch (...) {
                // Ignore errors in JS callback
            }
        });
    } catch (...) {
        // Ignore errors during shutdown
    }
}

Napi::Value BlackHoleCaptureAddon::Start(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (isCapturing_) {
        return Napi::Boolean::New(env, false);
    }
    
    // Setup audio callback - callback is already set in constructor
    // Do NOT expect callback parameter here
    if (!callback_) {
        NSLog(@"❌ No callback set in constructor");
        return Napi::Boolean::New(env, false);
    }
    
    // Set up the global callback to forward to OnAudioData
    g_audioCallback = [this](const float* data, size_t length) {
        this->OnAudioData(data, length);
    };
    
    // Setup AudioUnit
    if (!SetupAudioUnit()) {
        NSLog(@"❌ SetupAudioUnit failed");
        return Napi::Boolean::New(env, false);
    }
    
    // Start the audio unit
    OSStatus status = AudioOutputUnitStart(audioUnit_);
    if (status != noErr) {
        NSLog(@"❌ Error starting audio unit: %d", (int)status);
        CleanupAudioUnit();
        return Napi::Boolean::New(env, false);
    }
    
    isCapturing_ = true;
    NSLog(@"✅ BlackHole audio capture started");
    
    return Napi::Boolean::New(env, true);
}

Napi::Value BlackHoleCaptureAddon::Stop(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!isCapturing_) {
        return env.Undefined();
    }
    
    NSLog(@"🛑 Stopping BlackHole capture...");
    
    isCapturing_ = false;
    g_audioCallback = nullptr;
    
    CleanupAudioUnit();
    
    NSLog(@"✅ BlackHole capture stopped");
    return env.Undefined();
}

Napi::Value BlackHoleCaptureAddon::IsActive(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    return Napi::Boolean::New(env, isCapturing_);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    BlackHoleCaptureAddon::Init(env, exports);
    return exports;
}

NODE_API_MODULE(blackhole_capture, Init)
