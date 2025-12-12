/*
 * SurgeAudioDriver - Virtual Audio Driver Implementation
 * 
 * This AudioServerPlugin creates a virtual loopback audio device that:
 * 1. Appears as both an input and output device
 * 2. Routes audio from output to input (loopback)
 * 3. Allows capturing system audio when set as output device
 */

#include "SurgeAudioDriver.h"
#include <CoreAudio/AudioHardwareBase.h>
#include <mach/mach_time.h>
#include <dispatch/dispatch.h>
#include <os/log.h>

#pragma mark - Globals

static SurgeAudioDriverState gDriverState = {0};
static AudioServerPlugInDriverInterface gDriverInterface;
static AudioServerPlugInDriverInterface* gDriverInterfacePtr = &gDriverInterface;
static UInt32 gDriverRefCount = 0;

static os_log_t gLog = NULL;

#define LOG_DEBUG(format, ...) os_log_debug(gLog, format, ##__VA_ARGS__)
#define LOG_INFO(format, ...) os_log_info(gLog, format, ##__VA_ARGS__)
#define LOG_ERROR(format, ...) os_log_error(gLog, format, ##__VA_ARGS__)

#pragma mark - Helper Functions

static void InitializeDriverState(void) {
    gDriverState.sampleRate = kSampleRate_Default;
    gDriverState.ringBufferFrameSize = kRingBufferFrameSize;
    gDriverState.deviceIsRunning = false;
    gDriverState.inputStreamIsActive = true;
    gDriverState.outputStreamIsActive = true;
    gDriverState.inputVolume = 1.0f;
    gDriverState.outputVolume = 1.0f;
    gDriverState.inputMute = false;
    gDriverState.outputMute = false;
    gDriverState.ringBufferWritePosition = 0;
    gDriverState.ringBufferReadPosition = 0;
    
    // Allocate ring buffer
    gDriverState.ringBuffer = (Float32*)calloc(kRingBufferSize, sizeof(Float32));
    pthread_mutex_init(&gDriverState.ringBufferMutex, NULL);
    
    // Calculate timing
    mach_timebase_info_data_t timebase;
    mach_timebase_info(&timebase);
    Float64 nsPerTick = (Float64)timebase.numer / (Float64)timebase.denom;
    Float64 nsPerFrame = 1000000000.0 / gDriverState.sampleRate;
    gDriverState.ticksPerFrame = (UInt64)(nsPerFrame / nsPerTick);
}

static void CleanupDriverState(void) {
    if (gDriverState.ringBuffer) {
        free(gDriverState.ringBuffer);
        gDriverState.ringBuffer = NULL;
    }
    pthread_mutex_destroy(&gDriverState.ringBufferMutex);
}

#pragma mark - Plugin Factory

void* SurgeAudioDriverPlugInFactory(CFAllocatorRef allocator, CFUUIDRef typeUUID) {
    // Initialize logging
    if (!gLog) {
        gLog = os_log_create("com.surge.audiodriver", "driver");
    }
    
    LOG_INFO("SurgeAudioDriver: Factory called");
    
    // Verify this is the AudioServerPlugIn type
    CFUUIDRef audioPlugInTypeUUID = CFUUIDCreateFromString(NULL, CFSTR("443ABAB8-E7B3-491A-B985-BEB9187030DB"));
    if (!CFEqual(typeUUID, audioPlugInTypeUUID)) {
        CFRelease(audioPlugInTypeUUID);
        return NULL;
    }
    CFRelease(audioPlugInTypeUUID);
    
    // Setup the driver interface
    gDriverInterface.QueryInterface = SurgeAudioDriver_QueryInterface;
    gDriverInterface.AddRef = SurgeAudioDriver_AddRef;
    gDriverInterface.Release = SurgeAudioDriver_Release;
    gDriverInterface.Initialize = SurgeAudioDriver_Initialize;
    gDriverInterface.CreateDevice = SurgeAudioDriver_CreateDevice;
    gDriverInterface.DestroyDevice = SurgeAudioDriver_DestroyDevice;
    gDriverInterface.AddDeviceClient = SurgeAudioDriver_AddDeviceClient;
    gDriverInterface.RemoveDeviceClient = SurgeAudioDriver_RemoveDeviceClient;
    gDriverInterface.PerformDeviceConfigurationChange = SurgeAudioDriver_PerformDeviceConfigurationChange;
    gDriverInterface.AbortDeviceConfigurationChange = SurgeAudioDriver_AbortDeviceConfigurationChange;
    gDriverInterface.HasProperty = SurgeAudioDriver_HasProperty;
    gDriverInterface.IsPropertySettable = SurgeAudioDriver_IsPropertySettable;
    gDriverInterface.GetPropertyDataSize = SurgeAudioDriver_GetPropertyDataSize;
    gDriverInterface.GetPropertyData = SurgeAudioDriver_GetPropertyData;
    gDriverInterface.SetPropertyData = SurgeAudioDriver_SetPropertyData;
    gDriverInterface.StartIO = SurgeAudioDriver_StartIO;
    gDriverInterface.StopIO = SurgeAudioDriver_StopIO;
    gDriverInterface.GetZeroTimeStamp = SurgeAudioDriver_GetZeroTimeStamp;
    gDriverInterface.WillDoIOOperation = SurgeAudioDriver_WillDoIOOperation;
    gDriverInterface.BeginIOOperation = SurgeAudioDriver_BeginIOOperation;
    gDriverInterface.DoIOOperation = SurgeAudioDriver_DoIOOperation;
    gDriverInterface.EndIOOperation = SurgeAudioDriver_EndIOOperation;
    
    // Initialize driver state
    InitializeDriverState();
    
    gDriverRefCount = 1;
    
    LOG_INFO("SurgeAudioDriver: Plugin created successfully");
    
    return &gDriverInterfacePtr;
}

#pragma mark - IUnknown Interface

static HRESULT SurgeAudioDriver_QueryInterface(void* driver, REFIID uuid, LPVOID* interface) {
    CFUUIDRef audioPlugInInterfaceUUID = CFUUIDGetConstantUUIDWithBytes(NULL,
        0x44, 0x3A, 0xBA, 0xB8, 0xE7, 0xB3, 0x49, 0x1A,
        0xB9, 0x85, 0xBE, 0xB9, 0x18, 0x70, 0x30, 0xDB);
    
    CFUUIDRef iUnknownUUID = CFUUIDGetConstantUUIDWithBytes(NULL,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46);
    
    CFUUIDRef requestedUUID = CFUUIDCreateFromUUIDBytes(NULL, uuid);
    
    if (CFEqual(requestedUUID, audioPlugInInterfaceUUID) || CFEqual(requestedUUID, iUnknownUUID)) {
        CFRelease(requestedUUID);
        SurgeAudioDriver_AddRef(driver);
        *interface = driver;
        return S_OK;
    }
    
    CFRelease(requestedUUID);
    *interface = NULL;
    return E_NOINTERFACE;
}

static ULONG SurgeAudioDriver_AddRef(void* driver) {
    return ++gDriverRefCount;
}

static ULONG SurgeAudioDriver_Release(void* driver) {
    if (gDriverRefCount > 0) {
        gDriverRefCount--;
    }
    if (gDriverRefCount == 0) {
        CleanupDriverState();
    }
    return gDriverRefCount;
}

#pragma mark - Plugin Operations

static OSStatus SurgeAudioDriver_Initialize(AudioServerPlugInDriverRef driver, AudioServerPlugInHostRef host) {
    LOG_INFO("SurgeAudioDriver: Initialize");
    gDriverState.hostRef = host;
    return kAudioHardwareNoError;
}

static OSStatus SurgeAudioDriver_CreateDevice(AudioServerPlugInDriverRef driver, CFDictionaryRef description, const AudioServerPlugInClientInfo* clientInfo, AudioObjectID* outDeviceID) {
    LOG_INFO("SurgeAudioDriver: CreateDevice");
    *outDeviceID = kObjectID_Device;
    return kAudioHardwareNoError;
}

static OSStatus SurgeAudioDriver_DestroyDevice(AudioServerPlugInDriverRef driver, AudioObjectID deviceID) {
    LOG_INFO("SurgeAudioDriver: DestroyDevice");
    return kAudioHardwareNoError;
}

static OSStatus SurgeAudioDriver_AddDeviceClient(AudioServerPlugInDriverRef driver, AudioObjectID deviceID, const AudioServerPlugInClientInfo* clientInfo) {
    LOG_DEBUG("SurgeAudioDriver: AddDeviceClient");
    return kAudioHardwareNoError;
}

static OSStatus SurgeAudioDriver_RemoveDeviceClient(AudioServerPlugInDriverRef driver, AudioObjectID deviceID, const AudioServerPlugInClientInfo* clientInfo) {
    LOG_DEBUG("SurgeAudioDriver: RemoveDeviceClient");
    return kAudioHardwareNoError;
}

static OSStatus SurgeAudioDriver_PerformDeviceConfigurationChange(AudioServerPlugInDriverRef driver, AudioObjectID deviceID, UInt64 changeAction, void* changeInfo) {
    return kAudioHardwareNoError;
}

static OSStatus SurgeAudioDriver_AbortDeviceConfigurationChange(AudioServerPlugInDriverRef driver, AudioObjectID deviceID, UInt64 changeAction, void* changeInfo) {
    return kAudioHardwareNoError;
}

#pragma mark - Property Operations

static Boolean SurgeAudioDriver_HasProperty(AudioServerPlugInDriverRef driver, AudioObjectID objectID, pid_t clientPID, const AudioObjectPropertyAddress* address) {
    Boolean hasProperty = false;
    
    switch (objectID) {
        case kObjectID_PlugIn:
            switch (address->mSelector) {
                case kAudioObjectPropertyBaseClass:
                case kAudioObjectPropertyClass:
                case kAudioObjectPropertyOwner:
                case kAudioObjectPropertyManufacturer:
                case kAudioObjectPropertyOwnedObjects:
                case kAudioPlugInPropertyDeviceList:
                case kAudioPlugInPropertyTranslateUIDToDevice:
                case kAudioPlugInPropertyResourceBundle:
                    hasProperty = true;
                    break;
            }
            break;
            
        case kObjectID_Device:
            switch (address->mSelector) {
                case kAudioObjectPropertyBaseClass:
                case kAudioObjectPropertyClass:
                case kAudioObjectPropertyOwner:
                case kAudioObjectPropertyName:
                case kAudioObjectPropertyManufacturer:
                case kAudioDevicePropertyDeviceUID:
                case kAudioDevicePropertyModelUID:
                case kAudioDevicePropertyTransportType:
                case kAudioDevicePropertyRelatedDevices:
                case kAudioDevicePropertyClockDomain:
                case kAudioDevicePropertyDeviceIsAlive:
                case kAudioDevicePropertyDeviceIsRunning:
                case kAudioDevicePropertyDeviceCanBeDefaultDevice:
                case kAudioDevicePropertyDeviceCanBeDefaultSystemDevice:
                case kAudioDevicePropertyLatency:
                case kAudioDevicePropertyStreams:
                case kAudioObjectPropertyControlList:
                case kAudioDevicePropertySafetyOffset:
                case kAudioDevicePropertyNominalSampleRate:
                case kAudioDevicePropertyAvailableNominalSampleRates:
                case kAudioDevicePropertyIsHidden:
                case kAudioDevicePropertyZeroTimeStampPeriod:
                case kAudioDevicePropertyIcon:
                    hasProperty = true;
                    break;
            }
            break;
            
        case kObjectID_Stream_Input:
        case kObjectID_Stream_Output:
            switch (address->mSelector) {
                case kAudioObjectPropertyBaseClass:
                case kAudioObjectPropertyClass:
                case kAudioObjectPropertyOwner:
                case kAudioStreamPropertyIsActive:
                case kAudioStreamPropertyDirection:
                case kAudioStreamPropertyTerminalType:
                case kAudioStreamPropertyStartingChannel:
                case kAudioStreamPropertyLatency:
                case kAudioStreamPropertyVirtualFormat:
                case kAudioStreamPropertyPhysicalFormat:
                case kAudioStreamPropertyAvailableVirtualFormats:
                case kAudioStreamPropertyAvailablePhysicalFormats:
                    hasProperty = true;
                    break;
            }
            break;
            
        case kObjectID_Volume_Input_Master:
        case kObjectID_Volume_Output_Master:
            switch (address->mSelector) {
                case kAudioObjectPropertyBaseClass:
                case kAudioObjectPropertyClass:
                case kAudioObjectPropertyOwner:
                case kAudioObjectPropertyOwnedObjects:
                case kAudioControlPropertyScope:
                case kAudioControlPropertyElement:
                case kAudioLevelControlPropertyScalarValue:
                case kAudioLevelControlPropertyDecibelValue:
                case kAudioLevelControlPropertyDecibelRange:
                case kAudioLevelControlPropertyConvertScalarToDecibels:
                case kAudioLevelControlPropertyConvertDecibelsToScalar:
                    hasProperty = true;
                    break;
            }
            break;
    }
    
    return hasProperty;
}

static OSStatus SurgeAudioDriver_IsPropertySettable(AudioServerPlugInDriverRef driver, AudioObjectID objectID, pid_t clientPID, const AudioObjectPropertyAddress* address, Boolean* outIsSettable) {
    *outIsSettable = false;
    
    switch (objectID) {
        case kObjectID_Device:
            switch (address->mSelector) {
                case kAudioDevicePropertyNominalSampleRate:
                    *outIsSettable = true;
                    break;
            }
            break;
            
        case kObjectID_Stream_Input:
        case kObjectID_Stream_Output:
            switch (address->mSelector) {
                case kAudioStreamPropertyIsActive:
                case kAudioStreamPropertyVirtualFormat:
                case kAudioStreamPropertyPhysicalFormat:
                    *outIsSettable = true;
                    break;
            }
            break;
            
        case kObjectID_Volume_Input_Master:
        case kObjectID_Volume_Output_Master:
            switch (address->mSelector) {
                case kAudioLevelControlPropertyScalarValue:
                case kAudioLevelControlPropertyDecibelValue:
                    *outIsSettable = true;
                    break;
            }
            break;
    }
    
    return kAudioHardwareNoError;
}

static OSStatus SurgeAudioDriver_GetPropertyDataSize(AudioServerPlugInDriverRef driver, AudioObjectID objectID, pid_t clientPID, const AudioObjectPropertyAddress* address, UInt32 qualifierDataSize, const void* qualifierData, UInt32* outDataSize) {
    OSStatus result = kAudioHardwareNoError;
    
    switch (objectID) {
        case kObjectID_PlugIn:
            switch (address->mSelector) {
                case kAudioObjectPropertyBaseClass:
                case kAudioObjectPropertyClass:
                case kAudioObjectPropertyOwner:
                    *outDataSize = sizeof(AudioClassID);
                    break;
                case kAudioObjectPropertyManufacturer:
                    *outDataSize = sizeof(CFStringRef);
                    break;
                case kAudioObjectPropertyOwnedObjects:
                case kAudioPlugInPropertyDeviceList:
                    *outDataSize = sizeof(AudioObjectID);
                    break;
                case kAudioPlugInPropertyTranslateUIDToDevice:
                    *outDataSize = sizeof(AudioObjectID);
                    break;
                case kAudioPlugInPropertyResourceBundle:
                    *outDataSize = sizeof(CFStringRef);
                    break;
                default:
                    result = kAudioHardwareUnknownPropertyError;
                    break;
            }
            break;
            
        case kObjectID_Device:
            switch (address->mSelector) {
                case kAudioObjectPropertyBaseClass:
                case kAudioObjectPropertyClass:
                    *outDataSize = sizeof(AudioClassID);
                    break;
                case kAudioObjectPropertyOwner:
                    *outDataSize = sizeof(AudioObjectID);
                    break;
                case kAudioObjectPropertyName:
                case kAudioObjectPropertyManufacturer:
                case kAudioDevicePropertyDeviceUID:
                case kAudioDevicePropertyModelUID:
                    *outDataSize = sizeof(CFStringRef);
                    break;
                case kAudioDevicePropertyTransportType:
                case kAudioDevicePropertyClockDomain:
                    *outDataSize = sizeof(UInt32);
                    break;
                case kAudioDevicePropertyRelatedDevices:
                    *outDataSize = sizeof(AudioObjectID);
                    break;
                case kAudioDevicePropertyDeviceIsAlive:
                case kAudioDevicePropertyDeviceIsRunning:
                case kAudioDevicePropertyDeviceCanBeDefaultDevice:
                case kAudioDevicePropertyDeviceCanBeDefaultSystemDevice:
                case kAudioDevicePropertyIsHidden:
                    *outDataSize = sizeof(UInt32);
                    break;
                case kAudioDevicePropertyLatency:
                case kAudioDevicePropertySafetyOffset:
                case kAudioDevicePropertyZeroTimeStampPeriod:
                    *outDataSize = sizeof(UInt32);
                    break;
                case kAudioDevicePropertyStreams:
                    if (address->mScope == kAudioObjectPropertyScopeInput) {
                        *outDataSize = sizeof(AudioObjectID);
                    } else if (address->mScope == kAudioObjectPropertyScopeOutput) {
                        *outDataSize = sizeof(AudioObjectID);
                    } else {
                        *outDataSize = 2 * sizeof(AudioObjectID);
                    }
                    break;
                case kAudioObjectPropertyControlList:
                    *outDataSize = 4 * sizeof(AudioObjectID);
                    break;
                case kAudioDevicePropertyNominalSampleRate:
                    *outDataSize = sizeof(Float64);
                    break;
                case kAudioDevicePropertyAvailableNominalSampleRates:
                    *outDataSize = 4 * sizeof(AudioValueRange);
                    break;
                case kAudioDevicePropertyIcon:
                    *outDataSize = sizeof(CFURLRef);
                    break;
                default:
                    result = kAudioHardwareUnknownPropertyError;
                    break;
            }
            break;
            
        case kObjectID_Stream_Input:
        case kObjectID_Stream_Output:
            switch (address->mSelector) {
                case kAudioObjectPropertyBaseClass:
                case kAudioObjectPropertyClass:
                    *outDataSize = sizeof(AudioClassID);
                    break;
                case kAudioObjectPropertyOwner:
                    *outDataSize = sizeof(AudioObjectID);
                    break;
                case kAudioStreamPropertyIsActive:
                case kAudioStreamPropertyDirection:
                case kAudioStreamPropertyTerminalType:
                case kAudioStreamPropertyStartingChannel:
                case kAudioStreamPropertyLatency:
                    *outDataSize = sizeof(UInt32);
                    break;
                case kAudioStreamPropertyVirtualFormat:
                case kAudioStreamPropertyPhysicalFormat:
                    *outDataSize = sizeof(AudioStreamBasicDescription);
                    break;
                case kAudioStreamPropertyAvailableVirtualFormats:
                case kAudioStreamPropertyAvailablePhysicalFormats:
                    *outDataSize = 4 * sizeof(AudioStreamRangedDescription);
                    break;
                default:
                    result = kAudioHardwareUnknownPropertyError;
                    break;
            }
            break;
            
        case kObjectID_Volume_Input_Master:
        case kObjectID_Volume_Output_Master:
            switch (address->mSelector) {
                case kAudioObjectPropertyBaseClass:
                case kAudioObjectPropertyClass:
                    *outDataSize = sizeof(AudioClassID);
                    break;
                case kAudioObjectPropertyOwner:
                    *outDataSize = sizeof(AudioObjectID);
                    break;
                case kAudioObjectPropertyOwnedObjects:
                    *outDataSize = 0;
                    break;
                case kAudioControlPropertyScope:
                case kAudioControlPropertyElement:
                    *outDataSize = sizeof(UInt32);
                    break;
                case kAudioLevelControlPropertyScalarValue:
                case kAudioLevelControlPropertyDecibelValue:
                case kAudioLevelControlPropertyConvertScalarToDecibels:
                case kAudioLevelControlPropertyConvertDecibelsToScalar:
                    *outDataSize = sizeof(Float32);
                    break;
                case kAudioLevelControlPropertyDecibelRange:
                    *outDataSize = sizeof(AudioValueRange);
                    break;
                default:
                    result = kAudioHardwareUnknownPropertyError;
                    break;
            }
            break;
            
        default:
            result = kAudioHardwareBadObjectError;
            break;
    }
    
    return result;
}

static OSStatus SurgeAudioDriver_GetPropertyData(AudioServerPlugInDriverRef driver, AudioObjectID objectID, pid_t clientPID, const AudioObjectPropertyAddress* address, UInt32 qualifierDataSize, const void* qualifierData, UInt32 inDataSize, UInt32* outDataSize, void* outData) {
    OSStatus result = kAudioHardwareNoError;
    
    switch (objectID) {
        case kObjectID_PlugIn:
            switch (address->mSelector) {
                case kAudioObjectPropertyBaseClass:
                    *((AudioClassID*)outData) = kAudioObjectClassID;
                    *outDataSize = sizeof(AudioClassID);
                    break;
                case kAudioObjectPropertyClass:
                    *((AudioClassID*)outData) = kAudioPlugInClassID;
                    *outDataSize = sizeof(AudioClassID);
                    break;
                case kAudioObjectPropertyOwner:
                    *((AudioObjectID*)outData) = kAudioObjectUnknown;
                    *outDataSize = sizeof(AudioObjectID);
                    break;
                case kAudioObjectPropertyManufacturer:
                    *((CFStringRef*)outData) = CFSTR(kDevice_Manufacturer);
                    *outDataSize = sizeof(CFStringRef);
                    break;
                case kAudioObjectPropertyOwnedObjects:
                case kAudioPlugInPropertyDeviceList:
                    *((AudioObjectID*)outData) = kObjectID_Device;
                    *outDataSize = sizeof(AudioObjectID);
                    break;
                case kAudioPlugInPropertyTranslateUIDToDevice:
                    if (qualifierData && CFStringCompare((CFStringRef)qualifierData, CFSTR(kDevice_UID), 0) == kCFCompareEqualTo) {
                        *((AudioObjectID*)outData) = kObjectID_Device;
                    } else {
                        *((AudioObjectID*)outData) = kAudioObjectUnknown;
                    }
                    *outDataSize = sizeof(AudioObjectID);
                    break;
                case kAudioPlugInPropertyResourceBundle:
                    *((CFStringRef*)outData) = CFSTR("");
                    *outDataSize = sizeof(CFStringRef);
                    break;
                default:
                    result = kAudioHardwareUnknownPropertyError;
                    break;
            }
            break;
            
        case kObjectID_Device:
            switch (address->mSelector) {
                case kAudioObjectPropertyBaseClass:
                    *((AudioClassID*)outData) = kAudioObjectClassID;
                    *outDataSize = sizeof(AudioClassID);
                    break;
                case kAudioObjectPropertyClass:
                    *((AudioClassID*)outData) = kAudioDeviceClassID;
                    *outDataSize = sizeof(AudioClassID);
                    break;
                case kAudioObjectPropertyOwner:
                    *((AudioObjectID*)outData) = kObjectID_PlugIn;
                    *outDataSize = sizeof(AudioObjectID);
                    break;
                case kAudioObjectPropertyName:
                    *((CFStringRef*)outData) = CFSTR(kDevice_Name);
                    *outDataSize = sizeof(CFStringRef);
                    break;
                case kAudioObjectPropertyManufacturer:
                    *((CFStringRef*)outData) = CFSTR(kDevice_Manufacturer);
                    *outDataSize = sizeof(CFStringRef);
                    break;
                case kAudioDevicePropertyDeviceUID:
                    *((CFStringRef*)outData) = CFSTR(kDevice_UID);
                    *outDataSize = sizeof(CFStringRef);
                    break;
                case kAudioDevicePropertyModelUID:
                    *((CFStringRef*)outData) = CFSTR(kDevice_ModelUID);
                    *outDataSize = sizeof(CFStringRef);
                    break;
                case kAudioDevicePropertyTransportType:
                    *((UInt32*)outData) = kAudioDeviceTransportTypeVirtual;
                    *outDataSize = sizeof(UInt32);
                    break;
                case kAudioDevicePropertyRelatedDevices:
                    *((AudioObjectID*)outData) = kObjectID_Device;
                    *outDataSize = sizeof(AudioObjectID);
                    break;
                case kAudioDevicePropertyClockDomain:
                    *((UInt32*)outData) = 0;
                    *outDataSize = sizeof(UInt32);
                    break;
                case kAudioDevicePropertyDeviceIsAlive:
                    *((UInt32*)outData) = 1;
                    *outDataSize = sizeof(UInt32);
                    break;
                case kAudioDevicePropertyDeviceIsRunning:
                    *((UInt32*)outData) = gDriverState.deviceIsRunning ? 1 : 0;
                    *outDataSize = sizeof(UInt32);
                    break;
                case kAudioDevicePropertyDeviceCanBeDefaultDevice:
                    *((UInt32*)outData) = 1;
                    *outDataSize = sizeof(UInt32);
                    break;
                case kAudioDevicePropertyDeviceCanBeDefaultSystemDevice:
                    *((UInt32*)outData) = 1;
                    *outDataSize = sizeof(UInt32);
                    break;
                case kAudioDevicePropertyIsHidden:
                    *((UInt32*)outData) = 0;
                    *outDataSize = sizeof(UInt32);
                    break;
                case kAudioDevicePropertyLatency:
                    *((UInt32*)outData) = 0;
                    *outDataSize = sizeof(UInt32);
                    break;
                case kAudioDevicePropertySafetyOffset:
                    *((UInt32*)outData) = 0;
                    *outDataSize = sizeof(UInt32);
                    break;
                case kAudioDevicePropertyZeroTimeStampPeriod:
                    *((UInt32*)outData) = kLatency_Frame_Size;
                    *outDataSize = sizeof(UInt32);
                    break;
                case kAudioDevicePropertyStreams:
                    if (address->mScope == kAudioObjectPropertyScopeInput) {
                        *((AudioObjectID*)outData) = kObjectID_Stream_Input;
                        *outDataSize = sizeof(AudioObjectID);
                    } else if (address->mScope == kAudioObjectPropertyScopeOutput) {
                        *((AudioObjectID*)outData) = kObjectID_Stream_Output;
                        *outDataSize = sizeof(AudioObjectID);
                    } else {
                        ((AudioObjectID*)outData)[0] = kObjectID_Stream_Input;
                        ((AudioObjectID*)outData)[1] = kObjectID_Stream_Output;
                        *outDataSize = 2 * sizeof(AudioObjectID);
                    }
                    break;
                case kAudioObjectPropertyControlList:
                    ((AudioObjectID*)outData)[0] = kObjectID_Volume_Input_Master;
                    ((AudioObjectID*)outData)[1] = kObjectID_Volume_Output_Master;
                    ((AudioObjectID*)outData)[2] = kObjectID_Mute_Input_Master;
                    ((AudioObjectID*)outData)[3] = kObjectID_Mute_Output_Master;
                    *outDataSize = 4 * sizeof(AudioObjectID);
                    break;
                case kAudioDevicePropertyNominalSampleRate:
                    *((Float64*)outData) = gDriverState.sampleRate;
                    *outDataSize = sizeof(Float64);
                    break;
                case kAudioDevicePropertyAvailableNominalSampleRates:
                    ((AudioValueRange*)outData)[0].mMinimum = 44100.0;
                    ((AudioValueRange*)outData)[0].mMaximum = 44100.0;
                    ((AudioValueRange*)outData)[1].mMinimum = 48000.0;
                    ((AudioValueRange*)outData)[1].mMaximum = 48000.0;
                    ((AudioValueRange*)outData)[2].mMinimum = 96000.0;
                    ((AudioValueRange*)outData)[2].mMaximum = 96000.0;
                    ((AudioValueRange*)outData)[3].mMinimum = 192000.0;
                    ((AudioValueRange*)outData)[3].mMaximum = 192000.0;
                    *outDataSize = 4 * sizeof(AudioValueRange);
                    break;
                default:
                    result = kAudioHardwareUnknownPropertyError;
                    break;
            }
            break;
            
        case kObjectID_Stream_Input:
        case kObjectID_Stream_Output:
            switch (address->mSelector) {
                case kAudioObjectPropertyBaseClass:
                    *((AudioClassID*)outData) = kAudioObjectClassID;
                    *outDataSize = sizeof(AudioClassID);
                    break;
                case kAudioObjectPropertyClass:
                    *((AudioClassID*)outData) = kAudioStreamClassID;
                    *outDataSize = sizeof(AudioClassID);
                    break;
                case kAudioObjectPropertyOwner:
                    *((AudioObjectID*)outData) = kObjectID_Device;
                    *outDataSize = sizeof(AudioObjectID);
                    break;
                case kAudioStreamPropertyIsActive:
                    if (objectID == kObjectID_Stream_Input) {
                        *((UInt32*)outData) = gDriverState.inputStreamIsActive ? 1 : 0;
                    } else {
                        *((UInt32*)outData) = gDriverState.outputStreamIsActive ? 1 : 0;
                    }
                    *outDataSize = sizeof(UInt32);
                    break;
                case kAudioStreamPropertyDirection:
                    *((UInt32*)outData) = (objectID == kObjectID_Stream_Input) ? 1 : 0;
                    *outDataSize = sizeof(UInt32);
                    break;
                case kAudioStreamPropertyTerminalType:
                    *((UInt32*)outData) = (objectID == kObjectID_Stream_Input) ? kAudioStreamTerminalTypeMicrophone : kAudioStreamTerminalTypeSpeaker;
                    *outDataSize = sizeof(UInt32);
                    break;
                case kAudioStreamPropertyStartingChannel:
                    *((UInt32*)outData) = 1;
                    *outDataSize = sizeof(UInt32);
                    break;
                case kAudioStreamPropertyLatency:
                    *((UInt32*)outData) = 0;
                    *outDataSize = sizeof(UInt32);
                    break;
                case kAudioStreamPropertyVirtualFormat:
                case kAudioStreamPropertyPhysicalFormat: {
                    AudioStreamBasicDescription* format = (AudioStreamBasicDescription*)outData;
                    format->mSampleRate = gDriverState.sampleRate;
                    format->mFormatID = kAudioFormatLinearPCM;
                    format->mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagsNativeEndian | kAudioFormatFlagIsPacked;
                    format->mBytesPerPacket = kBytesPerFrame;
                    format->mFramesPerPacket = 1;
                    format->mBytesPerFrame = kBytesPerFrame;
                    format->mChannelsPerFrame = kChannelsPerFrame;
                    format->mBitsPerChannel = kBitsPerChannel;
                    *outDataSize = sizeof(AudioStreamBasicDescription);
                    break;
                }
                case kAudioStreamPropertyAvailableVirtualFormats:
                case kAudioStreamPropertyAvailablePhysicalFormats: {
                    AudioStreamRangedDescription* formats = (AudioStreamRangedDescription*)outData;
                    Float64 sampleRates[] = {44100.0, 48000.0, 96000.0, 192000.0};
                    for (int i = 0; i < 4; i++) {
                        formats[i].mFormat.mSampleRate = sampleRates[i];
                        formats[i].mFormat.mFormatID = kAudioFormatLinearPCM;
                        formats[i].mFormat.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagsNativeEndian | kAudioFormatFlagIsPacked;
                        formats[i].mFormat.mBytesPerPacket = kBytesPerFrame;
                        formats[i].mFormat.mFramesPerPacket = 1;
                        formats[i].mFormat.mBytesPerFrame = kBytesPerFrame;
                        formats[i].mFormat.mChannelsPerFrame = kChannelsPerFrame;
                        formats[i].mFormat.mBitsPerChannel = kBitsPerChannel;
                        formats[i].mSampleRateRange.mMinimum = sampleRates[i];
                        formats[i].mSampleRateRange.mMaximum = sampleRates[i];
                    }
                    *outDataSize = 4 * sizeof(AudioStreamRangedDescription);
                    break;
                }
                default:
                    result = kAudioHardwareUnknownPropertyError;
                    break;
            }
            break;
            
        case kObjectID_Volume_Input_Master:
        case kObjectID_Volume_Output_Master:
            switch (address->mSelector) {
                case kAudioObjectPropertyBaseClass:
                    *((AudioClassID*)outData) = kAudioControlClassID;
                    *outDataSize = sizeof(AudioClassID);
                    break;
                case kAudioObjectPropertyClass:
                    *((AudioClassID*)outData) = kAudioVolumeControlClassID;
                    *outDataSize = sizeof(AudioClassID);
                    break;
                case kAudioObjectPropertyOwner:
                    *((AudioObjectID*)outData) = kObjectID_Device;
                    *outDataSize = sizeof(AudioObjectID);
                    break;
                case kAudioObjectPropertyOwnedObjects:
                    *outDataSize = 0;
                    break;
                case kAudioControlPropertyScope:
                    *((AudioObjectPropertyScope*)outData) = (objectID == kObjectID_Volume_Input_Master) ? kAudioObjectPropertyScopeInput : kAudioObjectPropertyScopeOutput;
                    *outDataSize = sizeof(AudioObjectPropertyScope);
                    break;
                case kAudioControlPropertyElement:
                    *((AudioObjectPropertyElement*)outData) = kAudioObjectPropertyElementMain;
                    *outDataSize = sizeof(AudioObjectPropertyElement);
                    break;
                case kAudioLevelControlPropertyScalarValue:
                    *((Float32*)outData) = (objectID == kObjectID_Volume_Input_Master) ? gDriverState.inputVolume : gDriverState.outputVolume;
                    *outDataSize = sizeof(Float32);
                    break;
                case kAudioLevelControlPropertyDecibelValue: {
                    Float32 volume = (objectID == kObjectID_Volume_Input_Master) ? gDriverState.inputVolume : gDriverState.outputVolume;
                    *((Float32*)outData) = (volume > 0.0f) ? (20.0f * log10f(volume)) : -96.0f;
                    *outDataSize = sizeof(Float32);
                    break;
                }
                case kAudioLevelControlPropertyDecibelRange:
                    ((AudioValueRange*)outData)->mMinimum = -96.0;
                    ((AudioValueRange*)outData)->mMaximum = 0.0;
                    *outDataSize = sizeof(AudioValueRange);
                    break;
                default:
                    result = kAudioHardwareUnknownPropertyError;
                    break;
            }
            break;
            
        default:
            result = kAudioHardwareBadObjectError;
            break;
    }
    
    return result;
}

static OSStatus SurgeAudioDriver_SetPropertyData(AudioServerPlugInDriverRef driver, AudioObjectID objectID, pid_t clientPID, const AudioObjectPropertyAddress* address, UInt32 qualifierDataSize, const void* qualifierData, UInt32 inDataSize, const void* inData) {
    OSStatus result = kAudioHardwareNoError;
    
    switch (objectID) {
        case kObjectID_Device:
            switch (address->mSelector) {
                case kAudioDevicePropertyNominalSampleRate:
                    gDriverState.sampleRate = *((Float64*)inData);
                    // Recalculate timing
                    mach_timebase_info_data_t timebase;
                    mach_timebase_info(&timebase);
                    Float64 nsPerTick = (Float64)timebase.numer / (Float64)timebase.denom;
                    Float64 nsPerFrame = 1000000000.0 / gDriverState.sampleRate;
                    gDriverState.ticksPerFrame = (UInt64)(nsPerFrame / nsPerTick);
                    break;
                default:
                    result = kAudioHardwareUnknownPropertyError;
                    break;
            }
            break;
            
        case kObjectID_Stream_Input:
            switch (address->mSelector) {
                case kAudioStreamPropertyIsActive:
                    gDriverState.inputStreamIsActive = (*((UInt32*)inData) != 0);
                    break;
                default:
                    result = kAudioHardwareUnknownPropertyError;
                    break;
            }
            break;
            
        case kObjectID_Stream_Output:
            switch (address->mSelector) {
                case kAudioStreamPropertyIsActive:
                    gDriverState.outputStreamIsActive = (*((UInt32*)inData) != 0);
                    break;
                default:
                    result = kAudioHardwareUnknownPropertyError;
                    break;
            }
            break;
            
        case kObjectID_Volume_Input_Master:
            switch (address->mSelector) {
                case kAudioLevelControlPropertyScalarValue:
                    gDriverState.inputVolume = *((Float32*)inData);
                    break;
                case kAudioLevelControlPropertyDecibelValue: {
                    Float32 dB = *((Float32*)inData);
                    gDriverState.inputVolume = powf(10.0f, dB / 20.0f);
                    break;
                }
                default:
                    result = kAudioHardwareUnknownPropertyError;
                    break;
            }
            break;
            
        case kObjectID_Volume_Output_Master:
            switch (address->mSelector) {
                case kAudioLevelControlPropertyScalarValue:
                    gDriverState.outputVolume = *((Float32*)inData);
                    break;
                case kAudioLevelControlPropertyDecibelValue: {
                    Float32 dB = *((Float32*)inData);
                    gDriverState.outputVolume = powf(10.0f, dB / 20.0f);
                    break;
                }
                default:
                    result = kAudioHardwareUnknownPropertyError;
                    break;
            }
            break;
            
        default:
            result = kAudioHardwareBadObjectError;
            break;
    }
    
    return result;
}

#pragma mark - IO Operations

static OSStatus SurgeAudioDriver_StartIO(AudioServerPlugInDriverRef driver, AudioObjectID deviceID, UInt32 clientID) {
    LOG_INFO("SurgeAudioDriver: StartIO");
    
    if (!gDriverState.deviceIsRunning) {
        gDriverState.anchorHostTime = mach_absolute_time();
        gDriverState.anchorSampleTime = 0;
        gDriverState.deviceIsRunning = true;
        
        // Clear ring buffer
        pthread_mutex_lock(&gDriverState.ringBufferMutex);
        memset(gDriverState.ringBuffer, 0, kRingBufferSize * sizeof(Float32));
        gDriverState.ringBufferWritePosition = 0;
        gDriverState.ringBufferReadPosition = 0;
        pthread_mutex_unlock(&gDriverState.ringBufferMutex);
    }
    
    return kAudioHardwareNoError;
}

static OSStatus SurgeAudioDriver_StopIO(AudioServerPlugInDriverRef driver, AudioObjectID deviceID, UInt32 clientID) {
    LOG_INFO("SurgeAudioDriver: StopIO");
    gDriverState.deviceIsRunning = false;
    return kAudioHardwareNoError;
}

static OSStatus SurgeAudioDriver_GetZeroTimeStamp(AudioServerPlugInDriverRef driver, AudioObjectID deviceID, UInt32 clientID, Float64* outSampleTime, UInt64* outHostTime, UInt64* outSeed) {
    UInt64 currentHostTime = mach_absolute_time();
    UInt64 elapsedHostTime = currentHostTime - gDriverState.anchorHostTime;
    Float64 elapsedSampleTime = (Float64)elapsedHostTime / (Float64)gDriverState.ticksPerFrame;
    
    // Align to zero timestamp period
    UInt64 periods = (UInt64)(elapsedSampleTime / kLatency_Frame_Size);
    
    *outSampleTime = periods * kLatency_Frame_Size;
    *outHostTime = gDriverState.anchorHostTime + (periods * kLatency_Frame_Size * gDriverState.ticksPerFrame);
    *outSeed = 1;
    
    return kAudioHardwareNoError;
}

static OSStatus SurgeAudioDriver_WillDoIOOperation(AudioServerPlugInDriverRef driver, AudioObjectID deviceID, UInt32 clientID, UInt32 operationID, Boolean* outWillDo, Boolean* outWillDoInPlace) {
    switch (operationID) {
        case kAudioServerPlugInIOOperationReadInput:
        case kAudioServerPlugInIOOperationWriteMix:
            *outWillDo = true;
            *outWillDoInPlace = true;
            break;
        default:
            *outWillDo = false;
            *outWillDoInPlace = true;
            break;
    }
    return kAudioHardwareNoError;
}

static OSStatus SurgeAudioDriver_BeginIOOperation(AudioServerPlugInDriverRef driver, AudioObjectID deviceID, UInt32 clientID, UInt32 operationID, UInt32 ioBufferFrameSize, const AudioServerPlugInIOCycleInfo* ioCycleInfo) {
    return kAudioHardwareNoError;
}

static OSStatus SurgeAudioDriver_DoIOOperation(AudioServerPlugInDriverRef driver, AudioObjectID deviceID, AudioObjectID streamID, UInt32 clientID, UInt32 operationID, UInt32 ioBufferFrameSize, const AudioServerPlugInIOCycleInfo* ioCycleInfo, void* ioMainBuffer, void* ioSecondaryBuffer) {
    OSStatus result = kAudioHardwareNoError;
    Float32* buffer = (Float32*)ioMainBuffer;
    UInt32 numSamples = ioBufferFrameSize * kChannelsPerFrame;
    
    switch (operationID) {
        case kAudioServerPlugInIOOperationWriteMix:
            // Output: Write audio to ring buffer
            pthread_mutex_lock(&gDriverState.ringBufferMutex);
            for (UInt32 i = 0; i < numSamples; i++) {
                gDriverState.ringBuffer[gDriverState.ringBufferWritePosition] = buffer[i] * gDriverState.outputVolume;
                gDriverState.ringBufferWritePosition = (gDriverState.ringBufferWritePosition + 1) % kRingBufferSize;
            }
            pthread_mutex_unlock(&gDriverState.ringBufferMutex);
            break;
            
        case kAudioServerPlugInIOOperationReadInput:
            // Input: Read audio from ring buffer (loopback)
            pthread_mutex_lock(&gDriverState.ringBufferMutex);
            for (UInt32 i = 0; i < numSamples; i++) {
                buffer[i] = gDriverState.ringBuffer[gDriverState.ringBufferReadPosition] * gDriverState.inputVolume;
                gDriverState.ringBufferReadPosition = (gDriverState.ringBufferReadPosition + 1) % kRingBufferSize;
            }
            pthread_mutex_unlock(&gDriverState.ringBufferMutex);
            break;
            
        default:
            break;
    }
    
    return result;
}

static OSStatus SurgeAudioDriver_EndIOOperation(AudioServerPlugInDriverRef driver, AudioObjectID deviceID, UInt32 clientID, UInt32 operationID, UInt32 ioBufferFrameSize, const AudioServerPlugInIOCycleInfo* ioCycleInfo) {
    return kAudioHardwareNoError;
}
