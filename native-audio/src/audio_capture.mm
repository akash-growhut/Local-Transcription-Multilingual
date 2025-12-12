#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <CoreAudio/CoreAudio.h>
#import <AVFoundation/AVFoundation.h>
#import <libproc.h>
#include <napi.h>
#include <vector>
#include <map>
#include <set>
#include <functional>
#include <signal.h>

// Private API declarations for macOS 14.4+ Process Taps
extern "C" {
    typedef struct {
        CFArrayRef processes;
    } CATapDescription;
    
    extern OSStatus AudioHardwareCreateProcessTap(
        AudioObjectID inProcessObject,
        const CATapDescription* inTapDescription,
        AudioDeviceID* outTapDeviceID
    );
    
    extern OSStatus AudioHardwareDestroyProcessTap(AudioDeviceID inTapDeviceID);
}

using namespace Napi;

// Forward declaration
class AudioCaptureAddon;

// Structure to track individual process taps
struct ProcessTap {
    AudioObjectID processObjectID;
    AudioDeviceID tapDeviceID;
    AudioDeviceID aggregateDeviceID;
    AudioDeviceIOProcID ioProcID;
    pid_t pid;
    bool isActive;
};

// Main addon class
class AudioCaptureAddon : public Napi::ObjectWrap<AudioCaptureAddon> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    AudioCaptureAddon(const Napi::CallbackInfo& info);
    ~AudioCaptureAddon();

private:
    static Napi::FunctionReference constructor;
    
    // Multi-tap management
    std::map<pid_t, ProcessTap> activeTaps_;
    dispatch_source_t monitorTimer_;
    bool isCapturing_;
    
    Napi::ThreadSafeFunction tsfn_;
    Napi::FunctionReference callback_;
    
    Napi::Value Start(const Napi::CallbackInfo& info);
    Napi::Value Stop(const Napi::CallbackInfo& info);
    Napi::Value IsActive(const Napi::CallbackInfo& info);
    
    void OnAudioData(const float* data, size_t length);
    bool StartCoreAudioCapture();
    void StopCoreAudioCapture();
    
    // Process discovery and tap management
    std::set<pid_t> DiscoverAudioProducingProcesses();
    bool CreateTapForProcess(AudioObjectID processObjectID, pid_t pid);
    void RemoveTapForProcess(pid_t pid);
    void MonitorAndUpdateTaps();
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
      monitorTimer_(nullptr),
      isCapturing_(false) {
    
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
    StopCoreAudioCapture();
    
    try {
        tsfn_.Release();
    } catch (...) {
        // Ignore errors during cleanup
    }
}

void AudioCaptureAddon::OnAudioData(const float* data, size_t length) {
    if (length == 0 || !data || !isCapturing_) {
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
                // Ignore errors in callback
            }
        });
    } catch (...) {
        // Ignore errors
    }
}

std::set<pid_t> AudioCaptureAddon::DiscoverAudioProducingProcesses() {
    std::set<pid_t> audioPIDs;
    
    // Get all running applications (user apps only, not system daemons)
    NSArray<NSRunningApplication*>* runningApps = [[NSWorkspace sharedWorkspace] runningApplications];
    
    AudioObjectPropertyAddress translateAddress = {
        kAudioHardwarePropertyTranslatePIDToProcessObject,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };
    
    // For each running app, try to translate its PID to an audio process object
    // Only apps that successfully translate have audio capability
    for (NSRunningApplication* app in runningApps) {
        pid_t pid = [app processIdentifier];
        
        if (pid <= 0) {
            continue;
        }
        
        // Filter: Only regular user applications
        // Skip background agents, UI elements, and system processes
        if (app.activationPolicy != NSApplicationActivationPolicyRegular) {
            continue;
        }
        
        AudioObjectID processObject = kAudioObjectUnknown;
        UInt32 dataSize = sizeof(AudioObjectID);
        
        OSStatus status = AudioObjectGetPropertyData(
            kAudioObjectSystemObject,
            &translateAddress,
            sizeof(pid_t),
            &pid,
            &dataSize,
            &processObject
        );
        
        // If translation succeeds AND we get a valid object, this process has audio
        if (status == noErr && processObject != kAudioObjectUnknown && processObject != 0) {
            NSLog(@"🎵 Found audio-capable app: %@ (PID %d, object %u)", 
                  app.localizedName ?: @"Unknown", pid, (unsigned int)processObject);
            audioPIDs.insert(pid);
        }
    }
    
    return audioPIDs;
}

bool AudioCaptureAddon::CreateTapForProcess(AudioObjectID processObjectID, pid_t pid) {
    NSLog(@"🔌 Creating tap for PID %d (object %u)", pid, (unsigned int)processObjectID);
    
    // Validate process object
    if (processObjectID == kAudioObjectUnknown || processObjectID == 0) {
        NSLog(@"❌ Invalid process object ID: %u", (unsigned int)processObjectID);
        return false;
    }
    
    ProcessTap tap = {};
    tap.processObjectID = processObjectID;
    tap.pid = pid;
    tap.isActive = false;
    
    OSStatus status;
    
    @try {
        // Step 1: Create tap description
        CATapDescription tapDescription = {};
        tapDescription.processes = CFArrayCreate(
            kCFAllocatorDefault,
            (const void**)&processObjectID,
            1,
            NULL
        );
        
        if (!tapDescription.processes) {
            NSLog(@"❌ Failed to create tap description for PID %d", pid);
            return false;
        }
        
        NSLog(@"   ✓ Created tap description");
        
        // Step 2: Create process tap (this might crash if permission denied)
        NSLog(@"   → Calling AudioHardwareCreateProcessTap...");
        
        status = AudioHardwareCreateProcessTap(
            processObjectID,
            &tapDescription,
            &tap.tapDeviceID
        );
        
        CFRelease(tapDescription.processes);
        
        NSLog(@"   ← AudioHardwareCreateProcessTap returned: %d", (int)status);
        
        if (status != noErr) {
            if (status == kAudioHardwareIllegalOperationError) {
                NSLog(@"⚠️ Permission denied for PID %d - need Microphone permission", pid);
                NSLog(@"   Grant permission in: System Settings → Privacy & Security → Microphone");
            } else {
                NSLog(@"❌ Failed to create tap for PID %d: OSStatus %d", pid, (int)status);
            }
            return false;
        }
        
        if (tap.tapDeviceID == kAudioObjectUnknown || tap.tapDeviceID == 0) {
            NSLog(@"❌ Got invalid tap device ID for PID %d", pid);
            return false;
        }
        
        NSLog(@"   ✓ Created tap device ID: %u", (unsigned int)tap.tapDeviceID);
        
        // Step 3: Get tap UID
        AudioObjectPropertyAddress propertyAddress = {
            kAudioTapPropertyUID,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };
        
        CFStringRef tapUID = NULL;
        UInt32 propertySize = sizeof(CFStringRef);
        
        status = AudioObjectGetPropertyData(
            tap.tapDeviceID,
            &propertyAddress,
            0,
            NULL,
            &propertySize,
            &tapUID
        );
        
        if (status != noErr || !tapUID) {
            NSLog(@"❌ Failed to get tap UID for PID %d: OSStatus %d", pid, (int)status);
            AudioHardwareDestroyProcessTap(tap.tapDeviceID);
            return false;
        }
        
        NSLog(@"   ✓ Got tap UID: %@", (__bridge NSString*)tapUID);
        
        // Step 4: Create aggregate device
        NSString* uniqueUID = [NSString stringWithFormat:@"com.stt.tap.%d.%u", pid, (unsigned int)[[NSDate date] timeIntervalSince1970]];
        NSDictionary* aggregateDict = @{
            @"name": [NSString stringWithFormat:@"STT Tap %d", pid],
            @"uid": uniqueUID,
            @"private": @YES,
            @"taps": @[@{@"uid": (__bridge NSString*)tapUID}]
        };
        
        CFRelease(tapUID);
        
        propertyAddress.mSelector = kAudioPlugInCreateAggregateDevice;
        propertySize = sizeof(AudioDeviceID);
        
        status = AudioObjectGetPropertyData(
            kAudioObjectSystemObject,
            &propertyAddress,
            sizeof(aggregateDict),
            (__bridge CFDictionaryRef)aggregateDict,
            &propertySize,
            &tap.aggregateDeviceID
        );
        
        if (status != noErr || tap.aggregateDeviceID == kAudioObjectUnknown) {
            NSLog(@"❌ Failed to create aggregate device for PID %d: OSStatus %d", pid, (int)status);
            AudioHardwareDestroyProcessTap(tap.tapDeviceID);
            return false;
        }
        
        NSLog(@"   ✓ Created aggregate device ID: %u", (unsigned int)tap.aggregateDeviceID);
        
        // Step 5: Create IO callback
        __block AudioCaptureAddon* blockSelf = this;
        
        status = AudioDeviceCreateIOProcIDWithBlock(
            &tap.ioProcID,
            tap.aggregateDeviceID,
            dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_HIGH, 0),
            ^(const AudioTimeStamp* inNow,
              const AudioBufferList* inInputData,
              const AudioTimeStamp* inInputTime,
              AudioBufferList* outOutputData,
              const AudioTimeStamp* inOutputTime) {
                
                if (!inInputData || !blockSelf || !blockSelf->isCapturing_) {
                    return;
                }
                
                for (UInt32 i = 0; i < inInputData->mNumberBuffers; i++) {
                    const AudioBuffer& buffer = inInputData->mBuffers[i];
                    if (!buffer.mData || buffer.mDataByteSize == 0) {
                        continue;
                    }
                    
                    const float* floatData = (const float*)buffer.mData;
                    size_t numSamples = buffer.mDataByteSize / sizeof(float);
                    
                    if (floatData && numSamples > 0) {
                        blockSelf->OnAudioData(floatData, numSamples);
                    }
                }
            }
        );
        
        if (status != noErr) {
            NSLog(@"❌ Failed to create IO proc for PID %d: OSStatus %d", pid, (int)status);
            AudioHardwareDestroyProcessTap(tap.tapDeviceID);
            return false;
        }
        
        NSLog(@"   ✓ Created IO proc");
        
        // Step 6: Start audio device
        status = AudioDeviceStart(tap.aggregateDeviceID, tap.ioProcID);
        if (status != noErr) {
            NSLog(@"❌ Failed to start device for PID %d: OSStatus %d", pid, (int)status);
            AudioDeviceDestroyIOProcID(tap.aggregateDeviceID, tap.ioProcID);
            AudioHardwareDestroyProcessTap(tap.tapDeviceID);
            return false;
        }
        
        NSLog(@"   ✓ Started audio device");
        
        tap.isActive = true;
        activeTaps_[pid] = tap;
        
        NSLog(@"✅ Tap created for PID %d", pid);
        return true;
        
    } @catch (NSException *exception) {
        NSLog(@"❌ Exception creating tap for PID %d: %@", pid, exception);
        return false;
    }
}

void AudioCaptureAddon::RemoveTapForProcess(pid_t pid) {
    auto it = activeTaps_.find(pid);
    if (it == activeTaps_.end()) {
        return;
    }
    
    ProcessTap& tap = it->second;
    
    if (tap.aggregateDeviceID != kAudioObjectUnknown && tap.ioProcID != NULL) {
        AudioDeviceStop(tap.aggregateDeviceID, tap.ioProcID);
        AudioDeviceDestroyIOProcID(tap.aggregateDeviceID, tap.ioProcID);
    }
    
    if (tap.aggregateDeviceID != kAudioObjectUnknown) {
        AudioObjectPropertyAddress propertyAddress = {
            kAudioPlugInDestroyAggregateDevice,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };
        
        UInt32 propertySize = sizeof(AudioDeviceID);
        AudioObjectGetPropertyData(
            kAudioObjectSystemObject,
            &propertyAddress,
            0,
            NULL,
            &propertySize,
            &tap.aggregateDeviceID
        );
    }
    
    if (tap.tapDeviceID != kAudioObjectUnknown) {
        AudioHardwareDestroyProcessTap(tap.tapDeviceID);
    }
    
    activeTaps_.erase(it);
    NSLog(@"🗑️ Removed tap for PID %d", pid);
}

void AudioCaptureAddon::MonitorAndUpdateTaps() {
    if (!isCapturing_) {
        return;
    }
    
    // Discover current audio-producing processes
    std::set<pid_t> currentPIDs = DiscoverAudioProducingProcesses();
    
    // Find PIDs that need new taps
    std::set<pid_t> newPIDs;
    for (pid_t pid : currentPIDs) {
        if (activeTaps_.find(pid) == activeTaps_.end()) {
            newPIDs.insert(pid);
        }
    }
    
    // Find PIDs that need tap removal (process died)
    std::set<pid_t> deadPIDs;
    for (const auto& pair : activeTaps_) {
        if (currentPIDs.find(pair.first) == currentPIDs.end()) {
            deadPIDs.insert(pair.first);
        }
    }
    
    // Create new taps - translate PIDs to process objects first
    if (!newPIDs.empty()) {
        NSLog(@"🔍 Found %zu new audio-producing process(es)", newPIDs.size());
        
        AudioObjectPropertyAddress translateAddress = {
            kAudioHardwarePropertyTranslatePIDToProcessObject,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };
        
        for (pid_t pid : newPIDs) {
            // Translate PID to process object
            AudioObjectID processObject = kAudioObjectUnknown;
            UInt32 dataSize = sizeof(AudioObjectID);
            
            OSStatus status = AudioObjectGetPropertyData(
                kAudioObjectSystemObject,
                &translateAddress,
                sizeof(pid_t),
                &pid,
                &dataSize,
                &processObject
            );
            
            if (status == noErr && processObject != kAudioObjectUnknown && processObject != 0) {
                CreateTapForProcess(processObject, pid);
            } else {
                NSLog(@"⚠️ Failed to translate PID %d to process object (OSStatus %d)", pid, (int)status);
            }
        }
    }
    
    // Remove dead taps
    for (pid_t pid : deadPIDs) {
        RemoveTapForProcess(pid);
    }
    
    if (!newPIDs.empty() || !deadPIDs.empty()) {
        NSLog(@"📊 Active taps: %zu process(es)", activeTaps_.size());
    }
}

bool AudioCaptureAddon::StartCoreAudioCapture() {
    NSLog(@"🎤 Starting CoreAudio multi-process tap (macOS 14.4+)");
    NSLog(@"ℹ️  Using per-process taps - requires AUDIO RECORDING permission");
    
    // Initial discovery and tap creation
    MonitorAndUpdateTaps();
    
    if (activeTaps_.empty()) {
        NSLog(@"⚠️ No audio-producing processes found");
        NSLog(@"   Play some audio and it will be captured automatically");
    }
    
    // Set up monitoring timer (poll every 1000ms)
    __block AudioCaptureAddon* blockSelf = this;
    monitorTimer_ = dispatch_source_create(
        DISPATCH_SOURCE_TYPE_TIMER,
        0,
        0,
        dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0)
    );
    
    if (!monitorTimer_) {
        NSLog(@"❌ Failed to create monitor timer");
        StopCoreAudioCapture();
        return false;
    }
    
    dispatch_source_set_timer(
        monitorTimer_,
        dispatch_time(DISPATCH_TIME_NOW, 1 * NSEC_PER_SEC),
        1 * NSEC_PER_SEC,  // 1 second interval
        100 * NSEC_PER_MSEC  // 100ms leeway
    );
    
    dispatch_source_set_event_handler(monitorTimer_, ^{
        if (blockSelf) {
            blockSelf->MonitorAndUpdateTaps();
        }
    });
    
    dispatch_resume(monitorTimer_);
    
    NSLog(@"✅ Multi-process tap monitoring started");
    NSLog(@"🔄 Monitoring for new/dead audio processes every 1s");
    
    return true;
}

void AudioCaptureAddon::StopCoreAudioCapture() {
    // Stop monitoring
    if (monitorTimer_) {
        dispatch_source_cancel(monitorTimer_);
        monitorTimer_ = nullptr;
    }
    
    // Remove all taps
    std::vector<pid_t> pidsToRemove;
    for (const auto& pair : activeTaps_) {
        pidsToRemove.push_back(pair.first);
    }
    
    for (pid_t pid : pidsToRemove) {
        RemoveTapForProcess(pid);
    }
    
    activeTaps_.clear();
    isCapturing_ = false;
    
    NSLog(@"✅ Multi-process tap capture stopped");
}

Napi::Value AudioCaptureAddon::Start(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (isCapturing_) {
        return Napi::Boolean::New(env, false);
    }
    
    // Check macOS version
    NSOperatingSystemVersion requiredVersion = {14, 4, 0};
    if (![[NSProcessInfo processInfo] isOperatingSystemAtLeastVersion:requiredVersion]) {
        NSLog(@"❌ CoreAudio Process Taps require macOS 14.4+");
        return Napi::Boolean::New(env, false);
    }
    
    isCapturing_ = true;
    bool success = StartCoreAudioCapture();
    
    if (!success) {
        isCapturing_ = false;
    }
    
    return Napi::Boolean::New(env, success);
}

Napi::Value AudioCaptureAddon::Stop(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (isCapturing_) {
        StopCoreAudioCapture();
    }
    
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
