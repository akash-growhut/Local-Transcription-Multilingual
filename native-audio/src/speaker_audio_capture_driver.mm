//
// speaker_audio_capture_driver.mm
// Electron native addon that connects to the HAL AudioServerPlugIn via shared memory
//

#import <Foundation/Foundation.h>
#import <CoreAudio/CoreAudio.h>
#import <sys/mman.h>
#import <sys/stat.h>
#import <fcntl.h>
#import <mach/mach.h>
#import <stdatomic.h>
#include <napi.h>
#include <vector>
#include <functional>
#include <thread>
#include <mutex>
#include <atomic>

using namespace Napi;

// Shared memory configuration (must match driver)
#define SHARED_MEMORY_NAME "com.growhut.audiodriver.shm"
#define RING_BUFFER_FRAMES (48000 * 2) // 2 seconds at 48kHz

// Ring buffer structure (must match driver)
typedef struct {
    _Atomic(uint64_t) write_position;
    _Atomic(uint64_t) read_position;
    _Atomic(bool) active;
    UInt32 sample_rate;
    UInt32 channels;
    UInt32 frame_size;
    float buffer[RING_BUFFER_FRAMES * 2]; // Stereo buffer
} AudioRingBuffer;

// Forward declaration
class DriverAudioCaptureAddon;

// Global instance
DriverAudioCaptureAddon* g_captureInstance = nullptr;

class DriverAudioCaptureAddon : public Napi::ObjectWrap<DriverAudioCaptureAddon> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    DriverAudioCaptureAddon(const Napi::CallbackInfo& info);
    ~DriverAudioCaptureAddon();
    
private:
    static Napi::FunctionReference constructor;
    
    AudioRingBuffer* shared_memory_;
    int shm_fd_;
    bool is_capturing_;
    bool read_thread_running_;
    std::thread read_thread_;
    std::mutex read_mutex_;
    
    Napi::ThreadSafeFunction tsfn_;
    Napi::FunctionReference callback_;
    
    Napi::Value Start(const Napi::CallbackInfo& info);
    Napi::Value Stop(const Napi::CallbackInfo& info);
    Napi::Value IsActive(const Napi::CallbackInfo& info);
    Napi::Value CheckDriverAvailable(const Napi::CallbackInfo& info);
    
    void ReadThreadFunc();
    void OnAudioData(const float* data, size_t length);
    bool ConnectToSharedMemory();
    void DisconnectFromSharedMemory();
};

Napi::FunctionReference DriverAudioCaptureAddon::constructor;

Napi::Object DriverAudioCaptureAddon::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "DriverAudioCapture", {
        InstanceMethod("start", &DriverAudioCaptureAddon::Start),
        InstanceMethod("stop", &DriverAudioCaptureAddon::Stop),
        InstanceMethod("isActive", &DriverAudioCaptureAddon::IsActive),
        InstanceMethod("checkDriverAvailable", &DriverAudioCaptureAddon::CheckDriverAvailable),
    });
    
    constructor = Napi::Persistent(func);
    constructor.SuppressDestruct();
    
    exports.Set("DriverAudioCapture", func);
    return exports;
}

DriverAudioCaptureAddon::DriverAudioCaptureAddon(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<DriverAudioCaptureAddon>(info),
      shared_memory_(nullptr),
      shm_fd_(-1),
      is_capturing_(false),
      read_thread_running_(false) {
    
    Napi::Env env = info.Env();
    
    // Create thread-safe function for callbacks
    if (info.Length() > 0 && info[0].IsFunction()) {
        try {
            Napi::Function cb = info[0].As<Napi::Function>();
            callback_ = Napi::Persistent(cb);
            
            tsfn_ = Napi::ThreadSafeFunction::New(
                env,
                cb,
                "DriverAudioCapture",
                0,
                1
            );
        } catch (const Napi::Error& e) {
            NSLog(@"⚠️ Error creating thread-safe function: %s", e.Message().c_str());
        }
    }
    
    g_captureInstance = this;
}

DriverAudioCaptureAddon::~DriverAudioCaptureAddon() {
    NSLog(@"🧹 DriverAudioCaptureAddon destructor called");
    
    Stop(Napi::CallbackInfo(nullptr, {}));
    
    if (g_captureInstance == this) {
        g_captureInstance = nullptr;
    }
    
    if (tsfn_) {
        tsfn_.Release();
    }
    
    NSLog(@"✅ DriverAudioCaptureAddon destructor completed");
}

bool DriverAudioCaptureAddon::ConnectToSharedMemory() {
    // Open existing shared memory
    shm_fd_ = shm_open(SHARED_MEMORY_NAME, O_RDONLY, 0666);
    if (shm_fd_ == -1) {
        NSLog(@"❌ Failed to open shared memory: %s", strerror(errno));
        return false;
    }
    
    // Get shared memory size
    struct stat sb;
    if (fstat(shm_fd_, &sb) == -1) {
        close(shm_fd_);
        shm_fd_ = -1;
        NSLog(@"❌ Failed to stat shared memory");
        return false;
    }
    
    // Map shared memory
    shared_memory_ = (AudioRingBuffer*)mmap(NULL, sb.st_size,
                                            PROT_READ,
                                            MAP_SHARED,
                                            shm_fd_, 0);
    
    if (shared_memory_ == MAP_FAILED) {
        close(shm_fd_);
        shm_fd_ = -1;
        NSLog(@"❌ Failed to map shared memory: %s", strerror(errno));
        return false;
    }
    
    NSLog(@"✅ Connected to shared memory");
    return true;
}

void DriverAudioCaptureAddon::DisconnectFromSharedMemory() {
    if (shared_memory_ && shared_memory_ != MAP_FAILED) {
        munmap(shared_memory_, sizeof(AudioRingBuffer));
        shared_memory_ = nullptr;
    }
    
    if (shm_fd_ != -1) {
        close(shm_fd_);
        shm_fd_ = -1;
    }
}

void DriverAudioCaptureAddon::ReadThreadFunc() {
    NSLog(@"📖 Read thread started");
    
    const size_t read_chunk_frames = 4800; // 100ms at 48kHz
    float read_buffer[read_chunk_frames];
    
    uint64_t last_read_pos = 0;
    
    while (read_thread_running_ && shared_memory_) {
        if (!atomic_load(&shared_memory_->active)) {
            usleep(10000); // 10ms
            continue;
        }
        
        uint64_t write_pos = atomic_load(&shared_memory_->write_position);
        uint64_t read_pos = atomic_load(&shared_memory_->read_position);
        
        // Calculate available frames
        uint64_t available_frames = 0;
        if (write_pos >= read_pos) {
            available_frames = write_pos - read_pos;
        } else {
            // Wraparound case
            available_frames = (RING_BUFFER_FRAMES - read_pos) + write_pos;
        }
        
        if (available_frames < read_chunk_frames) {
            usleep(5000); // 5ms - wait for more data
            continue;
        }
        
        // Read frames
        size_t frames_to_read = read_chunk_frames;
        if (frames_to_read > available_frames) {
            frames_to_read = available_frames;
        }
        
        // Read from ring buffer
        for (size_t i = 0; i < frames_to_read; i++) {
            uint64_t buffer_index = (read_pos + i) % RING_BUFFER_FRAMES;
            read_buffer[i] = shared_memory_->buffer[buffer_index];
        }
        
        // Update read position
        uint64_t new_read_pos = (read_pos + frames_to_read) % RING_BUFFER_FRAMES;
        atomic_store(&shared_memory_->read_position, new_read_pos);
        
        // Send to callback
        if (frames_to_read > 0) {
            OnAudioData(read_buffer, frames_to_read);
        }
        
        last_read_pos = new_read_pos;
    }
    
    NSLog(@"📖 Read thread stopped");
}

void DriverAudioCaptureAddon::OnAudioData(const float* data, size_t length) {
    if (!is_capturing_ || length == 0 || !data) {
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
                // Convert to Buffer for efficient transfer
                Napi::Buffer<float> buffer = Napi::Buffer<float>::Copy(env, audioData.data(), audioData.size());
                jsCallback.Call({buffer});
            } catch (const Napi::Error& e) {
                // Ignore errors during shutdown
            } catch (...) {
                // Ignore other errors
            }
        });
    } catch (...) {
        // Ignore errors
    }
}

Napi::Value DriverAudioCaptureAddon::CheckDriverAvailable(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    // Try to connect to shared memory
    bool connected = ConnectToSharedMemory();
    if (connected) {
        DisconnectFromSharedMemory();
        return Napi::Boolean::New(env, true);
    }
    
    return Napi::Boolean::New(env, false);
}

Napi::Value DriverAudioCaptureAddon::Start(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (is_capturing_) {
        return Napi::Boolean::New(env, false);
    }
    
    // Connect to shared memory
    if (!ConnectToSharedMemory()) {
        return Napi::Boolean::New(env, false);
    }
    
    // Check if driver is active
    if (!atomic_load(&shared_memory_->active)) {
        NSLog(@"⚠️ Driver is not active. Make sure the virtual audio device is set as output.");
        DisconnectFromSharedMemory();
        return Napi::Boolean::New(env, false);
    }
    
    is_capturing_ = true;
    read_thread_running_ = true;
    
    // Start read thread
    read_thread_ = std::thread(&DriverAudioCaptureAddon::ReadThreadFunc, this);
    
    NSLog(@"✅ Driver audio capture started");
    return Napi::Boolean::New(env, true);
}

Napi::Value DriverAudioCaptureAddon::Stop(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!is_capturing_) {
        return env.Undefined();
    }
    
    NSLog(@"🛑 Stopping driver audio capture...");
    
    is_capturing_ = false;
    read_thread_running_ = false;
    
    // Wait for read thread to finish
    if (read_thread_.joinable()) {
        read_thread_.join();
    }
    
    DisconnectFromSharedMemory();
    
    NSLog(@"✅ Driver audio capture stopped");
    return env.Undefined();
}

Napi::Value DriverAudioCaptureAddon::IsActive(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    return Napi::Boolean::New(env, is_capturing_);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    DriverAudioCaptureAddon::Init(env, exports);
    return exports;
}

NODE_API_MODULE(driver_audio_capture, Init)

