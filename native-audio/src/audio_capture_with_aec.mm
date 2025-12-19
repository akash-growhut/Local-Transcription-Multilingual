#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreAudio/CoreAudio.h>
#import <AudioToolbox/AudioToolbox.h>
#import <objc/message.h>
#include <napi.h>
#include <vector>
#include <deque>
#include <mutex>
#include <memory>

// Include WebRTC AEC wrapper (C++ header, safe in Objective-C++)
#include "webrtc_aec_wrapper.h"

using namespace Napi;

// Constants for AEC processing
const int SAMPLE_RATE = 48000;
const int FRAME_SIZE_MS = 10;  // 10ms frames
const int SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_SIZE_MS) / 1000;  // 480 samples

// Forward declarations
class AudioCaptureWithAEC;

// Audio frame buffer for standardizing to 10ms frames
class FrameBuffer {
public:
    FrameBuffer(size_t frameSize) : frameSize_(frameSize) {}
    
    void AddSamples(const float* samples, size_t count) {
        std::lock_guard<std::mutex> lock(mutex_);
        buffer_.insert(buffer_.end(), samples, samples + count);
    }
    
    bool GetFrame(float* output) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (buffer_.size() >= frameSize_) {
            std::copy(buffer_.begin(), buffer_.begin() + frameSize_, output);
            buffer_.erase(buffer_.begin(), buffer_.begin() + frameSize_);
            return true;
        }
        return false;
    }
    
    void Clear() {
        std::lock_guard<std::mutex> lock(mutex_);
        buffer_.clear();
    }
    
private:
    size_t frameSize_;
    std::deque<float> buffer_;
    std::mutex mutex_;
};

// Include WebRTC AEC wrapper
// When WebRTC AEC3 is integrated, this will use the real implementation
#include "webrtc_aec_wrapper.h"

// Stream output handler for ScreenCaptureKit
typedef void (^AudioCallback)(const float* data, size_t length);

@interface AECStreamOutputHandler : NSObject <SCStreamOutput>
@property (nonatomic, copy) AudioCallback callback;
@end

@implementation AECStreamOutputHandler

- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer ofType:(SCStreamOutputType)type {
    if (type != SCStreamOutputTypeAudio) {
        return;
    }
    
    if (!self.callback) {
        return;
    }
    
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
            bool needsFree = false;
            
            if (asbd && asbd->mFormatID == kAudioFormatLinearPCM) {
                if (asbd->mFormatFlags & kAudioFormatFlagIsFloat) {
                    length = buffer.mDataByteSize / sizeof(float);
                    floatData = (float*)buffer.mData;
                } else if (asbd->mFormatFlags & kAudioFormatFlagIsSignedInteger) {
                    length = buffer.mDataByteSize / sizeof(int16_t);
                    int16_t* int16Data = (int16_t*)buffer.mData;
                    floatData = (float*)malloc(length * sizeof(float));
                    needsFree = true;
                    for (size_t j = 0; j < length; j++) {
                        floatData[j] = int16Data[j] / 32768.0f;
                    }
                }
            } else {
                length = buffer.mDataByteSize / sizeof(float);
                floatData = (float*)buffer.mData;
            }
            
            if (floatData && length > 0) {
                self.callback(floatData, length);
            }
            
            if (needsFree && floatData) {
                free(floatData);
            }
        }
    }
    
    free(allocatedBufferList);
    if (blockBuffer) {
        CFRelease(blockBuffer);
    }
}

@end

// Microphone capture using AVAudioEngine
@interface MicrophoneCapture : NSObject
@property (nonatomic, strong) AVAudioEngine* audioEngine;
@property (nonatomic, copy) AudioCallback callback;
@property (nonatomic, assign) AudioCaptureWithAEC* addon;
- (BOOL)start;
- (void)stop;
@end

@implementation MicrophoneCapture

- (instancetype)init {
    self = [super init];
    if (self) {
        self.audioEngine = [[AVAudioEngine alloc] init];
    }
    return self;
}

- (BOOL)start {
    AVAudioInputNode* inputNode = [self.audioEngine inputNode];
    AVAudioFormat* format = [inputNode inputFormatForBus:0];
    
    // Note: We use the native format from the input node
    // Frame buffering will handle any sample rate differences
    // If resampling is needed in the future, use targetFormat:
    // AVAudioFormat* targetFormat = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatFloat32
    //                                                                  sampleRate:SAMPLE_RATE
    //                                                                    channels:1
    //                                                                 interleaved:NO];
    
    NSLog(@"🎤 Microphone format: %.0f Hz, %u channels", format.sampleRate, format.channelCount);
    
    // Install tap on input node
    [inputNode installTapOnBus:0 bufferSize:4096 format:format block:^(AVAudioPCMBuffer* buffer, AVAudioTime* when) {
        if (self.callback && buffer.audioBufferList->mNumberBuffers > 0) {
            AudioBuffer audioBuffer = buffer.audioBufferList->mBuffers[0];
            if (audioBuffer.mData) {
                float* floatData = (float*)audioBuffer.mData;
                size_t frameCount = buffer.frameLength;
                
                // Convert to mono if needed
                if (format.channelCount > 1) {
                    float* monoData = (float*)malloc(frameCount * sizeof(float));
                    float* multiChannel = (float*)audioBuffer.mData;
                    for (size_t i = 0; i < frameCount; i++) {
                        float sum = 0.0f;
                        for (UInt32 ch = 0; ch < format.channelCount; ch++) {
                            sum += multiChannel[i * format.channelCount + ch];
                        }
                        monoData[i] = sum / format.channelCount;
                    }
                    self.callback(monoData, frameCount);
                    free(monoData);
                } else {
                    self.callback(floatData, frameCount);
                }
            }
        }
    }];
    
    NSError* error = nil;
    if (![self.audioEngine startAndReturnError:&error]) {
        NSLog(@"❌ Failed to start audio engine: %@", error.localizedDescription);
        return NO;
    }
    
    NSLog(@"✅ Microphone capture started");
    return YES;
}

- (void)stop {
    AVAudioInputNode* inputNode = [self.audioEngine inputNode];
    [inputNode removeTapOnBus:0];
    [self.audioEngine stop];
    NSLog(@"🛑 Microphone capture stopped");
}

@end

// Main addon class with AEC
class AudioCaptureWithAEC : public Napi::ObjectWrap<AudioCaptureWithAEC> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    AudioCaptureWithAEC(const Napi::CallbackInfo& info);
    ~AudioCaptureWithAEC();
    
    // Expose for Objective-C callback
    void OnSpeakerAudio(const float* data, size_t length);
    void OnMicrophoneAudio(const float* data, size_t length);

private:
    static Napi::FunctionReference constructor;
    
    // Speaker capture
    SCStream* speakerStream_;
    AECStreamOutputHandler* speakerHandler_;
    
    // Microphone capture
    MicrophoneCapture* microphoneCapture_;
    
    // Frame buffers
    std::unique_ptr<FrameBuffer> speakerBuffer_;
    std::unique_ptr<FrameBuffer> microphoneBuffer_;
    
    // AEC processor (WebRTC AEC3 when available, placeholder otherwise)
    std::unique_ptr<WebRTCAEC3> aec_;
    
    // Callbacks
    Napi::ThreadSafeFunction speakerCallback_;
    Napi::ThreadSafeFunction microphoneCallback_;
    
    bool isCapturing_;
    
    Napi::Value Start(const Napi::CallbackInfo& info);
    Napi::Value Stop(const Napi::CallbackInfo& info);
    Napi::Value IsActive(const Napi::CallbackInfo& info);
    
    void StartCaptureAsync();
    void ProcessAudioFrames();
};

Napi::FunctionReference AudioCaptureWithAEC::constructor;

Napi::Object AudioCaptureWithAEC::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "AudioCaptureWithAEC", {
        InstanceMethod("start", &AudioCaptureWithAEC::Start),
        InstanceMethod("stop", &AudioCaptureWithAEC::Stop),
        InstanceMethod("isActive", &AudioCaptureWithAEC::IsActive),
    });
    
    constructor = Napi::Persistent(func);
    constructor.SuppressDestruct();
    
    exports.Set("AudioCaptureWithAEC", func);
    return exports;
}

AudioCaptureWithAEC::AudioCaptureWithAEC(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<AudioCaptureWithAEC>(info),
      speakerStream_(nil),
      speakerHandler_(nil),
      microphoneCapture_(nil),
      isCapturing_(false) {
    
    Napi::Env env = info.Env();
    
    // Initialize frame buffers
    speakerBuffer_ = std::make_unique<FrameBuffer>(SAMPLES_PER_FRAME);
    microphoneBuffer_ = std::make_unique<FrameBuffer>(SAMPLES_PER_FRAME);
    
    // Initialize AEC (uses factory to create real WebRTC AEC3 or placeholder)
    aec_ = WebRTCAEC3::Create(SAMPLE_RATE, 1);
    
    // Create callbacks if provided
    if (info.Length() >= 2 && info[0].IsFunction() && info[1].IsFunction()) {
        Napi::Function speakerCb = info[0].As<Napi::Function>();
        Napi::Function micCb = info[1].As<Napi::Function>();
        
        speakerCallback_ = Napi::ThreadSafeFunction::New(
            env, speakerCb, "SpeakerAudio", 0, 1);
        
        microphoneCallback_ = Napi::ThreadSafeFunction::New(
            env, micCb, "MicrophoneAudio", 0, 1);
    }
}

AudioCaptureWithAEC::~AudioCaptureWithAEC() {
    Stop(Napi::CallbackInfo(nullptr, {}));
}

void AudioCaptureWithAEC::OnSpeakerAudio(const float* data, size_t length) {
    if (!isCapturing_) return;
    
    // Add to frame buffer
    speakerBuffer_->AddSamples(data, length);
    
    // Process frames when we have enough data
    ProcessAudioFrames();
}

void AudioCaptureWithAEC::OnMicrophoneAudio(const float* data, size_t length) {
    if (!isCapturing_) return;
    
    // Add to frame buffer
    microphoneBuffer_->AddSamples(data, length);
    
    // Process frames when we have enough data
    ProcessAudioFrames();
}

void AudioCaptureWithAEC::ProcessAudioFrames() {
    float speakerFrame[SAMPLES_PER_FRAME];
    float micFrame[SAMPLES_PER_FRAME];
    float processedMicFrame[SAMPLES_PER_FRAME];
    
    // CRITICAL: Process speaker (far-end) FIRST, then microphone (near-end)
    // This ensures AEC has the reference signal before processing the echo
    
    // Try to get frames from both buffers
    bool hasSpeaker = speakerBuffer_->GetFrame(speakerFrame);
    bool hasMic = microphoneBuffer_->GetFrame(micFrame);
    
    // Always process speaker first if available (far-end reference)
    if (hasSpeaker) {
        // Process reverse stream (far-end reference) - MUST be called before ProcessStream
        aec_->ProcessReverseStream(speakerFrame, SAMPLES_PER_FRAME);
        
        // Send speaker audio to callback
        if (speakerCallback_) {
            std::vector<float> frameData(speakerFrame, speakerFrame + SAMPLES_PER_FRAME);
            speakerCallback_.NonBlockingCall([frameData](Napi::Env env, Napi::Function jsCallback) {
                Napi::Buffer<float> buffer = Napi::Buffer<float>::Copy(env, frameData.data(), frameData.size());
                jsCallback.Call({buffer});
            });
        }
    }
    
    // Process microphone (near-end) after speaker reference is set
    if (hasMic) {
        // Process near-end stream (with echo cancellation)
        // This uses the far-end reference from ProcessReverseStream
        aec_->ProcessStream(micFrame, SAMPLES_PER_FRAME, processedMicFrame);
        
        // Send processed microphone audio to callback (echo removed)
        if (microphoneCallback_) {
            std::vector<float> frameData(processedMicFrame, processedMicFrame + SAMPLES_PER_FRAME);
            microphoneCallback_.NonBlockingCall([frameData](Napi::Env env, Napi::Function jsCallback) {
                Napi::Buffer<float> buffer = Napi::Buffer<float>::Copy(env, frameData.data(), frameData.size());
                jsCallback.Call({buffer});
            });
        }
    }
    
    // If we have speaker but no mic yet, that's okay - AEC will use the reference later
    // If we have mic but no speaker yet, process without echo cancellation (pass through)
    if (hasMic && !hasSpeaker) {
        // No speaker reference yet, pass through (will improve once speaker starts)
        if (microphoneCallback_) {
            std::vector<float> frameData(micFrame, micFrame + SAMPLES_PER_FRAME);
            microphoneCallback_.NonBlockingCall([frameData](Napi::Env env, Napi::Function jsCallback) {
                Napi::Buffer<float> buffer = Napi::Buffer<float>::Copy(env, frameData.data(), frameData.size());
                jsCallback.Call({buffer});
            });
        }
    }
}

void AudioCaptureWithAEC::StartCaptureAsync() {
    __block AudioCaptureWithAEC* blockSelf = this;
    
    dispatch_async(dispatch_get_main_queue(), ^{
        @autoreleasepool {
            // Start microphone capture first
            blockSelf->microphoneCapture_ = [[MicrophoneCapture alloc] init];
            blockSelf->microphoneCapture_.addon = blockSelf;
            blockSelf->microphoneCapture_.callback = ^(const float* data, size_t length) {
                blockSelf->OnMicrophoneAudio(data, length);
            };
            
            if (![blockSelf->microphoneCapture_ start]) {
                NSLog(@"❌ Failed to start microphone capture");
                blockSelf->isCapturing_ = false;
                return;
            }
            
            // Start speaker capture
            Class shareableContentClass = NSClassFromString(@"SCShareableContent");
            if (!shareableContentClass) {
                NSLog(@"❌ SCShareableContent class not found");
                blockSelf->isCapturing_ = false;
                return;
            }
            
            SEL getContentSelector = NSSelectorFromString(@"getShareableContentWithCompletionHandler:");
            if ([shareableContentClass respondsToSelector:getContentSelector]) {
                void (^completionHandler)(SCShareableContent*, NSError*) = [^(SCShareableContent* content, NSError* error) {
                    if (error || !content || content.displays.count == 0) {
                        NSLog(@"❌ Error getting shareable content");
                        blockSelf->isCapturing_ = false;
                        return;
                    }
                    
                    SCDisplay* display = content.displays.firstObject;
                    SCContentFilter* filter = [[SCContentFilter alloc] initWithDisplay:display excludingWindows:@[]];
                    
                    SCStreamConfiguration* config = [[SCStreamConfiguration alloc] init];
                    config.capturesAudio = YES;
                    config.sampleRate = SAMPLE_RATE;
                    config.channelCount = 1;
                    
                    blockSelf->speakerHandler_ = [[AECStreamOutputHandler alloc] init];
                    blockSelf->speakerHandler_.callback = ^(const float* data, size_t length) {
                        blockSelf->OnSpeakerAudio(data, length);
                    };
                    
                    SCStream* stream = [[SCStream alloc] initWithFilter:filter configuration:config delegate:nil];
                    blockSelf->speakerStream_ = stream;
                    
                    NSError* outputError = nil;
                    BOOL added = [stream addStreamOutput:blockSelf->speakerHandler_ type:SCStreamOutputTypeAudio sampleHandlerQueue:nil error:&outputError];
                    
                    if (!added || outputError) {
                        NSLog(@"❌ Error adding stream output");
                        blockSelf->isCapturing_ = false;
                        return;
                    }
                    
                    [stream startCaptureWithCompletionHandler:^(NSError* startError) {
                        if (startError) {
                            NSLog(@"❌ Error starting capture: %@", startError.localizedDescription);
                            blockSelf->isCapturing_ = false;
                        } else {
                            NSLog(@"✅ Audio capture with AEC started");
                            blockSelf->isCapturing_ = true;
                        }
                    }];
                } copy];
                
                NSMethodSignature* sig = [shareableContentClass methodSignatureForSelector:getContentSelector];
                if (sig) {
                    NSInvocation* inv = [NSInvocation invocationWithMethodSignature:sig];
                    [inv setTarget:shareableContentClass];
                    [inv setSelector:getContentSelector];
                    [inv setArgument:&completionHandler atIndex:2];
                    [inv retainArguments];
                    [inv invoke];
                }
            }
        }
    });
}

Napi::Value AudioCaptureWithAEC::Start(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (isCapturing_) {
        return Napi::Boolean::New(env, false);
    }
    
    StartCaptureAsync();
    return Napi::Boolean::New(env, true);
}

Napi::Value AudioCaptureWithAEC::Stop(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!isCapturing_) {
        return env.Undefined();
    }
    
    isCapturing_ = false;
    
    // Stop microphone
    if (microphoneCapture_) {
        [microphoneCapture_ stop];
        microphoneCapture_ = nil;
    }
    
    // Stop speaker
    if (speakerStream_) {
        __block SCStream* streamToStop = speakerStream_;
        __block BOOL stopCompleted = NO;
        
        if ([NSThread isMainThread]) {
            [streamToStop stopCaptureWithCompletionHandler:^(NSError* error) {
                stopCompleted = YES;
            }];
            
            NSDate* timeout = [NSDate dateWithTimeIntervalSinceNow:0.5];
            while (!stopCompleted && [timeout timeIntervalSinceNow] > 0) {
                [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
            }
        } else {
            dispatch_sync(dispatch_get_main_queue(), ^{
                [streamToStop stopCaptureWithCompletionHandler:^(NSError* error) {
                    stopCompleted = YES;
                }];
                
                NSDate* timeout = [NSDate dateWithTimeIntervalSinceNow:0.5];
                while (!stopCompleted && [timeout timeIntervalSinceNow] > 0) {
                    [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
                }
            });
        }
        
        speakerStream_ = nil;
        speakerHandler_ = nil;
    }
    
    // Clear buffers
    speakerBuffer_->Clear();
    microphoneBuffer_->Clear();
    
    // Release callbacks
    if (speakerCallback_) {
        speakerCallback_.Release();
    }
    if (microphoneCallback_) {
        microphoneCallback_.Release();
    }
    
    return env.Undefined();
}

Napi::Value AudioCaptureWithAEC::IsActive(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    return Napi::Boolean::New(env, isCapturing_);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    AudioCaptureWithAEC::Init(env, exports);
    return exports;
}

NODE_API_MODULE(audio_capture_with_aec, Init)
