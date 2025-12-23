//
// audio_driver_properties.c - Complete property handling for HAL AudioServerPlugIn
// Handles all CoreAudio property queries and device information
//

#include "audio_driver.h"
#include <CoreFoundation/CoreFoundation.h>
#include <string.h>

// External reference to driver state
extern AudioDriverState g_driver_state;

// Device UID (unique identifier for the virtual device)
#define DEVICE_UID "GrowhutAudioDriver:VirtualOutput"
#define DEVICE_NAME "Growhut Audio Driver"
#define MANUFACTURER_NAME "Growhut"

// Property helper macros
#define IsPropertyInScope(in_address, in_scope) \
    ((in_address)->mScope == (in_scope) || (in_address)->mScope == kAudioObjectPropertyScopeGlobal)

#define IsPropertyInElement(in_address, in_element) \
    ((in_address)->mElement == (in_element) || (in_address)->mElement == kAudioObjectPropertyElementMain)

// Forward declarations
static OSStatus GetPlugInPropertyData(AudioServerPlugInDriverRef in_driver, AudioObjectID in_object_id, const AudioObjectPropertyAddress* in_address, UInt32* out_data_size, void* out_data);
static OSStatus GetDevicePropertyData(AudioServerPlugInDriverRef in_driver, AudioObjectID in_object_id, const AudioObjectPropertyAddress* in_address, UInt32* out_data_size, void* out_data);
static OSStatus GetStreamPropertyData(AudioServerPlugInDriverRef in_driver, AudioObjectID in_object_id, const AudioObjectPropertyAddress* in_address, UInt32* out_data_size, void* out_data);
static Boolean HasPlugInProperty(AudioObjectID in_object_id, const AudioObjectPropertyAddress* in_address);
static Boolean HasDeviceProperty(AudioObjectID in_object_id, const AudioObjectPropertyAddress* in_address);
static Boolean HasStreamProperty(AudioObjectID in_object_id, const AudioObjectPropertyAddress* in_address);
static Boolean IsPlugInPropertySettable(AudioObjectID in_object_id, const AudioObjectPropertyAddress* in_address);
static Boolean IsDevicePropertySettable(AudioObjectID in_object_id, const AudioObjectPropertyAddress* in_address);
static Boolean IsStreamPropertySettable(AudioObjectID in_object_id, const AudioObjectPropertyAddress* in_address);

#pragma mark - Property Has/IsSettable

OSStatus AudioDriver_HasProperty(
    AudioServerPlugInDriverRef in_driver,
    AudioObjectID in_object_id,
    pid_t in_client_process_id,
    const AudioObjectPropertyAddress* in_address,
    Boolean* out_is_settable) {
    
    if (!in_address) {
        return kAudioHardwareIllegalOperationError;
    }
    
    Boolean has_property = false;
    
    // Determine which object this property belongs to
    if (in_object_id == kAudioObjectPlugInObject) {
        has_property = HasPlugInProperty(in_object_id, in_address);
    } else if (in_object_id == g_driver_state.device_object_id) {
        has_property = HasDeviceProperty(in_object_id, in_address);
    } else {
        // Assume stream object
        has_property = HasStreamProperty(in_object_id, in_address);
    }
    
    if (out_is_settable) {
        *out_is_settable = false;
        if (has_property) {
            if (in_object_id == kAudioObjectPlugInObject) {
                *out_is_settable = IsPlugInPropertySettable(in_object_id, in_address);
            } else if (in_object_id == g_driver_state.device_object_id) {
                *out_is_settable = IsDevicePropertySettable(in_object_id, in_address);
            } else {
                *out_is_settable = IsStreamPropertySettable(in_object_id, in_address);
            }
        }
    }
    
    return has_property ? noErr : kAudioHardwareUnknownPropertyError;
}

OSStatus AudioDriver_IsPropertySettable(
    AudioServerPlugInDriverRef in_driver,
    AudioObjectID in_object_id,
    pid_t in_client_process_id,
    const AudioObjectPropertyAddress* in_address,
    Boolean* out_is_settable) {
    
    if (!in_address || !out_is_settable) {
        return kAudioHardwareIllegalOperationError;
    }
    
    *out_is_settable = false;
    
    if (in_object_id == kAudioObjectPlugInObject) {
        *out_is_settable = IsPlugInPropertySettable(in_object_id, in_address);
    } else if (in_object_id == g_driver_state.device_object_id) {
        *out_is_settable = IsDevicePropertySettable(in_object_id, in_address);
    } else {
        *out_is_settable = IsStreamPropertySettable(in_object_id, in_address);
    }
    
    return noErr;
}

#pragma mark - Property Data Size

OSStatus AudioDriver_GetPropertyDataSize(
    AudioServerPlugInDriverRef in_driver,
    AudioObjectID in_object_id,
    pid_t in_client_process_id,
    const AudioObjectPropertyAddress* in_address,
    UInt32 in_qualifier_data_size,
    const void* in_qualifier_data,
    UInt32* out_data_size) {
    
    if (!in_address || !out_data_size) {
        return kAudioHardwareIllegalOperationError;
    }
    
    OSStatus status = noErr;
    
    // Get property data size based on object type
    if (in_object_id == kAudioObjectPlugInObject) {
        status = GetPlugInPropertyData(in_driver, in_object_id, in_address, out_data_size, NULL);
    } else if (in_object_id == g_driver_state.device_object_id) {
        status = GetDevicePropertyData(in_driver, in_object_id, in_address, out_data_size, NULL);
    } else {
        status = GetStreamPropertyData(in_driver, in_object_id, in_address, out_data_size, NULL);
    }
    
    return status;
}

#pragma mark - Property Data Get/Set

OSStatus AudioDriver_GetPropertyData(
    AudioServerPlugInDriverRef in_driver,
    AudioObjectID in_object_id,
    pid_t in_client_process_id,
    const AudioObjectPropertyAddress* in_address,
    UInt32 in_qualifier_data_size,
    const void* in_qualifier_data,
    UInt32 in_data_size,
    UInt32* out_data_size,
    void* out_data) {
    
    if (!in_address) {
        return kAudioHardwareIllegalOperationError;
    }
    
    OSStatus status = noErr;
    
    // Get property data based on object type
    if (in_object_id == kAudioObjectPlugInObject) {
        status = GetPlugInPropertyData(in_driver, in_object_id, in_address, out_data_size, out_data);
    } else if (in_object_id == g_driver_state.device_object_id) {
        status = GetDevicePropertyData(in_driver, in_object_id, in_address, out_data_size, out_data);
    } else {
        status = GetStreamPropertyData(in_driver, in_object_id, in_address, out_data_size, out_data);
    }
    
    return status;
}

OSStatus AudioDriver_SetPropertyData(
    AudioServerPlugInDriverRef in_driver,
    AudioObjectID in_object_id,
    pid_t in_client_process_id,
    const AudioObjectPropertyAddress* in_address,
    UInt32 in_qualifier_data_size,
    const void* in_qualifier_data,
    UInt32 in_data_size,
    const void* in_data) {
    
    if (!in_address) {
        return kAudioHardwareIllegalOperationError;
    }
    
    // Handle settable properties
    if (in_object_id == g_driver_state.device_object_id) {
        if (in_address->mSelector == kAudioDevicePropertyDeviceIsRunning) {
            if (in_data_size >= sizeof(UInt32)) {
                UInt32 is_running = *(const UInt32*)in_data;
                g_driver_state.is_capture_active = (is_running != 0);
                
                if (g_driver_state.shared_memory && g_driver_state.shared_memory->ring_buffer) {
                    atomic_store(&g_driver_state.shared_memory->ring_buffer->active, is_running != 0);
                }
                return noErr;
            }
        }
    }
    
    // Most properties are read-only
    return kAudioHardwareIllegalOperationError;
}

#pragma mark - Plug-in Property Helpers

static Boolean HasPlugInProperty(AudioObjectID in_object_id, const AudioObjectPropertyAddress* in_address) {
    switch (in_address->mSelector) {
        case kAudioObjectPropertyBaseClass:
        case kAudioObjectPropertyClass:
        case kAudioObjectPropertyOwner:
        case kAudioObjectPropertyName:
        case kAudioHardwarePropertyPlugInList:
            return true;
        default:
            return false;
    }
}

static Boolean IsPlugInPropertySettable(AudioObjectID in_object_id, const AudioObjectPropertyAddress* in_address) {
    return false; // All plug-in properties are read-only
}

static OSStatus GetPlugInPropertyData(AudioServerPlugInDriverRef in_driver, AudioObjectID in_object_id, const AudioObjectPropertyAddress* in_address, UInt32* out_data_size, void* out_data) {
    OSStatus status = noErr;
    UInt32 data_size = 0;
    
    switch (in_address->mSelector) {
        case kAudioObjectPropertyBaseClass:
            data_size = sizeof(AudioClassID);
            if (out_data) {
                if (*out_data_size >= data_size) {
                    *(AudioClassID*)out_data = kAudioPlugInClassID;
                    *out_data_size = data_size;
                } else {
                    status = kAudioHardwareBadPropertySizeError;
                }
            } else {
                *out_data_size = data_size;
            }
            break;
            
        case kAudioObjectPropertyClass:
            data_size = sizeof(AudioClassID);
            if (out_data) {
                if (*out_data_size >= data_size) {
                    *(AudioClassID*)out_data = kAudioPlugInClassID;
                    *out_data_size = data_size;
                } else {
                    status = kAudioHardwareBadPropertySizeError;
                }
            } else {
                *out_data_size = data_size;
            }
            break;
            
        case kAudioObjectPropertyOwner:
            data_size = sizeof(AudioObjectID);
            if (out_data) {
                if (*out_data_size >= data_size) {
                    *(AudioObjectID*)out_data = kAudioObjectSystemObject;
                    *out_data_size = data_size;
                } else {
                    status = kAudioHardwareBadPropertySizeError;
                }
            } else {
                *out_data_size = data_size;
            }
            break;
            
        case kAudioObjectPropertyName:
            {
                CFStringRef name = CFStringCreateWithCString(kCFAllocatorDefault, DEVICE_NAME, kCFStringEncodingUTF8);
                data_size = sizeof(CFStringRef);
                if (out_data) {
                    if (*out_data_size >= data_size) {
                        *(CFStringRef*)out_data = name;
                        *out_data_size = data_size;
                    } else {
                        status = kAudioHardwareBadPropertySizeError;
                        CFRelease(name);
                    }
                } else {
                    *out_data_size = data_size;
                    CFRelease(name);
                }
            }
            break;
            
        default:
            status = kAudioHardwareUnknownPropertyError;
            break;
    }
    
    return status;
}

#pragma mark - Device Property Helpers

static Boolean HasDeviceProperty(AudioObjectID in_object_id, const AudioObjectPropertyAddress* in_address) {
    switch (in_address->mSelector) {
        case kAudioObjectPropertyBaseClass:
        case kAudioObjectPropertyClass:
        case kAudioObjectPropertyOwner:
        case kAudioObjectPropertyName:
        case kAudioDevicePropertyDeviceUID:
        case kAudioDevicePropertyModelUID:
        case kAudioDevicePropertyTransportType:
        case kAudioDevicePropertyDeviceIsAlive:
        case kAudioDevicePropertyDeviceIsRunning:
        case kAudioDevicePropertyDeviceCanBeDefaultDevice:
        case kAudioDevicePropertyDeviceCanBeDefaultSystemDevice:
        case kAudioDevicePropertyLatency:
        case kAudioDevicePropertySafetyOffset:
        case kAudioDevicePropertyNominalSampleRate:
        case kAudioDevicePropertyAvailableNominalSampleRates:
        case kAudioDevicePropertyStreams:
            return true;
        default:
            return false;
    }
}

static Boolean IsDevicePropertySettable(AudioObjectID in_object_id, const AudioObjectPropertyAddress* in_address) {
    switch (in_address->mSelector) {
        case kAudioDevicePropertyDeviceIsRunning:
        case kAudioDevicePropertyNominalSampleRate:
            return true;
        default:
            return false;
    }
}

static OSStatus GetDevicePropertyData(AudioServerPlugInDriverRef in_driver, AudioObjectID in_object_id, const AudioObjectPropertyAddress* in_address, UInt32* out_data_size, void* out_data) {
    OSStatus status = noErr;
    UInt32 data_size = 0;
    
    switch (in_address->mSelector) {
        case kAudioObjectPropertyBaseClass:
            data_size = sizeof(AudioClassID);
            if (out_data && *out_data_size >= data_size) {
                *(AudioClassID*)out_data = kAudioDeviceClassID;
                *out_data_size = data_size;
            } else if (out_data_size) {
                *out_data_size = data_size;
            }
            break;
            
        case kAudioObjectPropertyClass:
            data_size = sizeof(AudioClassID);
            if (out_data && *out_data_size >= data_size) {
                *(AudioClassID*)out_data = kAudioDeviceClassID;
                *out_data_size = data_size;
            } else if (out_data_size) {
                *out_data_size = data_size;
            }
            break;
            
        case kAudioDevicePropertyDeviceUID:
            {
                CFStringRef uid = CFStringCreateWithCString(kCFAllocatorDefault, DEVICE_UID, kCFStringEncodingUTF8);
                data_size = sizeof(CFStringRef);
                if (out_data && *out_data_size >= data_size) {
                    *(CFStringRef*)out_data = uid;
                    *out_data_size = data_size;
                } else if (out_data_size) {
                    *out_data_size = data_size;
                    CFRelease(uid);
                }
            }
            break;
            
        case kAudioDevicePropertyNominalSampleRate:
            data_size = sizeof(Float64);
            if (out_data && *out_data_size >= data_size) {
                *(Float64*)out_data = g_driver_state.nominal_sample_rate;
                *out_data_size = data_size;
            } else if (out_data_size) {
                *out_data_size = data_size;
            }
            break;
            
        case kAudioDevicePropertyDeviceIsAlive:
            data_size = sizeof(UInt32);
            if (out_data && *out_data_size >= data_size) {
                *(UInt32*)out_data = g_driver_state.is_device_created ? 1 : 0;
                *out_data_size = data_size;
            } else if (out_data_size) {
                *out_data_size = data_size;
            }
            break;
            
        case kAudioDevicePropertyDeviceIsRunning:
            data_size = sizeof(UInt32);
            if (out_data && *out_data_size >= data_size) {
                *(UInt32*)out_data = g_driver_state.is_capture_active ? 1 : 0;
                *out_data_size = data_size;
            } else if (out_data_size) {
                *out_data_size = data_size;
            }
            break;
            
        case kAudioDevicePropertyDeviceCanBeDefaultDevice:
        case kAudioDevicePropertyDeviceCanBeDefaultSystemDevice:
            data_size = sizeof(UInt32);
            if (out_data && *out_data_size >= data_size) {
                *(UInt32*)out_data = 1; // Yes, can be default
                *out_data_size = data_size;
            } else if (out_data_size) {
                *out_data_size = data_size;
            }
            break;
            
        case kAudioDevicePropertyLatency:
        case kAudioDevicePropertySafetyOffset:
            data_size = sizeof(UInt32);
            if (out_data && *out_data_size >= data_size) {
                *(UInt32*)out_data = 0; // Low latency virtual device
                *out_data_size = data_size;
            } else if (out_data_size) {
                *out_data_size = data_size;
            }
            break;
            
        default:
            status = kAudioHardwareUnknownPropertyError;
            break;
    }
    
    return status;
}

#pragma mark - Stream Property Helpers

static Boolean HasStreamProperty(AudioObjectID in_object_id, const AudioObjectPropertyAddress* in_address) {
    switch (in_address->mSelector) {
        case kAudioObjectPropertyBaseClass:
        case kAudioObjectPropertyClass:
        case kAudioObjectPropertyOwner:
        case kAudioStreamPropertyDirection:
        case kAudioStreamPropertyTerminalType:
        case kAudioStreamPropertyStartingChannel:
        case kAudioStreamPropertyLatency:
            return true;
        default:
            return false;
    }
}

static Boolean IsStreamPropertySettable(AudioObjectID in_object_id, const AudioObjectPropertyAddress* in_address) {
    return false; // All stream properties are read-only
}

static OSStatus GetStreamPropertyData(AudioServerPlugInDriverRef in_driver, AudioObjectID in_object_id, const AudioObjectPropertyAddress* in_address, UInt32* out_data_size, void* out_data) {
    OSStatus status = noErr;
    UInt32 data_size = 0;
    
    switch (in_address->mSelector) {
        case kAudioObjectPropertyBaseClass:
            data_size = sizeof(AudioClassID);
            if (out_data && *out_data_size >= data_size) {
                *(AudioClassID*)out_data = kAudioStreamClassID;
                *out_data_size = data_size;
            } else if (out_data_size) {
                *out_data_size = data_size;
            }
            break;
            
        case kAudioStreamPropertyDirection:
            data_size = sizeof(UInt32);
            if (out_data && *out_data_size >= data_size) {
                *(UInt32*)out_data = 1; // Output stream
                *out_data_size = data_size;
            } else if (out_data_size) {
                *out_data_size = data_size;
            }
            break;
            
        case kAudioStreamPropertyLatency:
            data_size = sizeof(UInt32);
            if (out_data && *out_data_size >= data_size) {
                *(UInt32*)out_data = 0; // Low latency
                *out_data_size = data_size;
            } else if (out_data_size) {
                *out_data_size = data_size;
            }
            break;
            
        default:
            status = kAudioHardwareUnknownPropertyError;
            break;
    }
    
    return status;
}

