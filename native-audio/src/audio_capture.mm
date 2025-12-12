#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#include <napi.h>
#include <vector>
#include <functional>

using namespace Napi;

// Forward declaration
class AudioCaptureAddon;

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
    
    // Get audio buffer list
    AudioBufferList audioBufferList;
    CMBlockBufferRef blockBuffer = NULL;
    size_t bufferListSize = 0;
    
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
        return;
    }
    
    AudioBufferList* allocatedBufferList = (AudioBufferList*)malloc(bufferListSize);
    if (!allocatedBufferList) {
        return;
    }
    
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
        free(allocatedBufferList);
        if (blockBuffer) {
            CFRelease(blockBuffer);
        }
        return;
    }
    
    // Process audio buffers
    UInt32 numBuffers = allocatedBufferList->mNumberBuffers;
    for (UInt32 i = 0; i < numBuffers; i++) {
        AudioBuffer buffer = allocatedBufferList->mBuffers[i];
        if (buffer.mData && buffer.mDataByteSize > 0) {
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
                }
            } else {
                // Default: assume Float32
                length = buffer.mDataByteSize / sizeof(float);
                floatData = (float*)buffer.mData;
            }
            
            if (floatData && length > 0) {
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
        }
    }
}

AudioCaptureAddon::~AudioCaptureAddon() {
    Stop(Napi::CallbackInfo(Env(), {}));
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
    
    std::vector<float> audioData(data, data + length);
    
    try {
        tsfn_.BlockingCall([audioData](Napi::Env env, Napi::Function jsCallback) {
            try {
                if (jsCallback.IsEmpty() || jsCallback.IsUndefined()) {
                    return;
                }
                Napi::Buffer<float> buffer = Napi::Buffer<float>::Copy(env, audioData.data(), audioData.size());
                jsCallback.Call({buffer});
            } catch (...) {
                // Ignore errors
            }
        });
    } catch (...) {
        // Ignore errors
    }
}

void AudioCaptureAddon::StartCaptureAsync() {
    __block AudioCaptureAddon* blockSelf = this;
    
    dispatch_async(dispatch_get_main_queue(), ^{
        @autoreleasepool {
            NSLog(@"🎤 Starting ScreenCaptureKit audio-only capture");
            
            // Get shareable content
            [SCShareableContent getShareableContentWithCompletionHandler:^(SCShareableContent* content, NSError* error) {
                if (error || !content) {
                    NSLog(@"❌ Error getting shareable content: %@", error ? error.localizedDescription : @"No content");
                    blockSelf->isCapturing_ = false;
                    return;
                }
                
                // Get primary display (required for filter, even for audio-only)
                SCDisplay* display = content.displays.firstObject;
                if (!display) {
                    NSLog(@"❌ No display found");
                    blockSelf->isCapturing_ = false;
                    return;
                }
                
                NSLog(@"✅ Got display: %u", (unsigned int)display.displayID);
                
                // Create filter - exclude ALL windows to signal audio-only intent
                SCContentFilter* filter = [[SCContentFilter alloc] initWithDisplay:display
                                                                  excludingWindows:content.windows];
                if (!filter) {
                    NSLog(@"❌ Failed to create content filter");
                    blockSelf->isCapturing_ = false;
                    return;
                }
                
                NSLog(@"✅ Created content filter (audio-only mode)");
                
                // Configure AUDIO-ONLY stream
                SCStreamConfiguration* config = [[SCStreamConfiguration alloc] init];
                config.capturesAudio = YES;
                config.sampleRate = 16000;
                config.channelCount = 1;
                
                NSLog(@"⚙️  Stream config: AUDIO ONLY, 16kHz, mono");
                
                // Create output handler
                StreamOutputHandler* handler = [[StreamOutputHandler alloc] init];
                handler.callback = ^(const float* data, size_t length) {
                    if (blockSelf && length > 0) {
                        blockSelf->OnAudioData(data, length);
                    }
                };
                
                // Create stream
                SCStream* stream = [[SCStream alloc] initWithFilter:filter configuration:config delegate:nil];
                if (!stream) {
                    NSLog(@"❌ Failed to create stream");
                    blockSelf->isCapturing_ = false;
                    return;
                }
                
                NSLog(@"✅ Stream created");
                
                blockSelf->stream_ = stream;
                blockSelf->outputHandler_ = handler;
                
                // Add audio stream output
                NSError* outputError = nil;
                BOOL added = [stream addStreamOutput:handler type:SCStreamOutputTypeAudio sampleHandlerQueue:nil error:&outputError];
                
                if (!added || outputError) {
                    NSLog(@"❌ Error adding stream output: %@", outputError ? outputError.localizedDescription : @"Unknown error");
                    blockSelf->isCapturing_ = false;
                    blockSelf->stream_ = nil;
                    blockSelf->outputHandler_ = nil;
                    return;
                }
                
                NSLog(@"✅ Audio stream output added");
                
                // Start capture
                [stream startCaptureWithCompletionHandler:^(NSError* startError) {
                    if (startError) {
                        NSLog(@"❌ Error starting capture: %@", startError.localizedDescription);
                        blockSelf->isCapturing_ = false;
                        blockSelf->stream_ = nil;
                        blockSelf->outputHandler_ = nil;
                    } else {
                        NSLog(@"✅ ScreenCaptureKit audio capture started successfully");
                        NSLog(@"📢 Permission: Screen Recording (required for system audio)");
                        blockSelf->isCapturing_ = true;
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
    
    // Check macOS version (ScreenCaptureKit requires macOS 13.0+)
    NSOperatingSystemVersion requiredVersion = {13, 0, 0};
    if (![[NSProcessInfo processInfo] isOperatingSystemAtLeastVersion:requiredVersion]) {
        NSLog(@"❌ ScreenCaptureKit requires macOS 13.0+");
        return Napi::Boolean::New(env, false);
    }
    
    isCapturing_ = true;
    StartCaptureAsync();
    
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
