// WebRTC AEC3 Real Implementation Header
// This file uses actual WebRTC AudioProcessing when available

#ifndef WEBRTC_AEC_WRAPPER_REAL_H
#define WEBRTC_AEC_WRAPPER_REAL_H

#ifdef USE_WEBRTC_AEC3

#include "webrtc_aec_wrapper.h"

// Forward declarations
namespace webrtc {
    class AudioProcessing;
}

// Real WebRTC AEC3 implementation
class WebRTCAEC3Real : public WebRTCAEC3 {
public:
    WebRTCAEC3Real(int sampleRate = 48000, int numChannels = 1);
    ~WebRTCAEC3Real() override;
    
    bool Initialize() override;
    void ProcessReverseStream(const float* farEnd, size_t samples) override;
    void ProcessStream(const float* nearEnd, size_t samples, float* output) override;
    void Reset() override;

private:
    webrtc::AudioProcessing* apm_;
};

#endif // USE_WEBRTC_AEC3

#endif // WEBRTC_AEC_WRAPPER_REAL_H
