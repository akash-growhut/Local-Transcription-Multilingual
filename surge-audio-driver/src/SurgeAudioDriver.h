/*
 * SurgeAudioDriver - Virtual Audio Driver for System Audio Capture
 * 
 * This is an AudioServerPlugin that creates a virtual audio device
 * allowing applications to capture system audio without screen recording.
 */

#ifndef SURGE_AUDIO_DRIVER_H
#define SURGE_AUDIO_DRIVER_H

#include <CoreAudio/AudioServerPlugIn.h>
#include <CoreFoundation/CoreFoundation.h>
#include <mach/mach_time.h>
#include <pthread.h>
#include <stdint.h>

// Plugin UUID - must match Info.plist
#define kSurgeAudioDriverPlugInUUID "5A824EC3-B3E8-4C7C-9F2A-D8F6A1E2B3C4"

// Object IDs
enum {
    kObjectID_PlugIn                = 1,
    kObjectID_Device                = 2,
    kObjectID_Stream_Input          = 3,
    kObjectID_Stream_Output         = 4,
    kObjectID_Volume_Input_Master   = 5,
    kObjectID_Volume_Output_Master  = 6,
    kObjectID_Mute_Input_Master     = 7,
    kObjectID_Mute_Output_Master    = 8,
    kObjectID_DataSource_Input      = 9,
    kObjectID_DataSource_Output     = 10
};

// Audio Configuration
#define kDevice_Name                "Surge Audio"
#define kDevice_Manufacturer        "Surge"
#define kDevice_UID                 "SurgeAudioDevice_UID"
#define kDevice_ModelUID            "SurgeAudioDevice_ModelUID"

// Default audio format
#define kSampleRate_Default         48000.0
#define kBitsPerChannel             32
#define kBytesPerChannel            (kBitsPerChannel / 8)
#define kChannelsPerFrame           2
#define kBytesPerFrame              (kBytesPerChannel * kChannelsPerFrame)

// Ring buffer configuration
#define kRingBufferFrameSize        16384
#define kRingBufferSize             (kRingBufferFrameSize * kBytesPerFrame)

// Latency
#define kLatency_Frame_Size         512

#pragma mark - Data Structures

typedef struct {
    // Plugin state
    AudioServerPlugInHostRef    hostRef;
    CFStringRef                 bundleID;
    
    // Device state
    Float64                     sampleRate;
    UInt32                      ringBufferFrameSize;
    bool                        deviceIsRunning;
    bool                        inputStreamIsActive;
    bool                        outputStreamIsActive;
    
    // Volume and mute
    Float32                     inputVolume;
    Float32                     outputVolume;
    bool                        inputMute;
    bool                        outputMute;
    
    // Ring buffer for audio loopback
    Float32*                    ringBuffer;
    UInt32                      ringBufferWritePosition;
    UInt32                      ringBufferReadPosition;
    pthread_mutex_t             ringBufferMutex;
    
    // Timing
    UInt64                      anchorHostTime;
    Float64                     anchorSampleTime;
    UInt64                      ticksPerFrame;
    
} SurgeAudioDriverState;

#pragma mark - Plugin Interface

// Factory function - entry point
extern void* SurgeAudioDriverPlugInFactory(CFAllocatorRef allocator, CFUUIDRef typeUUID);

// AudioServerPlugIn interface implementation
static HRESULT SurgeAudioDriver_QueryInterface(void* driver, REFIID uuid, LPVOID* interface);
static ULONG SurgeAudioDriver_AddRef(void* driver);
static ULONG SurgeAudioDriver_Release(void* driver);

// Plugin operations
static OSStatus SurgeAudioDriver_Initialize(AudioServerPlugInDriverRef driver, AudioServerPlugInHostRef host);
static OSStatus SurgeAudioDriver_CreateDevice(AudioServerPlugInDriverRef driver, CFDictionaryRef description, const AudioServerPlugInClientInfo* clientInfo, AudioObjectID* outDeviceID);
static OSStatus SurgeAudioDriver_DestroyDevice(AudioServerPlugInDriverRef driver, AudioObjectID deviceID);
static OSStatus SurgeAudioDriver_AddDeviceClient(AudioServerPlugInDriverRef driver, AudioObjectID deviceID, const AudioServerPlugInClientInfo* clientInfo);
static OSStatus SurgeAudioDriver_RemoveDeviceClient(AudioServerPlugInDriverRef driver, AudioObjectID deviceID, const AudioServerPlugInClientInfo* clientInfo);
static OSStatus SurgeAudioDriver_PerformDeviceConfigurationChange(AudioServerPlugInDriverRef driver, AudioObjectID deviceID, UInt64 changeAction, void* changeInfo);
static OSStatus SurgeAudioDriver_AbortDeviceConfigurationChange(AudioServerPlugInDriverRef driver, AudioObjectID deviceID, UInt64 changeAction, void* changeInfo);

// Property operations
static Boolean SurgeAudioDriver_HasProperty(AudioServerPlugInDriverRef driver, AudioObjectID objectID, pid_t clientPID, const AudioObjectPropertyAddress* address);
static OSStatus SurgeAudioDriver_IsPropertySettable(AudioServerPlugInDriverRef driver, AudioObjectID objectID, pid_t clientPID, const AudioObjectPropertyAddress* address, Boolean* outIsSettable);
static OSStatus SurgeAudioDriver_GetPropertyDataSize(AudioServerPlugInDriverRef driver, AudioObjectID objectID, pid_t clientPID, const AudioObjectPropertyAddress* address, UInt32 qualifierDataSize, const void* qualifierData, UInt32* outDataSize);
static OSStatus SurgeAudioDriver_GetPropertyData(AudioServerPlugInDriverRef driver, AudioObjectID objectID, pid_t clientPID, const AudioObjectPropertyAddress* address, UInt32 qualifierDataSize, const void* qualifierData, UInt32 inDataSize, UInt32* outDataSize, void* outData);
static OSStatus SurgeAudioDriver_SetPropertyData(AudioServerPlugInDriverRef driver, AudioObjectID objectID, pid_t clientPID, const AudioObjectPropertyAddress* address, UInt32 qualifierDataSize, const void* qualifierData, UInt32 inDataSize, const void* inData);

// IO operations
static OSStatus SurgeAudioDriver_StartIO(AudioServerPlugInDriverRef driver, AudioObjectID deviceID, UInt32 clientID);
static OSStatus SurgeAudioDriver_StopIO(AudioServerPlugInDriverRef driver, AudioObjectID deviceID, UInt32 clientID);
static OSStatus SurgeAudioDriver_GetZeroTimeStamp(AudioServerPlugInDriverRef driver, AudioObjectID deviceID, UInt32 clientID, Float64* outSampleTime, UInt64* outHostTime, UInt64* outSeed);
static OSStatus SurgeAudioDriver_WillDoIOOperation(AudioServerPlugInDriverRef driver, AudioObjectID deviceID, UInt32 clientID, UInt32 operationID, Boolean* outWillDo, Boolean* outWillDoInPlace);
static OSStatus SurgeAudioDriver_BeginIOOperation(AudioServerPlugInDriverRef driver, AudioObjectID deviceID, UInt32 clientID, UInt32 operationID, UInt32 ioBufferFrameSize, const AudioServerPlugInIOCycleInfo* ioCycleInfo);
static OSStatus SurgeAudioDriver_DoIOOperation(AudioServerPlugInDriverRef driver, AudioObjectID deviceID, AudioObjectID streamID, UInt32 clientID, UInt32 operationID, UInt32 ioBufferFrameSize, const AudioServerPlugInIOCycleInfo* ioCycleInfo, void* ioMainBuffer, void* ioSecondaryBuffer);
static OSStatus SurgeAudioDriver_EndIOOperation(AudioServerPlugInDriverRef driver, AudioObjectID deviceID, UInt32 clientID, UInt32 operationID, UInt32 ioBufferFrameSize, const AudioServerPlugInIOCycleInfo* ioCycleInfo);

#endif /* SURGE_AUDIO_DRIVER_H */
