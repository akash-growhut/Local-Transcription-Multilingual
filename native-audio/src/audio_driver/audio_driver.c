//
// AudioDriver.c - HAL AudioServerPlugIn Implementation
// Virtual audio driver that captures system output audio
//

#include "audio_driver.h"
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>

// Global driver state
AudioDriverState g_driver_state = {0};

#pragma mark - Shared Memory Management

OSStatus AudioDriver_CreateSharedMemory(SharedAudioMemory** out_memory) {
    if (!out_memory) {
        return kAudioHardwareBadObjectError;
    }
    
    SharedAudioMemory* memory = calloc(1, sizeof(SharedAudioMemory));
    if (!memory) {
        return kAudioHardwareUnspecifiedError;
    }
    
    // Create named shared memory
    memory->memory_size = sizeof(AudioRingBuffer);
    
    // Use POSIX shared memory (simpler than mach ports for this use case)
    int shm_fd = shm_open(SHARED_MEMORY_NAME, O_CREAT | O_RDWR, 0666);
    if (shm_fd == -1) {
        free(memory);
        return kAudioHardwareUnspecifiedError;
    }
    
    // Set size
    if (ftruncate(shm_fd, memory->memory_size) == -1) {
        close(shm_fd);
        shm_unlink(SHARED_MEMORY_NAME);
        free(memory);
        return kAudioHardwareUnspecifiedError;
    }
    
    // Map shared memory
    memory->ring_buffer = (AudioRingBuffer*)mmap(NULL, memory->memory_size,
                                                  PROT_READ | PROT_WRITE,
                                                  MAP_SHARED, shm_fd, 0);
    close(shm_fd);
    
    if (memory->ring_buffer == MAP_FAILED) {
        shm_unlink(SHARED_MEMORY_NAME);
        free(memory);
        return kAudioHardwareUnspecifiedError;
    }
    
    // Initialize ring buffer (using _Atomic types)
    atomic_store(&memory->ring_buffer->write_position, 0);
    atomic_store(&memory->ring_buffer->read_position, 0);
    atomic_store(&memory->ring_buffer->active, false);
    memory->ring_buffer->sample_rate = 48000;
    memory->ring_buffer->channels = 1; // Mono after downmix
    memory->ring_buffer->frame_size = sizeof(float);
    
    *out_memory = memory;
    return noErr;
}

void AudioDriver_DestroySharedMemory(SharedAudioMemory* memory) {
    if (!memory) return;
    
    if (memory->ring_buffer && memory->ring_buffer != MAP_FAILED) {
        atomic_store(&memory->ring_buffer->active, false);
        munmap(memory->ring_buffer, memory->memory_size);
    }
    
    shm_unlink(SHARED_MEMORY_NAME);
    free(memory);
}

#pragma mark - Audio Processing

OSStatus AudioDriver_DownmixStereoToMono(const float* stereo_input, float* mono_output, UInt32 frame_count) {
    if (!stereo_input || !mono_output || frame_count == 0) {
        return kAudioHardwareBadObjectError;
    }
    
    for (UInt32 i = 0; i < frame_count; i++) {
        float left = stereo_input[i * 2];
        float right = stereo_input[i * 2 + 1];
        mono_output[i] = (left + right) * 0.5f;
    }
    
    return noErr;
}

OSStatus AudioDriver_WriteToRingBuffer(AudioRingBuffer* ring_buffer, const AudioBufferList* audio_buffer_list) {
    if (!ring_buffer || !audio_buffer_list) {
        return kAudioHardwareBadObjectError;
    }
    
    if (!atomic_load(&ring_buffer->active)) {
        return noErr; // Not an error, just not capturing
    }
    
    // Assume stereo input (2 channels)
    if (audio_buffer_list->mNumberBuffers < 1) {
        return kAudioHardwareBadObjectError;
    }
    
    const AudioBuffer* input_buffer = &audio_buffer_list->mBuffers[0];
    if (!input_buffer->mData || input_buffer->mDataByteSize == 0) {
        return noErr;
    }
    
    // Determine frame count (assuming Float32 format)
    UInt32 frame_count = input_buffer->mDataByteSize / (sizeof(float) * 2); // 2 channels
    const float* stereo_data = (const float*)input_buffer->mData;
    
    // Downmix to mono (use VLA or allocate dynamically)
    float* mono_buffer = (float*)alloca(frame_count * sizeof(float));
    OSStatus status = AudioDriver_DownmixStereoToMono(stereo_data, mono_buffer, frame_count);
    if (status != noErr) {
        return status;
    }
    
    // Get current positions
    uint64_t write_pos = atomic_load(&ring_buffer->write_position);
    
    // Write frames to ring buffer (overwrite oldest data if buffer is full)
    for (UInt32 i = 0; i < frame_count; i++) {
        uint64_t buffer_index = (write_pos + i) % RING_BUFFER_FRAMES;
        ring_buffer->buffer[buffer_index] = mono_buffer[i];
    }
    
    // Update write position (atomic)
    atomic_store(&ring_buffer->write_position, (write_pos + frame_count) % RING_BUFFER_FRAMES);
    
    return noErr;
}

OSStatus AudioDriver_IOProc(
    AudioObjectID in_object_id,
    const AudioTimeStamp* in_now,
    const AudioBufferList* in_input_data,
    const AudioTimeStamp* in_input_time,
    AudioBufferList* out_output_data,
    const AudioTimeStamp* in_output_time,
    void* in_client_data) {
    
    // This is a virtual output device - we receive audio here but don't play it
    // Just copy input to output (pass-through) and capture to ring buffer
    
    if (out_output_data && in_input_data) {
        // Pass through audio (required by HAL)
        for (UInt32 i = 0; i < in_input_data->mNumberBuffers && i < out_output_data->mNumberBuffers; i++) {
            UInt32 copy_size = (in_input_data->mBuffers[i].mDataByteSize < out_output_data->mBuffers[i].mDataByteSize) ?
                              in_input_data->mBuffers[i].mDataByteSize : out_output_data->mBuffers[i].mDataByteSize;
            memcpy(out_output_data->mBuffers[i].mData, in_input_data->mBuffers[i].mData, copy_size);
            out_output_data->mBuffers[i].mDataByteSize = copy_size;
        }
    }
    
    // Capture to ring buffer
    if (g_driver_state.shared_memory && g_driver_state.shared_memory->ring_buffer) {
        AudioDriver_WriteToRingBuffer(g_driver_state.shared_memory->ring_buffer, in_input_data);
    }
    
    return noErr;
}

#pragma mark - HAL Plug-in Entry Points

AudioServerPlugInDriverRef AudioDriver_Initialize(AudioServerPlugInHostRef in_host) {
    // Initialize driver state
    memset(&g_driver_state, 0, sizeof(AudioDriverState));
    g_driver_state.driver_ref = (AudioServerPlugInDriverRef)&g_driver_state;
    g_driver_state.nominal_sample_rate = 48000.0;
    
    // Generate a unique device object ID (HAL will assign this, but we need a placeholder)
    // In a real implementation, this would be assigned by the HAL host
    static AudioObjectID s_next_object_id = 100;
    g_driver_state.device_object_id = s_next_object_id++;
    
    // Create shared memory
    OSStatus status = AudioDriver_CreateSharedMemory(&g_driver_state.shared_memory);
    if (status != noErr) {
        return NULL;
    }
    
    // Initialize mutex
    pthread_mutex_init(&g_driver_state.io_mutex, NULL);
    
    return g_driver_state.driver_ref;
}

void AudioDriver_Teardown(AudioServerPlugInDriverRef in_driver) {
    if (g_driver_state.shared_memory) {
        AudioDriver_DestroySharedMemory(g_driver_state.shared_memory);
        g_driver_state.shared_memory = NULL;
    }
    
    pthread_mutex_destroy(&g_driver_state.io_mutex);
}

OSStatus AudioDriver_AddDevice(
    AudioServerPlugInDriverRef in_driver,
    CFDictionaryRef in_description,
    const AudioServerPlugInClientInfo* in_client_info,
    AudioObjectID* out_device_object_id) {
    
    // Device is created by the system when the plug-in is loaded
    // This function is called to register the device
    if (out_device_object_id) {
        *out_device_object_id = g_driver_state.device_object_id;
    }
    
    g_driver_state.is_device_created = true;
    return noErr;
}

OSStatus AudioDriver_RemoveDevice(
    AudioServerPlugInDriverRef in_driver,
    AudioObjectID in_device_object_id) {
    
    g_driver_state.is_device_created = false;
    g_driver_state.is_capture_active = false;
    
    if (g_driver_state.shared_memory && g_driver_state.shared_memory->ring_buffer) {
        atomic_store(&g_driver_state.shared_memory->ring_buffer->active, false);
    }
    
    return noErr;
}

OSStatus AudioDriver_PerformDeviceConfigurationChange(
    AudioServerPlugInDriverRef in_driver,
    AudioObjectID in_device_object_id,
    UInt64 in_change_action,
    void* in_change_info) {
    
    return noErr;
}

OSStatus AudioDriver_AbortDeviceConfigurationChange(
    AudioServerPlugInDriverRef in_driver,
    AudioObjectID in_device_object_id,
    UInt64 in_change_action,
    void* in_change_info) {
    
    return noErr;
}

#pragma mark - Property Handlers
// Property handlers are implemented in audio_driver_properties.c
// These are just stubs - the real implementation is in the properties file

#pragma mark - HAL Plug-in Interface

// Note: Complete HAL interface implementation is in audio_driver_complete.c
// This file contains the core audio processing and shared memory management

