// WebRTC AEC3 Real Implementation
// Uses actual WebRTC AudioProcessing library

#ifdef USE_WEBRTC_AEC3

#include "webrtc_aec_wrapper_real.h"
#include "modules/audio_processing/include/audio_processing.h"
#include "api/audio/audio_frame.h"
#include "common_audio/include/audio_util.h"
#include <cstring>
#include <vector>

WebRTCAEC3Real::WebRTCAEC3Real(int sampleRate, int numChannels)
    : WebRTCAEC3(sampleRate, numChannels)
    , apm_(nullptr)
    , initialized_(false)
{
}

WebRTCAEC3Real::~WebRTCAEC3Real() {
    if (apm_) {
        delete apm_;
        apm_ = nullptr;
    }
}

bool WebRTCAEC3Real::Initialize() {
    if (initialized_) {
        return true;
    }
    
    try {
        // Create AudioProcessing instance
        apm_ = webrtc::AudioProcessingBuilder().Create();
        if (!apm_) {
            return false;
        }
        
        // Configure AEC3
        webrtc::AudioProcessing::Config config;
        
        // Enable AEC3 (Acoustic Echo Cancellation 3)
        config.echo_canceller.enabled = true;
        config.echo_canceller.mobile_mode = false;  // Desktop mode for better quality
        
        // Enable additional processing for better quality
        config.noise_suppression.enabled = true;
        config.noise_suppression.level = webrtc::AudioProcessing::Config::NoiseSuppression::kModerate;
        
        config.gain_controller1.enabled = true;
        config.gain_controller1.mode = webrtc::AudioProcessing::Config::GainController1::kAdaptiveDigital;
        config.gain_controller1.target_level_dbfs = 3;  // Target level
        config.gain_controller1.compression_gain_db = 9; // Compression gain
        
        // Apply configuration
        apm_->ApplyConfig(config);
        
        // Initialize with stream configuration
        webrtc::StreamConfig streamConfig(sampleRate_, numChannels_);
        int err = apm_->Initialize({
            .input_stream = streamConfig,
            .output_stream = streamConfig,
            .reverse_input_stream = streamConfig,
            .reverse_output_stream = streamConfig,
        });
        
        if (err != 0) {
            delete apm_;
            apm_ = nullptr;
            return false;
        }
        
        initialized_ = true;
        return true;
    } catch (...) {
        if (apm_) {
            delete apm_;
            apm_ = nullptr;
        }
        return false;
    }
}

void WebRTCAEC3Real::ProcessReverseStream(const float* farEnd, size_t samples) {
    if (!initialized_ || !apm_ || !farEnd || samples != 480) {
        return;
    }
    
    // Convert float to int16 for WebRTC (WebRTC uses int16 internally)
    std::vector<int16_t> int16Data(samples);
    for (size_t i = 0; i < samples; i++) {
        int16Data[i] = static_cast<int16_t>(
            std::max(-32768.0f, std::min(32767.0f, farEnd[i] * 32768.0f))
        );
    }
    
    // Create audio frame for reverse stream (far-end reference)
    webrtc::AudioFrame reverseFrame;
    reverseFrame.sample_rate_hz_ = sampleRate_;
    reverseFrame.num_channels_ = numChannels_;
    reverseFrame.samples_per_channel_ = static_cast<size_t>(samples);
    
    // Copy far-end audio data
    std::memcpy(reverseFrame.mutable_data(), int16Data.data(), samples * sizeof(int16_t));
    
    // Process reverse stream (this provides the echo reference)
    apm_->ProcessReverseStream(&reverseFrame);
}

void WebRTCAEC3Real::ProcessStream(const float* nearEnd, size_t samples, float* output) {
    if (!initialized_ || !apm_ || !nearEnd || !output || samples != 480) {
        if (nearEnd && output) {
            std::memcpy(output, nearEnd, samples * sizeof(float));
        }
        return;
    }
    
    // Convert float to int16 for WebRTC
    std::vector<int16_t> int16Input(samples);
    for (size_t i = 0; i < samples; i++) {
        int16Input[i] = static_cast<int16_t>(
            std::max(-32768.0f, std::min(32767.0f, nearEnd[i] * 32768.0f))
        );
    }
    
    // Create audio frame for near-end stream (microphone with echo)
    webrtc::AudioFrame nearFrame;
    nearFrame.sample_rate_hz_ = sampleRate_;
    nearFrame.num_channels_ = numChannels_;
    nearFrame.samples_per_channel_ = static_cast<size_t>(samples);
    
    // Copy near-end audio data
    std::memcpy(nearFrame.mutable_data(), int16Input.data(), samples * sizeof(int16_t));
    
    // Process stream (AEC3 removes echo using the reverse stream reference)
    int err = apm_->ProcessStream(&nearFrame);
    
    if (err == 0) {
        // Convert processed int16 back to float
        const int16_t* processedData = nearFrame.data();
        for (size_t i = 0; i < samples; i++) {
            output[i] = processedData[i] / 32768.0f;
        }
    } else {
        // On error, pass through original audio
        std::memcpy(output, nearEnd, samples * sizeof(float));
    }
}

void WebRTCAEC3Real::Reset() {
    if (!initialized_ || !apm_) {
        return;
    }
    
    // Reset AEC state
    webrtc::StreamConfig streamConfig(sampleRate_, numChannels_);
    apm_->Initialize({
        .input_stream = streamConfig,
        .output_stream = streamConfig,
        .reverse_input_stream = streamConfig,
        .reverse_output_stream = streamConfig,
    });
}

#endif // USE_WEBRTC_AEC3
