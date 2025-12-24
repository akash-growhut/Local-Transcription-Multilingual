#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreAudio/CoreAudio.h>
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <objc/message.h>
#include <napi.h>
#include <vector>
#include <functional>
#include <string>
#include <unordered_map>
#include <atomic>
#include <algorithm>
#include <tuple>
#include <unistd.h>
#include <cctype>

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
    NSLog(@"🧹 Destructor called, cleaning up...");
    
    // Clear global instance pointer if it points to us
    if (g_captureInstance == this) {
        g_captureInstance = nullptr;
    }
    
    // Stop capture synchronously
    if (isCapturing_ && stream_) {
        isCapturing_ = false;
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
    // Check if we're still capturing
    if (!isCapturing_) {
        return;
    }
    
    if (length == 0 || !data) {
        return;
    }
    
    // Copy data for thread safety
    std::vector<float> audioData(data, data + length);
    
    try {
        // Check if thread-safe function is valid before calling
        if (!tsfn_) {
            return;
        }
        
        tsfn_.NonBlockingCall([audioData](Napi::Env env, Napi::Function jsCallback) {
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
        // Don't log here as it's expected during shutdown
    } catch (const std::exception& e) {
        // Don't log here as it's expected during shutdown
    } catch (...) {
        // Ignore other errors
    }
}

void AudioCaptureAddon::StartCaptureAsync() {
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
    
    // Start native ScreenCaptureKit capture
    StartCaptureAsync();
    
    // Return true - we're attempting native capture
    // The actual success will be determined asynchronously
    return Napi::Boolean::New(env, true);
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
    
    if (stream_) {
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

// Known apps with confidence scores
static std::unordered_map<std::string, double> knownApps = {
    {"us.zoom.xos", 0.9},
    {"com.microsoft.teams", 0.9},
    {"com.google.Chrome", 0.8},  // Increased Chrome score
    {"com.apple.Safari", 0.7},
    {"com.whatsapp", 0.8},
    {"com.skype.skype", 0.8},
    {"com.slack.Slack", 0.7},
    {"com.apple.FaceTime", 0.9},
    {"com.discord", 0.8},
    {"com.webex.meeting", 0.8},
    {"com.loom.desktop", 0.7},
    {"com.notion.Notion", 0.4},
    {"com.electron", 0.1}  // Lowered Electron score - we'll filter it out anyway
};

// Check if microphone device is running
static bool queryMicRunning(AudioObjectID dev) {
    UInt32 val = 0;
    UInt32 sz = sizeof(val);
    AudioObjectPropertyAddress addr = {
        kAudioDevicePropertyDeviceIsRunningSomewhere,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };
    return (AudioObjectGetPropertyData(dev, &addr, 0, nullptr, &sz, &val) == noErr && val);
}

// Get dynamic candidates with scoring
static std::vector<std::tuple<std::string, std::string, double>> dynamicMicCandidates() {
    std::vector<std::tuple<std::string, std::string, double>> candidates;
    NSArray<NSRunningApplication *> *apps = [[NSWorkspace sharedWorkspace] runningApplications];
    
    // Get current process PID to exclude it
    pid_t currentPID = getpid();

    for (NSRunningApplication *app in apps) {
        if (app.activationPolicy == NSApplicationActivationPolicyProhibited) continue;
        
        // Skip the current Electron app process
        if (app.processIdentifier == currentPID) {
            continue;
        }
        
        NSString *bid = app.bundleIdentifier;
        if (!bid) continue;
        
        // Also skip Electron apps by bundle ID
        std::string bundleIdStr = [bid UTF8String];
        if (bundleIdStr.find("electron") != std::string::npos || 
            bundleIdStr.find("com.electron") != std::string::npos) {
            continue;
        }
        
        NSString *name = app.localizedName ?: bid;
        std::string nameStr = [name UTF8String];
        
        // Skip if name contains "Electron" (case insensitive check)
        NSString *nameLower = [name lowercaseString];
        if ([nameLower containsString:@"electron"]) {
            continue;
        }
        
        double score = knownApps.count(bundleIdStr) ? knownApps[bundleIdStr] : 0.1;
        
        // Boost Chrome detection
        if (bundleIdStr == "com.google.Chrome" || nameStr.find("Chrome") != std::string::npos) {
            score = std::max(score, 0.8);
        }

        // Check window titles for meeting-related keywords
        AXUIElementRef appElem = AXUIElementCreateApplication(app.processIdentifier);
        CFTypeRef value;
        if (AXUIElementCopyAttributeValue(appElem, kAXWindowsAttribute, &value) == kAXErrorSuccess) {
            NSArray *wins = (__bridge NSArray *)value;
            for (id win in wins) {
                CFTypeRef titleRef;
                if (AXUIElementCopyAttributeValue((AXUIElementRef)win, kAXTitleAttribute, &titleRef) == kAXErrorSuccess) {
                    NSString *title = (__bridge NSString *)titleRef;
                    NSString *lower = [title lowercaseString];
                    if ([lower containsString:@"meeting"] ||
                        [lower containsString:@"call"] ||
                        [lower containsString:@"recording"] ||
                        [lower containsString:@"voice"] ||
                        [lower containsString:@"conference"] ||
                        [lower containsString:@"audio"] ||
                        [lower containsString:@"video"] ||
                        [lower containsString:@"google meet"] ||
                        [lower containsString:@"zoom"] ||
                        [lower containsString:@"teams"]) {
                        score += 0.4;
                        CFRelease(titleRef);
                        break;
                    }
                    CFRelease(titleRef);
                }
            }
            CFRelease(value);
        }
        CFRelease(appElem);

        // Only boost active app if it's already a known audio app
        // This prevents random apps from getting high scores just because they're active
        if (app.isActive && knownApps.count(bundleIdStr) > 0) {
            score += 0.15;  // Reduced from 0.2 to make it less impactful
        }
        if (score > 1.0) score = 1.0;

        candidates.push_back({[name UTF8String], bundleIdStr, score});
    }

    std::sort(candidates.begin(), candidates.end(),
              [](auto &a, auto &b) { return std::get<2>(a) > std::get<2>(b); });
    return candidates;
}

// Microphone monitor class to continuously track which app is using the mic
class MicrophoneMonitor {
public:
    static MicrophoneMonitor* sharedInstance() {
        static MicrophoneMonitor* instance = nullptr;
        if (!instance) {
            instance = new MicrophoneMonitor();
        }
        return instance;
    }
    
    void startMonitoring(Napi::ThreadSafeFunction callback, Napi::Env env) {
        if (isMonitoring_) {
            return; // Already monitoring
        }
        
        isMonitoring_ = true;
        callback_ = callback;
        anyActive_ = false;
        lastReportedApp_.clear();
        
        // Get all input audio devices
        UInt32 sz = 0;
        AudioObjectPropertyAddress addr = {
            kAudioHardwarePropertyDevices,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };
        AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &addr, 0, nullptr, &sz);
        int n = sz / sizeof(AudioObjectID);
        std::vector<AudioObjectID> ids(n);
        AudioObjectGetPropertyData(kAudioObjectSystemObject, &addr, 0, nullptr, &sz, ids.data());

        micStates_.clear();
        for (auto id : ids) {
            // Only input devices
            UInt32 streamSize = 0;
            AudioObjectPropertyAddress saddr = {
                kAudioDevicePropertyStreams,
                kAudioDevicePropertyScopeInput,
                kAudioObjectPropertyElementMain
            };
            if (AudioObjectGetPropertyDataSize(id, &saddr, 0, nullptr, &streamSize) == noErr && streamSize > 0) {
                micStates_[id] = queryMicRunning(id);
            }
        }
        
        // Start monitoring on a background thread
        MicrophoneMonitor* self = this;
        dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
            self->monitorLoop();
        });
    }
    
    void stopMonitoring() {
        isMonitoring_ = false;
        if (callback_) {
            callback_.Release();
            callback_ = Napi::ThreadSafeFunction();
        }
        micStates_.clear();
    }
    
private:
    bool isMonitoring_ = false;
    Napi::ThreadSafeFunction callback_;
    std::unordered_map<AudioObjectID, bool> micStates_;
    std::atomic<bool> anyActive_{false};
    std::string lastReportedApp_;
    
    void monitorLoop() {
        while (isMonitoring_) {
            @autoreleasepool {
                bool anyNow = false;
                for (auto &p : micStates_) {
                    bool running = queryMicRunning(p.first);
                    p.second = running;
                    anyNow |= running;
                }
                
                // Check if state changed
                bool prev = anyActive_.exchange(anyNow);
                
                if (anyNow) {
                    // Microphone is active - detect app
                    auto candidates = dynamicMicCandidates();
                    if (!candidates.empty()) {
                        auto [name, bid, score] = candidates.front();
                        std::string appNameStr = name;
                        
                        // Report only when mic becomes active (not if it was already active)
                        bool shouldReport = false;
                        if (!prev) {
                            // Mic just became active - report the app
                            shouldReport = true;
                            NSLog(@"🎤 Microphone opened - detected app: %s (confidence: %.2f)", appNameStr.c_str(), score);
                        }
                        
                        if (shouldReport && callback_) {
                            lastReportedApp_ = appNameStr;
                            callback_.NonBlockingCall([appNameStr](Napi::Env env, Napi::Function jsCallback) {
                                if (!jsCallback.IsEmpty() && !jsCallback.IsUndefined()) {
                                    jsCallback.Call({Napi::String::New(env, appNameStr)});
                                }
                            });
                            NSLog(@"🎤 App using microphone: %s", appNameStr.c_str());
                        }
                    }
                } else if (prev && !anyNow) {
                    // Microphone just became inactive
                    lastReportedApp_.clear();
                    NSLog(@"🎤 Microphone became inactive");
                }
            }
            
            // Check every 1 second
            usleep(1000000);
        }
    }
    
    void evaluate() {
        bool nowAny = false;
        for (auto &p : micStates_) {
            if (p.second) {
                nowAny = true;
                break;
            }
        }
        anyActive_.store(nowAny);
    }
};

// Function to get app name using microphone
Napi::Value GetMicrophoneAppName(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    @autoreleasepool {
        // Check if any microphone is active
        UInt32 sz = 0;
        AudioObjectPropertyAddress addr = {
            kAudioHardwarePropertyDevices,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };
        AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &addr, 0, nullptr, &sz);
        int n = sz / sizeof(AudioObjectID);
        std::vector<AudioObjectID> ids(n);
        AudioObjectGetPropertyData(kAudioObjectSystemObject, &addr, 0, nullptr, &sz, ids.data());

        bool micActive = false;
        for (auto id : ids) {
            UInt32 streamSize = 0;
            AudioObjectPropertyAddress saddr = {
                kAudioDevicePropertyStreams,
                kAudioDevicePropertyScopeInput,
                kAudioObjectPropertyElementMain
            };
            if (AudioObjectGetPropertyDataSize(id, &saddr, 0, nullptr, &streamSize) == noErr && streamSize > 0) {
                if (queryMicRunning(id)) {
                    micActive = true;
                    break;
                }
            }
        }
        
        if (micActive) {
            auto candidates = dynamicMicCandidates();
            if (!candidates.empty()) {
                auto [name, bid, score] = candidates.front();
                NSLog(@"🎤 App using microphone detected: %s (confidence: %.2f)", name.c_str(), score);
                return Napi::String::New(env, name);
            }
        }
        
        NSLog(@"🎤 Could not detect app using microphone");
        return Napi::String::New(env, "Unknown");
    }
}

// Function to start monitoring microphone usage
Napi::Value StartMicrophoneMonitoring(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (info.Length() < 1 || !info[0].IsFunction()) {
        Napi::TypeError::New(env, "Expected callback function as argument")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    
    Napi::Function callback = info[0].As<Napi::Function>();
    Napi::ThreadSafeFunction tsfn = Napi::ThreadSafeFunction::New(
        env,
        callback,
        "MicrophoneMonitor",
        0,
        1
    );
    
    MicrophoneMonitor::sharedInstance()->startMonitoring(tsfn, env);
    
    NSLog(@"🎤 Started continuous microphone monitoring");
    return env.Undefined();
}

// Function to stop monitoring microphone usage
Napi::Value StopMicrophoneMonitoring(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    MicrophoneMonitor::sharedInstance()->stopMonitoring();
    
    NSLog(@"🎤 Stopped microphone monitoring");
    return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    AudioCaptureAddon::Init(env, exports);
    
    // Export the function to get microphone app name
    exports.Set("getMicrophoneAppName", Napi::Function::New(env, GetMicrophoneAppName));
    
    // Export functions to start/stop continuous monitoring
    exports.Set("startMicrophoneMonitoring", Napi::Function::New(env, StartMicrophoneMonitoring));
    exports.Set("stopMicrophoneMonitoring", Napi::Function::New(env, StopMicrophoneMonitoring));
    
    return exports;
}

NODE_API_MODULE(audio_capture, Init)
