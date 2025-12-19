// WebRTC AEC3 Wrapper Implementation
// Supports both placeholder and real WebRTC AEC3 implementations

#include "webrtc_aec_wrapper.h"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <cstdlib>

// Try to include WebRTC headers if available
#ifdef USE_WEBRTC_AEC3
#include "webrtc_aec_wrapper_real.h"
#endif

// Base class implementation
WebRTCAEC3::WebRTCAEC3(int sampleRate, int numChannels)
    : sampleRate_(sampleRate)
    , numChannels_(numChannels)
    , initialized_(false)
{
}

WebRTCAEC3::~WebRTCAEC3() {
}

// Factory method - tries to create real WebRTC implementation, falls back to placeholder
std::unique_ptr<WebRTCAEC3> WebRTCAEC3::Create(int sampleRate, int numChannels) {
#ifdef USE_WEBRTC_AEC3
    // Try to create real WebRTC implementation
    try {
        auto realImpl = std::make_unique<WebRTCAEC3Real>(sampleRate, numChannels);
        if (realImpl->Initialize()) {
            return std::unique_ptr<WebRTCAEC3>(realImpl.release());
        }
    } catch (...) {
        // Fall through to placeholder
    }
#endif
    // Fall back to placeholder implementation
    auto placeholder = std::make_unique<WebRTCAEC3Placeholder>(sampleRate, numChannels);
    placeholder->Initialize();
    return std::unique_ptr<WebRTCAEC3>(placeholder.release());
}

// Placeholder implementation
WebRTCAEC3Placeholder::WebRTCAEC3Placeholder(int sampleRate, int numChannels)
    : WebRTCAEC3(sampleRate, numChannels)
    , historySize_(480 * 4) // 4 frames of history
{
    farEndHistory_.resize(historySize_, 0.0f);
    echoEstimate_.resize(480, 0.0f);
}

WebRTCAEC3Placeholder::~WebRTCAEC3Placeholder() {
}

bool WebRTCAEC3Placeholder::Initialize() {
    initialized_ = true;
    return true;
}

void WebRTCAEC3Placeholder::ProcessReverseStream(const float* farEnd, size_t samples) {
    if (!initialized_ || !farEnd || samples != 480) {
        return;
    }
    
    // Store far-end reference for adaptive filtering
    // Shift history
    std::memmove(farEndHistory_.data(), 
                 farEndHistory_.data() + samples,
                 (historySize_ - samples) * sizeof(float));
    
    // Add new samples
    std::memcpy(farEndHistory_.data() + (historySize_ - samples),
                farEnd, samples * sizeof(float));
}

void WebRTCAEC3Placeholder::ProcessStream(const float* nearEnd, size_t samples, float* output) {
    if (!initialized_ || !nearEnd || !output || samples != 480) {
        if (nearEnd && output) {
            std::memcpy(output, nearEnd, samples * sizeof(float));
        }
        return;
    }
    
    // TODO: When WebRTC AEC3 is integrated:
    // webrtc::AudioBuffer nearBuffer(...);
    // nearBuffer.CopyFrom(nearEnd, samples);
    // apm->ProcessStream(&nearBuffer);
    // nearBuffer.CopyTo(output, samples);
    
    // Improved adaptive echo cancellation with better echo estimation
    // Uses NLMS (Normalized Least Mean Squares) adaptive filter
    
    const float adaptationRate = 0.3f;  // Increased adaptation rate
    const size_t filterLength = 480;     // Filter length (10ms at 48kHz)
    const float minEchoGain = 0.1f;      // Minimum echo gain estimate
    const float maxEchoGain = 0.8f;      // Maximum echo gain estimate
    
    // Process each sample
    for (size_t i = 0; i < samples; i++) {
        // Find corresponding far-end sample (accounting for delay)
        // Typical echo delay is 0-50ms, so we look back in history
        size_t historyIdx = historySize_ - samples + i;
        
        // Estimate echo using weighted average of recent far-end samples
        // This models the room impulse response
        float echoEst = 0.0f;
        float weightSum = 0.0f;
        
        // Look back up to filterLength samples for echo estimation
        for (size_t j = 0; j < filterLength && (historyIdx >= j); j++) {
            float weight = 1.0f / (1.0f + j * 0.1f); // Decaying weight
            echoEst += farEndHistory_[historyIdx - j] * weight;
            weightSum += weight;
        }
        
        if (weightSum > 0.0f) {
            echoEst /= weightSum;
        }
        
        // Adaptive echo gain estimation
        // Estimate how much of the far-end signal appears in near-end
        float nearEndPower = nearEnd[i] * nearEnd[i];
        float farEndPower = echoEst * echoEst;
        
        float echoGain = minEchoGain;
        if (farEndPower > 0.0001f && nearEndPower > 0.0001f) {
            // Estimate gain based on correlation
            float correlation = std::min(1.0f, std::abs(nearEnd[i] * echoEst) / 
                                        (std::sqrt(nearEndPower * farEndPower) + 0.0001f));
            echoGain = minEchoGain + (maxEchoGain - minEchoGain) * correlation;
        }
        
        // Scale echo estimate by gain
        echoEst *= echoGain;
        
        // Update echo estimate adaptively (NLMS-style)
        float error = nearEnd[i] - echoEst;
        float adaptationStep = adaptationRate * error / (farEndPower + 0.0001f);
        echoEst += adaptationStep * farEndHistory_[historyIdx];
        
        // Clamp echo estimate
        echoEst = std::max(-1.0f, std::min(1.0f, echoEst));
        
        // Subtract echo estimate from near-end signal
        output[i] = nearEnd[i] - echoEst;
        
        // Additional suppression for residual echo
        // If output still contains significant echo-like content, suppress more
        float outputMagnitude = std::abs(output[i]);
        float echoMagnitude = std::abs(echoEst);
        if (outputMagnitude > 0.01f && echoMagnitude > 0.05f && 
            outputMagnitude < echoMagnitude * 1.5f) {
            // Output is suspiciously similar to echo, apply additional suppression
            output[i] *= 0.2f; // Strong suppression
        }
        
        // Clamp to prevent clipping
        output[i] = std::max(-1.0f, std::min(1.0f, output[i]));
    }
}

void WebRTCAEC3Placeholder::Reset() {
    std::fill(farEndHistory_.begin(), farEndHistory_.end(), 0.0f);
    std::fill(echoEstimate_.begin(), echoEstimate_.end(), 0.0f);
}
