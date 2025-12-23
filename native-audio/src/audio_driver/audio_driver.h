//
// AudioDriver.h - HAL AudioServerPlugIn Header
// Virtual audio driver that captures system audio output
//

#ifndef AUDIO_DRIVER_H
#define AUDIO_DRIVER_H

#include <CoreAudio/AudioServerPlugIn.h>
#include <CoreAudio/CoreAudio.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <mach/mach.h>
#include <pthread.h>
#include <stdatomic.h>
#include <unistd.h>

// Driver UUID (generate your own UUID using: uuidgen)
#define DRIVER_UUID_STRING "A1B2C3D4-E5F6-7890-ABCD-EF1234567890"

// Shared memory configuration
#define SHARED_MEMORY_NAME "com.growhut.audiodriver.shm"
#define RING_BUFFER_SIZE (48000 * 2 * 4 * 2) // 2 seconds at 48kHz, stereo, float32
#define RING_BUFFER_FRAMES (48000 * 2) // 2 seconds

// Ring buffer structure
typedef struct {
    _Atomic(uint64_t) write_position;  // Current write position (in frames)
    _Atomic(uint64_t) read_position;   // Current read position (in frames)
    _Atomic(bool) active;              // Is capture active?
    UInt32 sample_rate;                // Sample rate (typically 48000)
    UInt32 channels;                   // Channel count (stereo = 2, mono = 1 after downmix)
    UInt32 frame_size;                 // Size of one frame in bytes (channels * sizeof(float))
    float buffer[RING_BUFFER_FRAMES * 2]; // Stereo buffer (will be downmixed to mono)
} AudioRingBuffer;

// Shared memory structure
typedef struct {
    AudioRingBuffer ring_buffer;
    mach_port_t memory_port;
    size_t memory_size;
} SharedAudioMemory;

// Driver state
typedef struct {
    AudioServerPlugInDriverRef driver_ref;
    AudioObjectID device_object_id;
    SharedAudioMemory* shared_memory;
    pthread_mutex_t io_mutex;
    bool is_device_created;
    bool is_capture_active;
    Float64 nominal_sample_rate;
} AudioDriverState;

// Forward declarations
extern AudioDriverState g_driver_state;

// Core HAL plug-in functions
AudioServerPlugInDriverRef AudioDriver_Initialize(AudioServerPlugInHostRef in_host);
void AudioDriver_Teardown(AudioServerPlugInDriverRef in_driver);
OSStatus AudioDriver_AddDevice(
    AudioServerPlugInDriverRef in_driver,
    CFDictionaryRef in_description,
    const AudioServerPlugInClientInfo* in_client_info,
    AudioObjectID* out_device_object_id
);
OSStatus AudioDriver_RemoveDevice(
    AudioServerPlugInDriverRef in_driver,
    AudioObjectID in_device_object_id
);
OSStatus AudioDriver_PerformDeviceConfigurationChange(
    AudioServerPlugInDriverRef in_driver,
    AudioObjectID in_device_object_id,
    UInt64 in_change_action,
    void* in_change_info
);
OSStatus AudioDriver_AbortDeviceConfigurationChange(
    AudioServerPlugInDriverRef in_driver,
    AudioObjectID in_device_object_id,
    UInt64 in_change_action,
    void* in_change_info
);

// Property handlers
OSStatus AudioDriver_HasProperty(
    AudioServerPlugInDriverRef in_driver,
    AudioObjectID in_object_id,
    pid_t in_client_process_id,
    const AudioObjectPropertyAddress* in_address,
    Boolean* out_is_settable
);
OSStatus AudioDriver_IsPropertySettable(
    AudioServerPlugInDriverRef in_driver,
    AudioObjectID in_object_id,
    pid_t in_client_process_id,
    const AudioObjectPropertyAddress* in_address,
    Boolean* out_is_settable
);
OSStatus AudioDriver_GetPropertyDataSize(
    AudioServerPlugInDriverRef in_driver,
    AudioObjectID in_object_id,
    pid_t in_client_process_id,
    const AudioObjectPropertyAddress* in_address,
    UInt32 in_qualifier_data_size,
    const void* in_qualifier_data,
    UInt32* out_data_size
);
OSStatus AudioDriver_GetPropertyData(
    AudioServerPlugInDriverRef in_driver,
    AudioObjectID in_object_id,
    pid_t in_client_process_id,
    const AudioObjectPropertyAddress* in_address,
    UInt32 in_qualifier_data_size,
    const void* in_qualifier_data,
    UInt32 in_data_size,
    UInt32* out_data_size,
    void* out_data
);
OSStatus AudioDriver_SetPropertyData(
    AudioServerPlugInDriverRef in_driver,
    AudioObjectID in_object_id,
    pid_t in_client_process_id,
    const AudioObjectPropertyAddress* in_address,
    UInt32 in_qualifier_data_size,
    const void* in_qualifier_data,
    UInt32 in_data_size,
    const void* in_data
);

// IOProc callback (receives audio from system)
OSStatus AudioDriver_IOProc(
    AudioObjectID in_object_id,
    const AudioTimeStamp* in_now,
    const AudioBufferList* in_input_data,
    const AudioTimeStamp* in_input_time,
    AudioBufferList* out_output_data,
    const AudioTimeStamp* in_output_time,
    void* in_client_data
);

// Shared memory functions
OSStatus AudioDriver_CreateSharedMemory(SharedAudioMemory** out_memory);
void AudioDriver_DestroySharedMemory(SharedAudioMemory* memory);
OSStatus AudioDriver_WriteToRingBuffer(AudioRingBuffer* ring_buffer, const AudioBufferList* audio_buffer_list);
OSStatus AudioDriver_DownmixStereoToMono(const float* stereo_input, float* mono_output, UInt32 frame_count);

#endif // AUDIO_DRIVER_H

