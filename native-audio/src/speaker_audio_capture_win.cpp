#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <functiondiscoverykeys_devpkey.h>
#include <napi.h>
#include <vector>
#include <thread>
#include <atomic>
#include <iostream>

// Link required COM libraries
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")

using namespace Napi;

// RAII helper for COM initialization
class COMInitializer {
public:
    COMInitializer() {
        HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
        if (FAILED(hr)) {
            std::cerr << "Failed to initialize COM: " << std::hex << hr << std::endl;
        }
        initialized_ = SUCCEEDED(hr);
    }
    
    ~COMInitializer() {
        if (initialized_) {
            CoUninitialize();
        }
    }
    
    bool IsInitialized() const { return initialized_; }
    
private:
    bool initialized_;
};

// Forward declaration
class AudioCaptureAddon;

// Main addon class
class AudioCaptureAddon : public Napi::ObjectWrap<AudioCaptureAddon> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    AudioCaptureAddon(const Napi::CallbackInfo& info);
    ~AudioCaptureAddon();

private:
    static Napi::FunctionReference constructor;
    
    std::atomic<bool> isCapturing_;
    std::thread captureThread_;
    Napi::ThreadSafeFunction tsfn_;
    Napi::FunctionReference callback_;
    
    // COM objects
    IMMDeviceEnumerator* pEnumerator_;
    IMMDevice* pDevice_;
    IAudioClient* pAudioClient_;
    IAudioCaptureClient* pCaptureClient_;
    
    Napi::Value Start(const Napi::CallbackInfo& info);
    Napi::Value Stop(const Napi::CallbackInfo& info);
    Napi::Value IsActive(const Napi::CallbackInfo& info);
    
    void CaptureThreadFunc();
    void CleanupCOM();
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
      isCapturing_(false),
      pEnumerator_(nullptr),
      pDevice_(nullptr),
      pAudioClient_(nullptr),
      pCaptureClient_(nullptr) {
    
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
            std::cerr << "Error creating thread-safe function: " << e.Message() << std::endl;
        } catch (...) {
            std::cerr << "Unknown error creating thread-safe function" << std::endl;
        }
    }
}

AudioCaptureAddon::~AudioCaptureAddon() {
    std::cout << "Destructor called, cleaning up..." << std::endl;
    
    // Stop capture if running
    if (isCapturing_) {
        isCapturing_ = false;
        if (captureThread_.joinable()) {
            captureThread_.join();
        }
    }
    
    CleanupCOM();
    
    // Release thread-safe function
    try {
        if (tsfn_) {
            tsfn_.Release();
        }
    } catch (...) {
        std::cerr << "Error releasing thread-safe function in destructor" << std::endl;
    }
    
    std::cout << "Destructor completed" << std::endl;
}

void AudioCaptureAddon::CleanupCOM() {
    if (pCaptureClient_) {
        pCaptureClient_->Release();
        pCaptureClient_ = nullptr;
    }
    if (pAudioClient_) {
        pAudioClient_->Release();
        pAudioClient_ = nullptr;
    }
    if (pDevice_) {
        pDevice_->Release();
        pDevice_ = nullptr;
    }
    if (pEnumerator_) {
        pEnumerator_->Release();
        pEnumerator_ = nullptr;
    }
}

void AudioCaptureAddon::CaptureThreadFunc() {
    // Initialize COM for this thread
    COMInitializer comInit;
    if (!comInit.IsInitialized()) {
        std::cerr << "Failed to initialize COM in capture thread" << std::endl;
        isCapturing_ = false;
        return;
    }
    
    HRESULT hr;
    
    // Create device enumerator
    hr = CoCreateInstance(
        __uuidof(MMDeviceEnumerator),
        NULL,
        CLSCTX_ALL,
        __uuidof(IMMDeviceEnumerator),
        (void**)&pEnumerator_
    );
    
    if (FAILED(hr)) {
        std::cerr << "Failed to create device enumerator: " << std::hex << hr << std::endl;
        isCapturing_ = false;
        return;
    }
    
    // Get default audio endpoint (speakers/headphones for loopback)
    hr = pEnumerator_->GetDefaultAudioEndpoint(
        eRender,  // Use render endpoint for loopback recording
        eConsole,
        &pDevice_
    );
    
    if (FAILED(hr)) {
        std::cerr << "Failed to get default audio endpoint: " << std::hex << hr << std::endl;
        CleanupCOM();
        isCapturing_ = false;
        return;
    }
    
    // Activate audio client
    hr = pDevice_->Activate(
        __uuidof(IAudioClient),
        CLSCTX_ALL,
        NULL,
        (void**)&pAudioClient_
    );
    
    if (FAILED(hr)) {
        std::cerr << "Failed to activate audio client: " << std::hex << hr << std::endl;
        CleanupCOM();
        isCapturing_ = false;
        return;
    }
    
    // Get the mix format
    WAVEFORMATEX* pwfx = NULL;
    hr = pAudioClient_->GetMixFormat(&pwfx);
    
    if (FAILED(hr)) {
        std::cerr << "Failed to get mix format: " << std::hex << hr << std::endl;
        CleanupCOM();
        isCapturing_ = false;
        return;
    }
    
    std::cout << "Audio format: sampleRate=" << pwfx->nSamplesPerSec 
              << ", channels=" << pwfx->nChannels 
              << ", bits=" << pwfx->wBitsPerSample << std::endl;
    
    // Initialize audio client in loopback mode
    hr = pAudioClient_->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK,  // Loopback flag to capture system audio
        10000000,  // 1 second buffer
        0,
        pwfx,
        NULL
    );
    
    if (FAILED(hr)) {
        std::cerr << "Failed to initialize audio client: " << std::hex << hr << std::endl;
        CoTaskMemFree(pwfx);
        CleanupCOM();
        isCapturing_ = false;
        return;
    }
    
    // Get the capture client
    hr = pAudioClient_->GetService(
        __uuidof(IAudioCaptureClient),
        (void**)&pCaptureClient_
    );
    
    if (FAILED(hr)) {
        std::cerr << "Failed to get capture client: " << std::hex << hr << std::endl;
        CoTaskMemFree(pwfx);
        CleanupCOM();
        isCapturing_ = false;
        return;
    }
    
    // Start the audio client
    hr = pAudioClient_->Start();
    
    if (FAILED(hr)) {
        std::cerr << "Failed to start audio client: " << std::hex << hr << std::endl;
        CoTaskMemFree(pwfx);
        CleanupCOM();
        isCapturing_ = false;
        return;
    }
    
    std::cout << "Windows audio capture started successfully" << std::endl;
    
    // Calculate bytes per sample
    UINT32 bytesPerSample = pwfx->wBitsPerSample / 8;
    UINT32 channels = pwfx->nChannels;
    bool isFloat = (pwfx->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) || 
                   (pwfx->wFormatTag == WAVE_FORMAT_EXTENSIBLE && 
                    reinterpret_cast<WAVEFORMATEXTENSIBLE*>(pwfx)->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT);
    
    // Capture loop
    while (isCapturing_) {
        Sleep(10);  // Sleep for 10ms
        
        UINT32 packetLength = 0;
        hr = pCaptureClient_->GetNextPacketSize(&packetLength);
        
        if (FAILED(hr)) {
            std::cerr << "Failed to get packet size: " << std::hex << hr << std::endl;
            break;
        }
        
        while (packetLength != 0) {
            BYTE* pData;
            UINT32 numFramesAvailable;
            DWORD flags;
            
            hr = pCaptureClient_->GetBuffer(
                &pData,
                &numFramesAvailable,
                &flags,
                NULL,
                NULL
            );
            
            if (FAILED(hr)) {
                std::cerr << "Failed to get buffer: " << std::hex << hr << std::endl;
                break;
            }
            
            if (numFramesAvailable > 0 && !(flags & AUDCLNT_BUFFERFLAGS_SILENT)) {
                // Convert audio data to float32
                size_t totalSamples = numFramesAvailable * channels;
                std::vector<float> audioData(totalSamples);
                
                if (isFloat && bytesPerSample == 4) {
                    // Already float32
                    memcpy(audioData.data(), pData, totalSamples * sizeof(float));
                } else if (!isFloat && bytesPerSample == 2) {
                    // Convert int16 to float
                    int16_t* int16Data = reinterpret_cast<int16_t*>(pData);
                    for (size_t i = 0; i < totalSamples; i++) {
                        audioData[i] = int16Data[i] / 32768.0f;
                    }
                } else if (!isFloat && bytesPerSample == 4) {
                    // Convert int32 to float
                    int32_t* int32Data = reinterpret_cast<int32_t*>(pData);
                    for (size_t i = 0; i < totalSamples; i++) {
                        audioData[i] = int32Data[i] / 2147483648.0f;
                    }
                }
                
                // Send to JavaScript via thread-safe function
                if (tsfn_ && isCapturing_) {
                    tsfn_.NonBlockingCall([audioData](Napi::Env env, Napi::Function jsCallback) {
                        try {
                            if (jsCallback.IsEmpty() || jsCallback.IsUndefined()) {
                                return;
                            }
                            // Convert to Buffer for efficient transfer
                            Napi::Buffer<float> buffer = Napi::Buffer<float>::Copy(env, audioData.data(), audioData.size());
                            jsCallback.Call({buffer});
                        } catch (const Napi::Error& e) {
                            // Ignore errors during callback
                        } catch (...) {
                            // Ignore other errors
                        }
                    });
                }
            }
            
            hr = pCaptureClient_->ReleaseBuffer(numFramesAvailable);
            
            if (FAILED(hr)) {
                std::cerr << "Failed to release buffer: " << std::hex << hr << std::endl;
                break;
            }
            
            hr = pCaptureClient_->GetNextPacketSize(&packetLength);
            
            if (FAILED(hr)) {
                std::cerr << "Failed to get next packet size: " << std::hex << hr << std::endl;
                break;
            }
        }
    }
    
    // Stop the audio client
    if (pAudioClient_) {
        pAudioClient_->Stop();
    }
    
    CoTaskMemFree(pwfx);
    CleanupCOM();
    
    std::cout << "Capture thread completed" << std::endl;
}

Napi::Value AudioCaptureAddon::Start(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (isCapturing_) {
        return Napi::Boolean::New(env, false);
    }
    
    // Start capture in a new thread
    isCapturing_ = true;
    captureThread_ = std::thread(&AudioCaptureAddon::CaptureThreadFunc, this);
    
    return Napi::Boolean::New(env, true);
}

Napi::Value AudioCaptureAddon::Stop(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!isCapturing_) {
        std::cout << "Stop called but not capturing" << std::endl;
        return env.Undefined();
    }
    
    std::cout << "Stopping capture..." << std::endl;
    
    // Signal the thread to stop
    isCapturing_ = false;
    
    // Wait for the thread to finish
    if (captureThread_.joinable()) {
        captureThread_.join();
    }
    
    std::cout << "Stop completed" << std::endl;
    return env.Undefined();
}

Napi::Value AudioCaptureAddon::IsActive(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    return Napi::Boolean::New(env, isCapturing_.load());
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    AudioCaptureAddon::Init(env, exports);
    return exports;
}

NODE_API_MODULE(audio_capture, Init)
