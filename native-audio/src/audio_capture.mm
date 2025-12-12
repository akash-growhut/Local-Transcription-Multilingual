#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreGraphics/CoreGraphics.h>
#import <objc/message.h>
#include <napi.h>
#include <vector>
#include <functional>

using namespace Napi;

// Forward declaration
class AudioCaptureAddon;

// Global callback
std::function<void(const float*, size_t)> g_audioCallback;
AudioCaptureAddon* g_captureInstance = nullptr;

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
    
    // Get audio buffer list
    AudioBufferList audioBufferList;
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
    SCStream* stream_;
    StreamOutputHandler* outputHandler_;
    bool isCapturing_;
    Napi::ThreadSafeFunction tsfn_;
    Napi::FunctionReference callback_;
    
    Napi::Value Start(const Napi::CallbackInfo& info);
    Napi::Value Stop(const Napi::CallbackInfo& info);
    Napi::Value IsActive(const Napi::CallbackInfo& info);
    
    void OnAudioData(const float* data, size_t length);
    void StartCaptureAsync();
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
    : Napi::ObjectWrap<AudioCaptureAddon>(info), stream_(nil), outputHandler_(nil), isCapturing_(false) {
    
    Napi::Env env = info.Env();
    
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
    Stop(Napi::CallbackInfo(Env(), {}));
    // Release thread-safe function if it was created
    try {
        tsfn_.Release();
    } catch (...) {
        // Ignore errors during cleanup
    }
}

void AudioCaptureAddon::OnAudioData(const float* data, size_t length) {
    if (length == 0 || !data) {
        return;
    }
    
    // Copy data for thread safety
    std::vector<float> audioData(data, data + length);
    
    try {
        tsfn_.BlockingCall([audioData](Napi::Env env, Napi::Function jsCallback) {
            try {
                if (jsCallback.IsEmpty() || jsCallback.IsUndefined()) {
                    return;
                }
                // Convert to Buffer for efficient transfer
                Napi::Buffer<float> buffer = Napi::Buffer<float>::Copy(env, audioData.data(), audioData.size());
                jsCallback.Call({buffer});
            } catch (const Napi::Error& e) {
                // Log but don't crash - this happens in JS thread
                // Can't use NSLog from JS thread, so just ignore
            } catch (...) {
                // Ignore other errors
            }
        });
    } catch (const Napi::Error& e) {
        // This can happen if the thread-safe function is invalid
        // Log it but don't crash
        NSLog(@"⚠️ Error calling thread-safe function: %s", e.Message().c_str());
    } catch (const std::exception& e) {
        NSLog(@"⚠️ Exception in OnAudioData: %s", e.what());
    } catch (...) {
        // Ignore other errors
    }
}

void AudioCaptureAddon::StartCaptureAsync() {
    __block AudioCaptureAddon* blockSelf = this;
    
    // CRITICAL: Order matters for permission dialog wording!
    // Following Granola's approach to get "system audio" instead of "screen and audio" wording
    dispatch_async(dispatch_get_main_queue(), ^{
        @autoreleasepool {
            // Step 1: Get main display ID directly
            CGDirectDisplayID displayID = CGMainDisplayID();
            if (displayID == kCGNullDirectDisplay) {
                NSLog(@"❌ Failed to get main display ID");
                blockSelf->isCapturing_ = false;
                return;
            }
            
            NSLog(@"🖥️ Using main display ID: %u for audio-only capture", displayID);
            
            // Step 2: Get ONE display from shareable content using minimal API
            // Use sync method with minimal flags to avoid triggering full enumeration
            AudioCaptureAddon* strongSelf = blockSelf;
            [SCShareableContent getShareableContentWithCompletionHandler:^(SCShareableContent* content, NSError* error) {
                AudioCaptureAddon* blockSelf = strongSelf;
                if (!blockSelf) {
                    NSLog(@"❌ AudioCaptureAddon instance deallocated");
                    return;
                }
                
                if (error || !content) {
                    NSLog(@"❌ Error getting shareable content: %@", error ? error.localizedDescription : @"No content");
                    blockSelf->isCapturing_ = false;
                    return;
                }
                
                // Find the display matching our main display ID
                SCDisplay* targetDisplay = nil;
                for (SCDisplay* display in content.displays) {
                    if (display.displayID == displayID) {
                        targetDisplay = display;
                        break;
                    }
                }
                
                if (!targetDisplay && content.displays.count > 0) {
                    // Fallback to first display
                    targetDisplay = content.displays.firstObject;
                }
                
                if (!targetDisplay) {
                    NSLog(@"❌ No display found");
                    blockSelf->isCapturing_ = false;
                    return;
                }
                
                NSLog(@"✅ Found display: %u", (unsigned int)targetDisplay.displayID);
                
                // Step 3: Create filter with AUDIO-ONLY configuration signaled early
                // Exclude all windows to minimize screen context
                SCContentFilter* filter = [[SCContentFilter alloc] initWithDisplay:targetDisplay 
                                                                  excludingWindows:content.windows];
                if (!filter) {
                    NSLog(@"❌ Failed to create content filter");
                    blockSelf->isCapturing_ = false;
                    return;
                }
                
                NSLog(@"✅ Created filter with all windows excluded (audio focus)");
                
                // Step 4: Configure AUDIO-ONLY stream
                SCStreamConfiguration* config = [[SCStreamConfiguration alloc] init];
                config.capturesAudio = YES;
                // No capturesVideo in ObjC - defaults to NO
                config.sampleRate = 16000;
                config.channelCount = 1;
                
                NSLog(@"⚙️ Stream config: audio=YES (video disabled), sampleRate=16000, channels=1");
                
                // Step 5: Create output handler
                StreamOutputHandler* handler = [[StreamOutputHandler alloc] init];
                AudioCaptureAddon* handlerSelf = blockSelf;
                handler.callback = ^(const float* data, size_t length) {
                    if (handlerSelf && length > 0) {
                        handlerSelf->OnAudioData(data, length);
                    }
                };
                
                // Step 6: Create stream
                SCStream* stream = [[SCStream alloc] initWithFilter:filter configuration:config delegate:nil];
                if (!stream) {
                    NSLog(@"❌ Failed to create stream");
                    blockSelf->isCapturing_ = false;
                    return;
                }
                
                NSLog(@"✅ Stream created");
                
                // Retain stream and handler
                blockSelf->stream_ = stream;
                blockSelf->outputHandler_ = handler;
                
                // Step 7: Add stream output
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
                
                // Step 8: Start capture - permission check happens here
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
            }];
        }
    });
}

Napi::Value AudioCaptureAddon::Start(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (isCapturing_) {
        return Napi::Boolean::New(env, false);
    }
    
    // Start native ScreenCaptureKit capture
    StartCaptureAsync();
    
    // Return true - we're attempting native capture
    // The actual success will be determined asynchronously
    return Napi::Boolean::New(env, true);
}

Napi::Value AudioCaptureAddon::Stop(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!isCapturing_) {
        return env.Undefined();
    }
    
    if (stream_) {
        __block SCStream* streamToStop = stream_;
        dispatch_async(dispatch_get_main_queue(), ^{
            @autoreleasepool {
                [streamToStop stopCaptureWithCompletionHandler:^(NSError* error) {
                    if (error) {
                        NSLog(@"Error stopping capture: %@", error.localizedDescription);
                    }
                }];
            }
        });
    }
    
    isCapturing_ = false;
    stream_ = nil;
    outputHandler_ = nil;
    
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
