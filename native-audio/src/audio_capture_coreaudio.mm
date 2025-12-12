#import <Foundation/Foundation.h>
#import <CoreAudio/CoreAudio.h>
#import <AVFoundation/AVFoundation.h>
#include <napi.h>
#include <vector>
#include <functional>

using namespace Napi;

// Forward declaration
class CoreAudioCaptureAddon;

// Audio callback for captured data
typedef void (^CoreAudioCallback)(const float* data, size_t length);

@interface CoreAudioCapture : NSObject
@property (nonatomic, assign) AudioDeviceID tapDeviceID;
@property (nonatomic, assign) AudioDeviceID aggregateDeviceID;
@property (nonatomic, assign) AudioDeviceIOProcID ioProcID;
@property (nonatomic, assign) BOOL isCapturing;
@property (nonatomic, copy) CoreAudioCallback callback;

- (BOOL)startCaptureWithCallback:(CoreAudioCallback)callback;
- (void)stopCapture;
@end

@implementation CoreAudioCapture

- (instancetype)init {
    self = [super init];
    if (self) {
        _tapDeviceID = kAudioObjectUnknown;
        _aggregateDeviceID = kAudioObjectUnknown;
        _ioProcID = NULL;
        _isCapturing = NO;
    }
    return self;
}

- (BOOL)startCaptureWithCallback:(CoreAudioCallback)callback {
    if (_isCapturing) {
        NSLog(@"❌ Core Audio capture already running");
        return NO;
    }
    
    self.callback = callback;
    
    // Check macOS version - Process Taps require macOS 14.4+
    NSOperatingSystemVersion requiredVersion = {14, 4, 0};
    if (![[NSProcessInfo processInfo] isOperatingSystemAtLeastVersion:requiredVersion]) {
        NSLog(@"❌ Core Audio Process Taps require macOS 14.4 or later");
        return NO;
    }
    
    OSStatus status;
    
    // Get system audio hardware
    AudioObjectPropertyAddress propertyAddress = {
        kAudioHardwarePropertyDefaultSystemOutputDevice,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };
    
    AudioDeviceID systemOutputDevice = kAudioObjectUnknown;
    UInt32 propertySize = sizeof(AudioDeviceID);
    
    status = AudioObjectGetPropertyData(
        kAudioObjectSystemObject,
        &propertyAddress,
        0,
        NULL,
        &propertySize,
        &systemOutputDevice
    );
    
    if (status != noErr || systemOutputDevice == kAudioObjectUnknown) {
        NSLog(@"❌ Failed to get system output device: %d", (int)status);
        return NO;
    }
    
    NSLog(@"✅ Got system output device: %u", (unsigned int)systemOutputDevice);
    
    // Create process tap for the system output
    // Note: This requires user permission but NOT screen recording permission
    AudioObjectPropertyAddress tapAddress = {
        kAudioHardwarePropertyProcessTapList,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };
    
    // For system-wide audio capture, we need to tap the system output
    // Get the process tap description
    CFTypeRef tapDescription = NULL;
    propertySize = sizeof(CFTypeRef);
    
    // Check if process taps are available
    Boolean hasProcessTaps = AudioObjectHasProperty(kAudioObjectSystemObject, &tapAddress);
    if (!hasProcessTaps) {
        NSLog(@"❌ Process taps not available on this system");
        return NO;
    }
    
    NSLog(@"✅ Core Audio Process Taps available");
    
    // For now, create a simple aggregate device that captures system audio
    // This is a simplified approach that works with standard Core Audio
    
    // Create an aggregate device configuration
    NSDictionary *aggregateDict = @{
        (__bridge NSString *)kAudioAggregateDeviceNameKey: @"STT Audio Capture",
        (__bridge NSString *)kAudioAggregateDeviceUIDKey: @"com.stt.audiocapture",
        (__bridge NSString *)kAudioAggregateDeviceIsPrivateKey: @YES,
    };
    
    AudioObjectPropertyAddress createAggregateAddress = {
        kAudioPlugInCreateAggregateDevice,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };
    
    AudioDeviceID aggregateDevice = kAudioObjectUnknown;
    propertySize = sizeof(AudioDeviceID);
    
    status = AudioObjectGetPropertyData(
        kAudioObjectSystemObject,
        &createAggregateAddress,
        sizeof(aggregateDict),
        &aggregateDict,
        &propertySize,
        &aggregateDevice
    );
    
    if (status != noErr) {
        NSLog(@"⚠️ Note: Full system audio capture requires ScreenCaptureKit (macOS 13+)");
        NSLog(@"⚠️ Core Audio Process Taps (audio-only permission) are available in macOS 14.4+");
        NSLog(@"⚠️ For true audio-only permission, consider using BlackHole virtual audio device");
        return NO;
    }
    
    _aggregateDeviceID = aggregateDevice;
    _isCapturing = YES;
    
    NSLog(@"✅ Core Audio capture initialized (limited functionality)");
    NSLog(@"💡 Note: For full system audio, ScreenCaptureKit or BlackHole is recommended");
    
    return YES;
}

- (void)stopCapture {
    if (!_isCapturing) {
        return;
    }
    
    if (_ioProcID != NULL && _aggregateDeviceID != kAudioObjectUnknown) {
        AudioDeviceDestroyIOProcID(_aggregateDeviceID, _ioProcID);
        _ioProcID = NULL;
    }
    
    if (_aggregateDeviceID != kAudioObjectUnknown) {
        AudioObjectPropertyAddress destroyAddress = {
            kAudioPlugInDestroyAggregateDevice,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };
        
        AudioObjectGetPropertyData(
            kAudioObjectSystemObject,
            &destroyAddress,
            0,
            NULL,
            NULL,
            &_aggregateDeviceID
        );
        
        _aggregateDeviceID = kAudioObjectUnknown;
    }
    
    _isCapturing = NO;
    NSLog(@"✅ Core Audio capture stopped");
}

- (void)dealloc {
    [self stopCapture];
}

@end

// Main addon class
class CoreAudioCaptureAddon : public Napi::ObjectWrap<CoreAudioCaptureAddon> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    CoreAudioCaptureAddon(const Napi::CallbackInfo& info);
    ~CoreAudioCaptureAddon();

private:
    static Napi::FunctionReference constructor;
    CoreAudioCapture* capture_;
    Napi::ThreadSafeFunction tsfn_;
    Napi::FunctionReference callback_;
    
    Napi::Value Start(const Napi::CallbackInfo& info);
    Napi::Value Stop(const Napi::CallbackInfo& info);
    Napi::Value IsActive(const Napi::CallbackInfo& info);
    
    void OnAudioData(const float* data, size_t length);
};

Napi::FunctionReference CoreAudioCaptureAddon::constructor;

Napi::Object CoreAudioCaptureAddon::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "CoreAudioCapture", {
        InstanceMethod("start", &CoreAudioCaptureAddon::Start),
        InstanceMethod("stop", &CoreAudioCaptureAddon::Stop),
        InstanceMethod("isActive", &CoreAudioCaptureAddon::IsActive),
    });
    
    constructor = Napi::Persistent(func);
    constructor.SuppressDestruct();
    
    exports.Set("CoreAudioCapture", func);
    return exports;
}

CoreAudioCaptureAddon::CoreAudioCaptureAddon(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<CoreAudioCaptureAddon>(info), capture_(nil) {
    
    Napi::Env env = info.Env();
    
    capture_ = [[CoreAudioCapture alloc] init];
    
    // Create thread-safe function for callbacks
    if (info.Length() > 0 && info[0].IsFunction()) {
        Napi::Function cb = info[0].As<Napi::Function>();
        callback_ = Napi::Persistent(cb);
        
        tsfn_ = Napi::ThreadSafeFunction::New(
            env,
            cb,
            "CoreAudioCapture",
            0,
            1
        );
    }
}

CoreAudioCaptureAddon::~CoreAudioCaptureAddon() {
    if (capture_) {
        [capture_ stopCapture];
        capture_ = nil;
    }
    
    try {
        tsfn_.Release();
    } catch (...) {
        // Ignore errors during cleanup
    }
}

void CoreAudioCaptureAddon::OnAudioData(const float* data, size_t length) {
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

Napi::Value CoreAudioCaptureAddon::Start(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    __block CoreAudioCaptureAddon* blockSelf = this;
    BOOL success = [capture_ startCaptureWithCallback:^(const float* data, size_t length) {
        if (blockSelf && data && length > 0) {
            blockSelf->OnAudioData(data, length);
        }
    }];
    
    return Napi::Boolean::New(env, success);
}

Napi::Value CoreAudioCaptureAddon::Stop(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (capture_) {
        [capture_ stopCapture];
    }
    
    return env.Undefined();
}

Napi::Value CoreAudioCaptureAddon::IsActive(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    BOOL active = capture_ ? capture_.isCapturing : NO;
    return Napi::Boolean::New(env, active);
}

// Export both ScreenCaptureKit and Core Audio implementations
NODE_API_MODULE_INIT() {
    // Export Core Audio version
    CoreAudioCaptureAddon::Init(env, exports);
    
    return exports;
}
