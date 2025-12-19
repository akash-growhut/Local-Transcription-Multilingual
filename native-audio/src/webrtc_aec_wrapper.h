// WebRTC AEC3 Wrapper Header
// This file provides an interface for WebRTC AEC3 integration
// 
// To integrate WebRTC AEC3:
// 1. Build WebRTC AudioProcessing module (see BUILD_WEBRTC_AEC.md)
// 2. Define USE_WEBRTC_AEC3 in your build configuration
// 3. Link against the WebRTC AudioProcessing library

#ifndef WEBRTC_AEC_WRAPPER_H
#define WEBRTC_AEC_WRAPPER_H

#include <vector>
#include <memory>

// WebRTC AEC3 Interface (base class)
// Can use placeholder implementation or real WebRTC AEC3
class WebRTCAEC3 {
public:
    WebRTCAEC3(int sampleRate = 48000, int numChannels = 1);
    virtual ~WebRTCAEC3();
    
    // Initialize AEC3
    virtual bool Initialize() = 0;
    
    // Process reverse stream (far-end reference - speaker audio)
    // Must be called BEFORE ProcessStream for each frame
    virtual void ProcessReverseStream(const float* farEnd, size_t samples) = 0;
    
    // Process near-end stream (microphone - contains echo)
    // Returns processed audio with echo removed
    virtual void ProcessStream(const float* nearEnd, size_t samples, float* output) = 0;
    
    // Reset AEC state
    virtual void Reset() = 0;
    
    // Get required frame size (480 samples for 10ms at 48kHz)
    static size_t GetFrameSize() { return 480; }
    
    // Get sample rate
    static int GetSampleRate() { return 48000; }
    
    // Factory method to create appropriate implementation
    static std::unique_ptr<WebRTCAEC3> Create(int sampleRate = 48000, int numChannels = 1);

protected:
    int sampleRate_;
    int numChannels_;
    bool initialized_;
};

// Placeholder implementation (fallback when WebRTC not available)
class WebRTCAEC3Placeholder : public WebRTCAEC3 {
public:
    WebRTCAEC3Placeholder(int sampleRate = 48000, int numChannels = 1);
    ~WebRTCAEC3Placeholder() override;
    
    bool Initialize() override;
    void ProcessReverseStream(const float* farEnd, size_t samples) override;
    void ProcessStream(const float* nearEnd, size_t samples, float* output) override;
    void Reset() override;

private:
    // Adaptive filter state for improved echo cancellation
    std::vector<float> farEndHistory_;
    std::vector<float> echoEstimate_;
    size_t historySize_;
};

#endif // WEBRTC_AEC_WRAPPER_H
