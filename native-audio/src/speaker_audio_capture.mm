#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreAudio/CoreAudio.h>
#import <AudioToolbox/AudioToolbox.h>
#import <objc/message.h>
#include <napi.h>
#include <vector>
#include <functional>
#include <algorithm>
#include <cmath>

using namespace Napi;

// Forward declaration
class AudioCaptureAddon;

// Global callback
std::function<void(const float*, size_t)> g_audioCallback;
AudioCaptureAddon* g_captureInstance = nullptr;

// Capture mode enum
enum CaptureMode {
    CAPTURE_MODE_SCREENCAPTUREKIT = 0,  // Default, App Store safe
    CAPTURE_MODE_HAL = 1                // Experimental, Granola-style
};

// Stream output handler
typedef void (^AudioCallback)(const float* data, size_t length);

@interface StreamOutputHandler : NSObject <SCStreamOutput>
@property (nonatomic, copy) AudioCallback callback;
@end

@implementation StreamOutputHandler

- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer ofType:(SCStreamOutputType)type {
    if (type != SCStreamOutputTypeAudio) {
        return;
    }
    
    if (!self.callback) {
        return;
    }
    
    // Check audio format
    CMAudioFormatDescriptionRef formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer);
    if (formatDesc) {
        const AudioStreamBasicDescription* asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc);
        static int formatLogCount = 0;
        if (formatLogCount < 2) {
            if (asbd) {
                NSLog(@"🎚️ Audio format: sampleRate=%.0f, channels=%u, format=%u (1=Float32, 2=Int16), bytesPerFrame=%u",
                      asbd->mSampleRate, asbd->mChannelsPerFrame, asbd->mFormatID, asbd->mBytesPerFrame);
                formatLogCount++;
            }
        }
    }
    
    CMBlockBufferRef blockBuffer = NULL;
    size_t bufferListSize = 0;
    
    // First, get the required size
    OSStatus status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        sampleBuffer,
        &bufferListSize,
        NULL,
        0,
        NULL,
        NULL,
        kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
        NULL
    );
    
    if (status != noErr && status != kCMSampleBufferError_BufferHasNoSampleSizes) {
        NSLog(@"❌ Error getting audio buffer size: %d", (int)status);
        return;
    }
    
    // Allocate buffer list
    AudioBufferList* allocatedBufferList = (AudioBufferList*)malloc(bufferListSize);
    if (!allocatedBufferList) {
        NSLog(@"❌ Failed to allocate audio buffer list");
        return;
    }
    
    // Get the actual audio data
    status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        sampleBuffer,
        NULL,
        allocatedBufferList,
        bufferListSize,
        NULL,
        NULL,
        kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
        &blockBuffer
    );
    
    if (status != noErr) {
        NSLog(@"❌ Error getting audio buffer: %d", (int)status);
        free(allocatedBufferList);
        if (blockBuffer) {
            CFRelease(blockBuffer);
        }
        return;
    }
    
    // Process audio buffers
    UInt32 numBuffers = allocatedBufferList->mNumberBuffers;
    static int sampleCount = 0;
    for (UInt32 i = 0; i < numBuffers; i++) {
        AudioBuffer buffer = allocatedBufferList->mBuffers[i];
        if (buffer.mData && buffer.mDataByteSize > 0) {
            // Check format - might be Int16 or Float32
            CMAudioFormatDescriptionRef formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer);
            const AudioStreamBasicDescription* asbd = NULL;
            if (formatDesc) {
                asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc);
            }
            
            size_t length = 0;
            float* floatData = NULL;
            
            if (asbd && asbd->mFormatID == kAudioFormatLinearPCM) {
                if (asbd->mFormatFlags & kAudioFormatFlagIsFloat) {
                    // Float32 format
                    length = buffer.mDataByteSize / sizeof(float);
                    floatData = (float*)buffer.mData;
                } else if (asbd->mFormatFlags & kAudioFormatFlagIsSignedInteger) {
                    // Int16 format - convert to float
                    length = buffer.mDataByteSize / sizeof(int16_t);
                    int16_t* int16Data = (int16_t*)buffer.mData;
                    floatData = (float*)malloc(length * sizeof(float));
                    for (size_t j = 0; j < length; j++) {
                        floatData[j] = int16Data[j] / 32768.0f;
                    }
                } else {
                    NSLog(@"⚠️ Unsupported audio format flags: %u", asbd->mFormatFlags);
                    continue;
                }
            } else {
                // Default: assume Float32
                length = buffer.mDataByteSize / sizeof(float);
                floatData = (float*)buffer.mData;
            }
            
            if (floatData && length > 0) {
                // Log first few samples to verify audio is coming through
                if (sampleCount < 5) {
                    // Check if audio has non-zero values
                    float maxValue = 0.0;
                    float minValue = 0.0;
                    for (size_t j = 0; j < length && j < 100; j++) {
                        if (floatData[j] > maxValue) maxValue = floatData[j];
                        if (floatData[j] < minValue) minValue = floatData[j];
                    }
                    NSLog(@"🎵 Audio sample %d: %lu floats, range: [%f, %f], first: %f", 
                          sampleCount, length, minValue, maxValue, length > 0 ? floatData[0] : 0.0);
                    sampleCount++;
                }
                
                self.callback(floatData, length);
                
                // Free converted buffer if we allocated it
                if (asbd && !(asbd->mFormatFlags & kAudioFormatFlagIsFloat)) {
                    free(floatData);
                }
            }
        }
    }
    
    free(allocatedBufferList);
    if (blockBuffer) {
        CFRelease(blockBuffer);
    }
}

@end

// Main addon class
class AudioCaptureAddon : public Napi::ObjectWrap<AudioCaptureAddon> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    AudioCaptureAddon(const Napi::CallbackInfo& info);
    ~AudioCaptureAddon();

private:
    static Napi::FunctionReference constructor;
    
    // ScreenCaptureKit members
    SCStream* stream_;
    StreamOutputHandler* outputHandler_;
    
    // HAL members
    AudioUnit halAudioUnit_;
    AudioDeviceID currentDeviceID_;
    AudioStreamBasicDescription inputFormat_;
    AudioStreamBasicDescription outputFormat_;
    bool deviceChangeListenerRegistered_;
    CaptureMode captureMode_;
    
    // Common members
    bool isCapturing_;
    Napi::ThreadSafeFunction tsfn_;
    Napi::FunctionReference callback_;
    
    Napi::Value Start(const Napi::CallbackInfo& info);
    Napi::Value Stop(const Napi::CallbackInfo& info);
    Napi::Value IsActive(const Napi::CallbackInfo& info);
    
    void OnAudioData(const float* data, size_t length);
    void StartCaptureAsync();
    
    // HAL methods
    bool StartHALCapture();
    void StopHALCapture();
    bool SetupHALAudioUnit();
    bool AttachToDefaultOutputDevice();
    void HandleDeviceChange();
    void DownmixToMono(const float* stereoData, size_t stereoFrames, float* monoData);
    void ResampleAudio(const float* input, size_t inputFrames, float* output, size_t outputFrames, double inputRate, double outputRate);
    
    // Static callback for HAL render
    static OSStatus HALRenderCallback(void* inRefCon,
                                      AudioUnitRenderActionFlags* ioActionFlags,
                                      const AudioTimeStamp* inTimeStamp,
                                      UInt32 inBusNumber,
                                      UInt32 inNumberFrames,
                                      AudioBufferList* ioData);
    
    // Static callback for device changes
    static OSStatus DeviceChangeCallback(AudioObjectID inObjectID,
                                         UInt32 inNumberAddresses,
                                         const AudioObjectPropertyAddress inAddresses[],
                                         void* inClientData);
};

Napi::FunctionReference AudioCaptureAddon::constructor;

Napi::Object AudioCaptureAddon::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "AudioCapture", {
        InstanceMethod("start", &AudioCaptureAddon::Start),
        InstanceMethod("stop", &AudioCaptureAddon::Stop),
        InstanceMethod("isActive", &AudioCaptureAddon::IsActive),
    });
    
    constructor = Napi::Persistent(func);
    constructor.SuppressDestruct();
    
    exports.Set("AudioCapture", func);
    return exports;
}

AudioCaptureAddon::AudioCaptureAddon(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<AudioCaptureAddon>(info),
      stream_(nil),
      outputHandler_(nil),
      halAudioUnit_(nullptr),
      currentDeviceID_(0),
      deviceChangeListenerRegistered_(false),
      captureMode_(CAPTURE_MODE_SCREENCAPTUREKIT), // Default, will be overridden if options provided
      isCapturing_(false) {
    
    // Initialize audio format structs
    memset(&inputFormat_, 0, sizeof(inputFormat_));
    memset(&outputFormat_, 0, sizeof(outputFormat_));
    
    Napi::Env env = info.Env();
    
    // CRITICAL: Read mode from constructor options BEFORE any initialization
    // This ensures HAL mode is set before ScreenCaptureKit code can run
    if (info.Length() > 1 && info[1].IsObject()) {
        Napi::Object options = info[1].As<Napi::Object>();
        if (options.Has("mode")) {
            Napi::Value modeValue = options.Get("mode");
            if (modeValue.IsString()) {
                std::string mode = modeValue.As<Napi::String>().Utf8Value();
                if (mode == "hal" || mode == "HAL") {
                    captureMode_ = CAPTURE_MODE_HAL;
                    NSLog(@"🎯 HAL mode set in constructor (before any initialization)");
                } else if (mode == "screencapturekit" || mode == "ScreenCaptureKit") {
                    captureMode_ = CAPTURE_MODE_SCREENCAPTUREKIT;
                    NSLog(@"📺 ScreenCaptureKit mode set in constructor");
                }
            }
        }
    }
    
    // Log final mode to confirm
    if (captureMode_ == CAPTURE_MODE_HAL) {
        NSLog(@"🟢 HAL MODE CONFIRMED — ScreenCaptureKit disabled from constructor");
    }
    
    // Create thread-safe function for callbacks
    if (info.Length() > 0 && info[0].IsFunction()) {
        try {
            Napi::Function cb = info[0].As<Napi::Function>();
            callback_ = Napi::Persistent(cb);
            
            tsfn_ = Napi::ThreadSafeFunction::New(
                env,
                cb,
                "AudioCapture",
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

AudioCaptureAddon::~AudioCaptureAddon() {
    NSLog(@"🧹 Destructor called, cleaning up...");
    
    // Clear global instance pointer if it points to us
    if (g_captureInstance == this) {
        g_captureInstance = nullptr;
    }
    
    // Stop capture based on mode
    if (isCapturing_) {
        isCapturing_ = false;
        
        if (captureMode_ == CAPTURE_MODE_HAL) {
            StopHALCapture();
        } else if (stream_) {
            __block BOOL stopCompleted = NO;
            __block SCStream* streamToStop = stream_;
            
            // Check if we're on the main thread to avoid deadlock
            if ([NSThread isMainThread]) {
                // Already on main thread, execute directly
                @autoreleasepool {
                    if (streamToStop) {
                        [streamToStop stopCaptureWithCompletionHandler:^(NSError* error) {
                            if (error) {
                                NSLog(@"⚠️ Error stopping capture in destructor: %@", error.localizedDescription);
                            }
                            stopCompleted = YES;
                        }];
                        
                        // Wait a bit for completion
                        NSDate* timeout = [NSDate dateWithTimeIntervalSinceNow:0.3];
                        while (!stopCompleted && [timeout timeIntervalSinceNow] > 0) {
                            [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
                        }
                    }
                }
            } else {
                // Not on main thread, use dispatch_async (can't use sync from destructor)
                dispatch_async(dispatch_get_main_queue(), ^{
                    @autoreleasepool {
                        if (streamToStop) {
                            [streamToStop stopCaptureWithCompletionHandler:^(NSError* error) {
                                if (error) {
                                    NSLog(@"⚠️ Error stopping capture in destructor: %@", error.localizedDescription);
                                }
                            }];
                        }
                    }
                });
                // Brief sleep to give async call a chance to start
                usleep(50000); // 50ms
            }
        }
    }
    
    // Clear references
    stream_ = nil;
    outputHandler_ = nil;
    
    // Release thread-safe function if it was created
    try {
        if (tsfn_) {
            tsfn_.Release();
        }
    } catch (...) {
        // Ignore errors during cleanup
        NSLog(@"⚠️ Error releasing thread-safe function in destructor");
    }
    
    NSLog(@"✅ Destructor completed");
}

void AudioCaptureAddon::OnAudioData(const float* data, size_t length) {
    // Debug: Log first few calls
    static int onAudioDataCallCount = 0;
    if (onAudioDataCallCount < 5) {
        NSLog(@"🔵 OnAudioData called #%d: length=%zu, isCapturing=%d, tsfn_=%p",
              onAudioDataCallCount, length, isCapturing_, tsfn_ ? (void*)0x1 : nullptr);
        onAudioDataCallCount++;
    }
    
    // Check if we're still capturing
    if (!isCapturing_) {
        if (onAudioDataCallCount <= 5) {
            NSLog(@"⚠️ OnAudioData: not capturing, returning early");
        }
        return;
    }
    
    if (length == 0 || !data) {
        if (onAudioDataCallCount <= 5) {
            NSLog(@"⚠️ OnAudioData: invalid data (length=%zu, data=%p)", length, data);
        }
        return;
    }
    
    // Copy data for thread safety
    std::vector<float> audioData(data, data + length);
    
    try {
        // Check if thread-safe function is valid before calling
        if (!tsfn_) {
            if (onAudioDataCallCount <= 5) {
                NSLog(@"❌ OnAudioData: tsfn_ is NULL! Cannot call JS callback");
            }
            return;
        }
        
        if (onAudioDataCallCount <= 5) {
            NSLog(@"✅ OnAudioData: Calling tsfn_.NonBlockingCall with %zu samples", audioData.size());
        }
        
        tsfn_.NonBlockingCall([audioData](Napi::Env env, Napi::Function jsCallback) {
            try {
                if (jsCallback.IsEmpty() || jsCallback.IsUndefined()) {
                    NSLog(@"⚠️ JS callback is empty or undefined");
                    return;
                }
                // Convert to Buffer for efficient transfer
                Napi::Buffer<float> buffer = Napi::Buffer<float>::Copy(env, audioData.data(), audioData.size());
                jsCallback.Call({buffer});
                static int jsCallbackCallCount = 0;
                if (jsCallbackCallCount < 3) {
                    NSLog(@"✅ JS callback invoked successfully #%d, buffer size=%zu", jsCallbackCallCount, audioData.size());
                    jsCallbackCallCount++;
                }
            } catch (const Napi::Error& e) {
                NSLog(@"❌ Error in JS callback: %s", e.Message().c_str());
            } catch (...) {
                NSLog(@"❌ Unknown error in JS callback");
            }
        });
    } catch (const Napi::Error& e) {
        NSLog(@"❌ Napi::Error in OnAudioData: %s", e.Message().c_str());
    } catch (const std::exception& e) {
        NSLog(@"❌ std::exception in OnAudioData: %s", e.what());
    } catch (...) {
        NSLog(@"❌ Unknown exception in OnAudioData");
    }
}

// MARK: - HAL Implementation

OSStatus AudioCaptureAddon::HALRenderCallback(void* inRefCon,
                                               AudioUnitRenderActionFlags* ioActionFlags,
                                               const AudioTimeStamp* inTimeStamp,
                                               UInt32 inBusNumber,
                                               UInt32 inNumberFrames,
                                               AudioBufferList* ioData) {
    AudioCaptureAddon* self = (__bridge AudioCaptureAddon*)inRefCon;
    
    // Debug: Log first few callbacks to verify AudioUnit is firing
    static int callbackCount = 0;
    if (callbackCount < 3) {
        NSLog(@"🎧 HALRenderCallback fired #%d, frames=%u, isCapturing=%d", 
              callbackCount, inNumberFrames, self ? self->isCapturing_ : 0);
        callbackCount++;
    }
    
    if (!self || !self->isCapturing_ || !self->halAudioUnit_) {
        if (callbackCount <= 3) {
            NSLog(@"⚠️ HALRenderCallback: dropping audio (self=%p, isCapturing=%d, halAudioUnit=%p)",
                  self, self ? self->isCapturing_ : 0, self ? self->halAudioUnit_ : nullptr);
        }
        return noErr;
    }
    
    // Safety check: ensure format is initialized
    if (self->inputFormat_.mSampleRate == 0 || self->inputFormat_.mChannelsPerFrame == 0) {
        if (callbackCount <= 5) {
            NSLog(@"⚠️ HALRenderCallback: Format not initialized (sampleRate=%.0f, channels=%u)",
                  self->inputFormat_.mSampleRate, self->inputFormat_.mChannelsPerFrame);
        }
        return noErr;
    }
    
    // Allocate buffer for rendered audio
    AudioBufferList bufferList;
    bufferList.mNumberBuffers = 1;
    bufferList.mBuffers[0].mNumberChannels = self->inputFormat_.mChannelsPerFrame;
    bufferList.mBuffers[0].mDataByteSize = inNumberFrames * self->inputFormat_.mBytesPerFrame;
    bufferList.mBuffers[0].mData = malloc(bufferList.mBuffers[0].mDataByteSize);
    
    if (!bufferList.mBuffers[0].mData) {
        if (callbackCount <= 5) {
            NSLog(@"❌ HALRenderCallback: Memory allocation failed for %u bytes", bufferList.mBuffers[0].mDataByteSize);
        }
        return -1; // Memory allocation failed
    }
    
    // Render audio from the output unit
    if (callbackCount <= 5) {
        NSLog(@"🔄 HALRenderCallback: Calling AudioUnitRender (frames=%u)", inNumberFrames);
    }
    
    OSStatus status = AudioUnitRender(self->halAudioUnit_,
                                      ioActionFlags,
                                      inTimeStamp,
                                      0,  // output bus
                                      inNumberFrames,
                                      &bufferList);
    
    if (callbackCount <= 5) {
        NSLog(@"🔄 HALRenderCallback: AudioUnitRender status=%d (0=success)", (int)status);
    }
    
    if (status == noErr) {
        Float32* audioData = (Float32*)bufferList.mBuffers[0].mData;
        
        // Process audio: downmix to mono and resample if needed
        double targetSampleRate = 48000.0;
        double inputSampleRate = self->inputFormat_.mSampleRate;
        size_t outputFrames = inNumberFrames;
        
        // Calculate output frames if resampling needed
        if (inputSampleRate != targetSampleRate) {
            outputFrames = (size_t)(inNumberFrames * (targetSampleRate / inputSampleRate));
        }
        
        // Allocate output buffer (mono, potentially resampled)
        size_t outputSize = outputFrames * sizeof(Float32);
        Float32* processedData = (Float32*)malloc(outputSize);
        
        if (callbackCount <= 5) {
            NSLog(@"🔄 HALRenderCallback: Allocated processedData buffer: %zu bytes (outputFrames=%zu)", outputSize, outputFrames);
        }
        
        if (processedData) {
            if (self->inputFormat_.mChannelsPerFrame > 1) {
                // Downmix to mono first (on input frames)
                Float32* monoData = (Float32*)malloc(inNumberFrames * sizeof(Float32));
                if (monoData) {
                    self->DownmixToMono(audioData, inNumberFrames, monoData);
                    
                    // Resample if needed
                    if (inputSampleRate != targetSampleRate) {
                        self->ResampleAudio(monoData, inNumberFrames, processedData, outputFrames, inputSampleRate, targetSampleRate);
                        free(monoData);
                    } else {
                        // No resampling needed, just copy mono data
                        memcpy(processedData, monoData, inNumberFrames * sizeof(Float32));
                        free(monoData);
                    }
                } else {
                    free(processedData);
                    free(bufferList.mBuffers[0].mData);
                    return -1;
                }
            } else {
                // Already mono, just resample if needed
                if (inputSampleRate != targetSampleRate) {
                    self->ResampleAudio(audioData, inNumberFrames, processedData, outputFrames, inputSampleRate, targetSampleRate);
                } else {
                    // No resampling needed, just copy
                    memcpy(processedData, audioData, inNumberFrames * sizeof(Float32));
                }
            }
            
            // Send to callback
            if (callbackCount <= 5) {
                NSLog(@"📤 HALRenderCallback: Calling OnAudioData with %zu frames", outputFrames);
            }
            self->OnAudioData(processedData, outputFrames);
            free(processedData);
        } else {
            if (callbackCount <= 5) {
                NSLog(@"❌ HALRenderCallback: Failed to allocate processedData buffer (%zu bytes)", outputSize);
            }
        }
    } else {
        if (callbackCount <= 5) {
            NSLog(@"❌ HALRenderCallback: AudioUnitRender failed with status=%d", (int)status);
        }
    }
    
    free(bufferList.mBuffers[0].mData);
    return noErr;
}

OSStatus AudioCaptureAddon::DeviceChangeCallback(AudioObjectID inObjectID,
                                                 UInt32 inNumberAddresses,
                                                 const AudioObjectPropertyAddress inAddresses[],
                                                 void* inClientData) {
    AudioCaptureAddon* self = (__bridge AudioCaptureAddon*)inClientData;
    
    if (!self) {
        return noErr;
    }
    
    // Check if default output device changed
    for (UInt32 i = 0; i < inNumberAddresses; i++) {
        if (inAddresses[i].mSelector == kAudioHardwarePropertyDefaultOutputDevice) {
            NSLog(@"🔄 Default output device changed, reattaching...");
            dispatch_async(dispatch_get_main_queue(), ^{
                self->HandleDeviceChange();
            });
            break;
        }
    }
    
    return noErr;
}

void AudioCaptureAddon::DownmixToMono(const float* stereoData, size_t stereoFrames, float* monoData) {
    // Safety checks
    if (!stereoData || !monoData || stereoFrames == 0) {
        return;
    }
    
    // Simple average downmix: (L + R) / 2
    // stereoData is interleaved: [L0, R0, L1, R1, ...]
    for (size_t i = 0; i < stereoFrames; i++) {
        size_t leftIdx = i * 2;
        size_t rightIdx = leftIdx + 1;
        monoData[i] = (stereoData[leftIdx] + stereoData[rightIdx]) * 0.5f;
    }
}

void AudioCaptureAddon::ResampleAudio(const float* input, size_t inputFrames, float* output, size_t outputFrames, double inputRate, double outputRate) {
    // Safety checks
    if (!input || !output || inputFrames == 0 || outputFrames == 0 || inputRate <= 0 || outputRate <= 0) {
        if (output && outputFrames > 0) {
            // Zero out output buffer
            for (size_t i = 0; i < outputFrames; i++) {
                output[i] = 0.0f;
            }
        }
        return;
    }
    
    // Simple linear interpolation resampling
    double ratio = inputRate / outputRate;
    
    for (size_t i = 0; i < outputFrames; i++) {
        double srcPos = i * ratio;
        size_t srcIdx = (size_t)srcPos;
        double fraction = srcPos - srcIdx;
        
        if (srcIdx + 1 < inputFrames) {
            // Linear interpolation
            output[i] = input[srcIdx] * (1.0 - fraction) + input[srcIdx + 1] * fraction;
        } else if (srcIdx < inputFrames) {
            output[i] = input[srcIdx];
        } else {
            output[i] = 0.0f;
        }
    }
}

bool AudioCaptureAddon::AttachToDefaultOutputDevice() {
    AudioDeviceID deviceID = 0;
    UInt32 size = sizeof(deviceID);
    
    AudioObjectPropertyAddress addr = {
        kAudioHardwarePropertyDefaultOutputDevice,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };
    
    OSStatus status = AudioObjectGetPropertyData(
        kAudioObjectSystemObject,
        &addr,
        0,
        NULL,
        &size,
        &deviceID
    );
    
    if (status != noErr || deviceID == 0) {
        NSLog(@"❌ Failed to get default output device: %d", (int)status);
        return false;
    }
    
    NSLog(@"🎧 Default output device ID: %u", (unsigned int)deviceID);
    currentDeviceID_ = deviceID;
    
    // Set the device on the AudioUnit
    status = AudioUnitSetProperty(
        halAudioUnit_,
        kAudioOutputUnitProperty_CurrentDevice,
        kAudioUnitScope_Global,
        0,
        &deviceID,
        sizeof(deviceID)
    );
    
    if (status != noErr) {
        NSLog(@"❌ Failed to set device on AudioUnit: %d", (int)status);
        return false;
    }
    
    // Register for device change notifications
    if (!deviceChangeListenerRegistered_) {
        status = AudioObjectAddPropertyListener(
            kAudioObjectSystemObject,
            &addr,
            DeviceChangeCallback,
            (__bridge void*)this
        );
        
        if (status == noErr) {
            deviceChangeListenerRegistered_ = true;
            NSLog(@"👂 Registered for device change notifications");
        } else {
            NSLog(@"⚠️ Failed to register device change listener: %d", (int)status);
        }
    }
    
    return true;
}

bool AudioCaptureAddon::SetupHALAudioUnit() {
    // Find HAL Output component
    AudioComponentDescription desc;
    desc.componentType = kAudioUnitType_Output;
    desc.componentSubType = kAudioUnitSubType_HALOutput;
    desc.componentManufacturer = kAudioUnitManufacturer_Apple;
    desc.componentFlags = 0;
    desc.componentFlagsMask = 0;
    
    AudioComponent comp = AudioComponentFindNext(NULL, &desc);
    if (!comp) {
        NSLog(@"❌ HALOutput AudioComponent not found");
        return false;
    }
    
    // Create AudioUnit instance
    OSStatus status = AudioComponentInstanceNew(comp, &halAudioUnit_);
    if (status != noErr) {
        NSLog(@"❌ Failed to create AudioUnit: %d", (int)status);
        return false;
    }
    
    // Enable output I/O (critical - without this, AudioUnitRender returns silence)
    UInt32 enableIO = 1;
    status = AudioUnitSetProperty(
        halAudioUnit_,
        kAudioOutputUnitProperty_EnableIO,
        kAudioUnitScope_Output,
        0,  // output bus
        &enableIO,
        sizeof(enableIO)
    );
    
    if (status != noErr) {
        NSLog(@"❌ Failed to enable output I/O: %d", (int)status);
        AudioComponentInstanceDispose(halAudioUnit_);
        halAudioUnit_ = nullptr;
        return false;
    }
    
    // Disable input I/O (we only want output)
    enableIO = 0;
    status = AudioUnitSetProperty(
        halAudioUnit_,
        kAudioOutputUnitProperty_EnableIO,
        kAudioUnitScope_Input,
        1,  // input bus
        &enableIO,
        sizeof(enableIO)
    );
    
    // Attach to default output device
    if (!AttachToDefaultOutputDevice()) {
        AudioComponentInstanceDispose(halAudioUnit_);
        halAudioUnit_ = nullptr;
        return false;
    }
    
    // Get the stream format
    UInt32 formatSize = sizeof(inputFormat_);
    status = AudioUnitGetProperty(
        halAudioUnit_,
        kAudioUnitProperty_StreamFormat,
        kAudioUnitScope_Output,
        0,
        &inputFormat_,
        &formatSize
    );
    
    if (status != noErr) {
        NSLog(@"❌ Failed to get stream format: %d", (int)status);
        AudioComponentInstanceDispose(halAudioUnit_);
        halAudioUnit_ = nullptr;
        return false;
    }
    
    NSLog(@"🎚️ HAL Audio format: sampleRate=%.0f, channels=%u, format=%u, bytesPerFrame=%u",
          inputFormat_.mSampleRate, inputFormat_.mChannelsPerFrame, inputFormat_.mFormatID, inputFormat_.mBytesPerFrame);
    
    // Set up render callback
    AURenderCallbackStruct callbackStruct;
    callbackStruct.inputProc = HALRenderCallback;
    callbackStruct.inputProcRefCon = (__bridge void*)this;
    
    status = AudioUnitSetProperty(
        halAudioUnit_,
        kAudioUnitProperty_SetRenderCallback,
        kAudioUnitScope_Global,
        0,
        &callbackStruct,
        sizeof(callbackStruct)
    );
    
    if (status != noErr) {
        NSLog(@"❌ Failed to set render callback: %d", (int)status);
        AudioComponentInstanceDispose(halAudioUnit_);
        halAudioUnit_ = nullptr;
        return false;
    }
    
    // Initialize AudioUnit
    status = AudioUnitInitialize(halAudioUnit_);
    if (status != noErr) {
        NSLog(@"❌ Failed to initialize AudioUnit: %d", (int)status);
        AudioComponentInstanceDispose(halAudioUnit_);
        halAudioUnit_ = nullptr;
        return false;
    }
    
    return true;
}

bool AudioCaptureAddon::StartHALCapture() {
    NSLog(@"🎯 Starting HAL capture (experimental mode)...");
    
    if (!SetupHALAudioUnit()) {
        NSLog(@"❌ Failed to setup HAL AudioUnit");
        return false;
    }
    
    // CRITICAL: Set isCapturing_ BEFORE starting AudioUnit
    // AudioUnit callbacks can fire immediately after AudioOutputUnitStart(),
    // and the callback checks isCapturing_ at the very beginning.
    // If we set it after, we'll drop the first audio frames.
    isCapturing_ = true;
    
    // Start the AudioUnit
    OSStatus status = AudioOutputUnitStart(halAudioUnit_);
    if (status != noErr) {
        NSLog(@"❌ Failed to start AudioUnit: %d", (int)status);
        isCapturing_ = false; // Reset on failure
        AudioUnitUninitialize(halAudioUnit_);
        AudioComponentInstanceDispose(halAudioUnit_);
        halAudioUnit_ = nullptr;
        return false;
    }
    
    NSLog(@"✅ HAL audio capture started successfully");
    return true;
}

void AudioCaptureAddon::StopHALCapture() {
    NSLog(@"🛑 Stopping HAL capture...");
    
    if (halAudioUnit_) {
        AudioOutputUnitStop(halAudioUnit_);
        AudioUnitUninitialize(halAudioUnit_);
        AudioComponentInstanceDispose(halAudioUnit_);
        halAudioUnit_ = nullptr;
    }
    
    // Remove device change listener
    if (deviceChangeListenerRegistered_) {
        AudioObjectPropertyAddress addr = {
            kAudioHardwarePropertyDefaultOutputDevice,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };
        
        AudioObjectRemovePropertyListener(
            kAudioObjectSystemObject,
            &addr,
            DeviceChangeCallback,
            (__bridge void*)this
        );
        
        deviceChangeListenerRegistered_ = false;
    }
    
    currentDeviceID_ = 0;
    NSLog(@"✅ HAL capture stopped");
}

void AudioCaptureAddon::HandleDeviceChange() {
    if (!isCapturing_ || captureMode_ != CAPTURE_MODE_HAL) {
        return;
    }
    
    NSLog(@"🔄 Handling device change...");
    
    // Stop current capture
    AudioOutputUnitStop(halAudioUnit_);
    AudioUnitUninitialize(halAudioUnit_);
    
    // Reattach to new device
    if (AttachToDefaultOutputDevice()) {
        // Reinitialize and restart
        OSStatus status = AudioUnitInitialize(halAudioUnit_);
        if (status == noErr) {
            status = AudioOutputUnitStart(halAudioUnit_);
            if (status == noErr) {
                NSLog(@"✅ Successfully reattached to new device");
            } else {
                NSLog(@"❌ Failed to restart AudioUnit after device change: %d", (int)status);
                isCapturing_ = false;
            }
        } else {
            NSLog(@"❌ Failed to reinitialize AudioUnit after device change: %d", (int)status);
            isCapturing_ = false;
        }
    } else {
        NSLog(@"❌ Failed to attach to new device");
        isCapturing_ = false;
    }
}

void AudioCaptureAddon::StartCaptureAsync() {
    // CRITICAL GUARD: Never run ScreenCaptureKit if HAL mode is active
    // This must be the FIRST check - if HAL is active, ScreenCaptureKit is completely disabled
    if (captureMode_ == CAPTURE_MODE_HAL) {
        NSLog(@"🚫 FATAL ERROR: StartCaptureAsync called in HAL mode - this should NEVER happen!");
        NSLog(@"🚫 ScreenCaptureKit is completely disabled in HAL mode");
        NSLog(@"🚫 This indicates a logic error - HAL mode must be set in constructor");
        isCapturing_ = false;
        return;
    }
    
    NSLog(@"📺 ScreenCaptureKit mode active - screen recording icon may appear");
    
    __block AudioCaptureAddon* blockSelf = this;
    
    // Use ScreenCaptureKit directly - use the Objective-C compatible method
    dispatch_async(dispatch_get_main_queue(), ^{
        @autoreleasepool {
            // Use SCShareableContent.getShareableContentWithCompletionHandler: directly
            // This is the Objective-C compatible method (Swift async methods aren't accessible)
            Class shareableContentClass = NSClassFromString(@"SCShareableContent");
            if (!shareableContentClass) {
                NSLog(@"❌ SCShareableContent class not found");
                blockSelf->isCapturing_ = false;
                return;
            }
            
            // Use the Objective-C compatible method directly
            SEL getContentSelector = NSSelectorFromString(@"getShareableContentWithCompletionHandler:");
            if ([shareableContentClass respondsToSelector:getContentSelector]) {
                        NSLog(@"📞 Calling getShareableContentWithCompletionHandler:");
                        
                        // Create a retained block to prevent deallocation
                        // Use a strong reference to self to prevent deallocation
                        AudioCaptureAddon* strongSelf = this;
                        void (^completionHandler)(SCShareableContent*, NSError*) = [^(SCShareableContent* content, NSError* error) {
                            AudioCaptureAddon* blockSelf = strongSelf;
                            if (!blockSelf) {
                                NSLog(@"❌ AudioCaptureAddon instance deallocated");
                                return;
                            }
                            if (error) {
                                NSLog(@"❌ Error getting shareable content: %@", error.localizedDescription);
                                blockSelf->isCapturing_ = false;
                                return;
                            }
                            
                            if (!content) {
                                NSLog(@"❌ No shareable content returned");
                                blockSelf->isCapturing_ = false;
                                return;
                            }
                            
                            NSLog(@"📺 Got shareable content: %lu displays", (unsigned long)content.displays.count);
                            
                            if (content.displays.count == 0) {
                                NSLog(@"❌ No displays available");
                                blockSelf->isCapturing_ = false;
                                return;
                            }
                            
                            // Get first display
                            SCDisplay* display = content.displays.firstObject;
                            NSLog(@"🖥️ Using display: %u", (unsigned int)display.displayID);
                            
                            // Create content filter
                            SCContentFilter* filter = [[SCContentFilter alloc] initWithDisplay:display excludingWindows:@[]];
                            if (!filter) {
                                NSLog(@"❌ Failed to create content filter");
                                blockSelf->isCapturing_ = false;
                                return;
                            }
                            
                            // Create stream configuration
                            SCStreamConfiguration* config = [[SCStreamConfiguration alloc] init];
                            config.capturesAudio = YES;
                            config.sampleRate = 48000;
                            config.channelCount = 1;
                            NSLog(@"⚙️ Stream config: audio=YES, sampleRate=48000, channels=1");
                            
                            // Create output handler with weak reference check
                            StreamOutputHandler* handler = [[StreamOutputHandler alloc] init];
                            handler.callback = ^(const float* data, size_t length) {
                                // Use global instance pointer and check if still valid
                                AudioCaptureAddon* instance = g_captureInstance;
                                if (instance && instance->isCapturing_ && length > 0) {
                                    instance->OnAudioData(data, length);
                                }
                            };
                            
                            // Create stream - retain it immediately
                            SCStream* stream = [[SCStream alloc] initWithFilter:filter configuration:config delegate:nil];
                            
                            if (!stream) {
                                NSLog(@"❌ Failed to create stream");
                                blockSelf->isCapturing_ = false;
                                return;
                            }
                            
                            NSLog(@"✅ Stream created successfully");
                            
                            // Retain stream and handler to prevent deallocation
                            blockSelf->stream_ = stream;
                            blockSelf->outputHandler_ = handler;
                            
                            // Add stream output
                            NSError* outputError = nil;
                            BOOL added = [stream addStreamOutput:handler type:SCStreamOutputTypeAudio sampleHandlerQueue:nil error:&outputError];
                            
                            if (!added || outputError) {
                                NSLog(@"❌ Error adding stream output: %@", outputError ? outputError.localizedDescription : @"Unknown error");
                                blockSelf->isCapturing_ = false;
                                blockSelf->stream_ = nil;
                                blockSelf->outputHandler_ = nil;
                                return;
                            }
                            
                            NSLog(@"✅ Stream output added, starting capture...");
                            
                            // Start capture - use a strong reference in the completion handler
                            AudioCaptureAddon* captureSelf = blockSelf;
                            [stream startCaptureWithCompletionHandler:^(NSError* startError) {
                                if (startError) {
                                    NSLog(@"❌ Error starting capture: %@", startError.localizedDescription);
                                    if (captureSelf) {
                                        captureSelf->isCapturing_ = false;
                                        captureSelf->stream_ = nil;
                                        captureSelf->outputHandler_ = nil;
                                    }
                                } else {
                                    NSLog(@"✅ Native macOS audio capture started successfully");
                                    if (captureSelf) {
                                        captureSelf->isCapturing_ = true;
                                    }
                                }
                            }];
                        } copy]; // Copy the block to heap
                        
                        // Try to call the method directly using performSelector if possible
                        // Otherwise use NSInvocation with proper block handling
                        if ([shareableContentClass instancesRespondToSelector:getContentSelector]) {
                            // It's an instance method - we need an instance
                            NSLog(@"⚠️ getShareableContentWithCompletionHandler: is an instance method, trying class method");
                        }
                        
                        // Use NSInvocation to safely call the method with block parameter
                        NSMethodSignature* sig = [shareableContentClass methodSignatureForSelector:getContentSelector];
                        if (!sig) {
                            NSLog(@"❌ Method signature not found for getShareableContentWithCompletionHandler:");
                            blockSelf->isCapturing_ = false;
                            return;
                        }
                        
                        NSInvocation* inv = [NSInvocation invocationWithMethodSignature:sig];
                        [inv setTarget:shareableContentClass];
                        [inv setSelector:getContentSelector];
                        [inv setArgument:&completionHandler atIndex:2];
                        [inv retainArguments]; // This retains the block
                        [inv invoke];
                        NSLog(@"📞 Invoked getShareableContentWithCompletionHandler:");
                        
                        // The block is copied and retained by NSInvocation's retainArguments
                        return;
                    } else {
                        NSLog(@"❌ getShareableContentWithCompletionHandler: method not found");
                        blockSelf->isCapturing_ = false;
                        return;
                    }
        }
    });
}

Napi::Value AudioCaptureAddon::Start(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (isCapturing_) {
        return Napi::Boolean::New(env, false);
    }
    
    // Check for mode parameter (optional)
    // start() - defaults to ScreenCaptureKit
    // start({ mode: 'hal' }) - uses HAL
    // start(null, { mode: 'hal' }) - uses HAL (callback already set in constructor)
    // start({ mode: 'screencapturekit' }) - uses ScreenCaptureKit
    CaptureMode requestedMode = CAPTURE_MODE_SCREENCAPTUREKIT;
    
    // Check both info[0] and info[1] for options object
    // This handles: start({ mode: 'hal' }) and start(null, { mode: 'hal' })
    Napi::Object options;
    bool hasOptions = false;
    
    if (info.Length() > 0 && info[0].IsObject()) {
        options = info[0].As<Napi::Object>();
        hasOptions = true;
    } else if (info.Length() > 1 && info[1].IsObject()) {
        options = info[1].As<Napi::Object>();
        hasOptions = true;
    }
    
    if (hasOptions && options.Has("mode")) {
        Napi::Value modeValue = options.Get("mode");
        if (modeValue.IsString()) {
            std::string mode = modeValue.As<Napi::String>().Utf8Value();
            if (mode == "hal" || mode == "HAL") {
                requestedMode = CAPTURE_MODE_HAL;
                NSLog(@"🎯 HAL mode requested (experimental)");
            } else if (mode == "screencapturekit" || mode == "ScreenCaptureKit") {
                requestedMode = CAPTURE_MODE_SCREENCAPTUREKIT;
                NSLog(@"📺 ScreenCaptureKit mode requested");
            }
        }
    }
    
    // Update mode if provided in start() call (though it should already be set in constructor)
    if (hasOptions) {
        captureMode_ = requestedMode;
        if (captureMode_ == CAPTURE_MODE_HAL) {
            NSLog(@"🟢 HAL MODE CONFIRMED in start() — ScreenCaptureKit disabled");
        }
    }
    
    // Guard: HAL mode must never use ScreenCaptureKit
    if (captureMode_ == CAPTURE_MODE_HAL) {
        NSLog(@"🚫 HAL mode active - ScreenCaptureKit will NOT be used");
        // Start HAL capture synchronously (it's fast)
        // Note: isCapturing_ is set INSIDE StartHALCapture() before AudioUnit starts
        // This prevents race condition where callback fires before flag is set
        bool success = StartHALCapture();
        if (success) {
            // isCapturing_ is already set to true in StartHALCapture()
            NSLog(@"✅ HAL capture started - no screen recording icon should appear");
        } else {
            // isCapturing_ is already reset to false in StartHALCapture() on failure
            NSLog(@"❌ HAL capture failed - check logs above for details");
        }
        return Napi::Boolean::New(env, success);
    } else {
        // Start ScreenCaptureKit capture (async)
        // Note: StartCaptureAsync() will log its own message
        StartCaptureAsync();
        // Return true - we're attempting native capture
        // The actual success will be determined asynchronously
        return Napi::Boolean::New(env, true);
    }
}

Napi::Value AudioCaptureAddon::Stop(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!isCapturing_) {
        NSLog(@"⚠️ Stop called but not capturing");
        return env.Undefined();
    }
    
    NSLog(@"🛑 Stopping capture...");
    
    // Mark as not capturing immediately to stop callbacks
    isCapturing_ = false;
    
    // Stop based on capture mode
    if (captureMode_ == CAPTURE_MODE_HAL) {
        StopHALCapture();
    } else if (stream_) {
        __block SCStream* streamToStop = stream_;
        __block BOOL stopCompleted = NO;
        
        // Check if we're on the main queue
        if ([NSThread isMainThread]) {
            // Already on main thread, execute directly
            @autoreleasepool {
                [streamToStop stopCaptureWithCompletionHandler:^(NSError* error) {
                    if (error) {
                        NSLog(@"⚠️ Error stopping capture: %@", error.localizedDescription);
                    } else {
                        NSLog(@"✅ Stream stopped successfully");
                    }
                    stopCompleted = YES;
                }];
                
                // Wait for completion with timeout
                NSDate* timeout = [NSDate dateWithTimeIntervalSinceNow:0.5];
                while (!stopCompleted && [timeout timeIntervalSinceNow] > 0) {
                    [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
                }
                
                if (!stopCompleted) {
                    NSLog(@"⚠️ Stop completion handler timed out, continuing anyway");
                }
            }
        } else {
            // Not on main thread, use dispatch_sync
            dispatch_sync(dispatch_get_main_queue(), ^{
                @autoreleasepool {
                    [streamToStop stopCaptureWithCompletionHandler:^(NSError* error) {
                        if (error) {
                            NSLog(@"⚠️ Error stopping capture: %@", error.localizedDescription);
                        } else {
                            NSLog(@"✅ Stream stopped successfully");
                        }
                        stopCompleted = YES;
                    }];
                    
                    // Wait for completion with timeout
                    NSDate* timeout = [NSDate dateWithTimeIntervalSinceNow:0.5];
                    while (!stopCompleted && [timeout timeIntervalSinceNow] > 0) {
                        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
                    }
                    
                    if (!stopCompleted) {
                        NSLog(@"⚠️ Stop completion handler timed out, continuing anyway");
                    }
                }
            });
        }
        
        // Small delay to ensure all callbacks have finished
        usleep(50000); // 50ms
    }
    
    stream_ = nil;
    outputHandler_ = nil;
    
    NSLog(@"✅ Stop completed");
    return env.Undefined();
}

Napi::Value AudioCaptureAddon::IsActive(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    return Napi::Boolean::New(env, isCapturing_);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    AudioCaptureAddon::Init(env, exports);
    return exports;
}

NODE_API_MODULE(audio_capture, Init)
