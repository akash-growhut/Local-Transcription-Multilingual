//
// audio_driver_complete.c - Complete HAL AudioServerPlugIn Implementation
// This is a more complete implementation with all required HAL interface functions
//

#include "audio_driver.h"
#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/IOCFPlugIn.h>
#include <mach/mach_time.h>
#include <stdlib.h>
#include <string.h>

// Property handlers are implemented in audio_driver_properties.c
// These declarations allow linking
OSStatus AudioDriver_HasProperty(AudioServerPlugInDriverRef, AudioObjectID, pid_t, const AudioObjectPropertyAddress*, Boolean*);
OSStatus AudioDriver_IsPropertySettable(AudioServerPlugInDriverRef, AudioObjectID, pid_t, const AudioObjectPropertyAddress*, Boolean*);
OSStatus AudioDriver_GetPropertyDataSize(AudioServerPlugInDriverRef, AudioObjectID, pid_t, const AudioObjectPropertyAddress*, UInt32, const void*, UInt32*);
OSStatus AudioDriver_GetPropertyData(AudioServerPlugInDriverRef, AudioObjectID, pid_t, const AudioObjectPropertyAddress*, UInt32, const void*, UInt32, UInt32*, void*);
OSStatus AudioDriver_SetPropertyData(AudioServerPlugInDriverRef, AudioObjectID, pid_t, const AudioObjectPropertyAddress*, UInt32, const void*, UInt32, const void*);

// HAL Plug-in UUIDs (these are macros defined in AudioServerPlugIn.h, not variables)
// kAudioServerPlugInTypeUUID is a macro, not a variable

// Forward declarations for required HAL interface functions
static HRESULT QueryInterface(void* in_this, REFIID in_iid, LPVOID* out_interface);
static ULONG AddRef(void* in_this);
static ULONG Release(void* in_this);
static OSStatus CreateDevice(AudioServerPlugInDriverRef in_driver, CFDictionaryRef in_description, const AudioServerPlugInClientInfo* in_client_info, AudioObjectID* out_device_object_id);
static OSStatus DestroyDevice(AudioServerPlugInDriverRef in_driver, AudioObjectID in_device_object_id);
static OSStatus StartIO(AudioServerPlugInDriverRef in_driver, AudioObjectID in_device_object_id, UInt32 in_client_id);
static OSStatus StopIO(AudioServerPlugInDriverRef in_driver, AudioObjectID in_device_object_id, UInt32 in_client_id);
static OSStatus GetZeroTimeStamp(AudioServerPlugInDriverRef in_driver, AudioObjectID in_device_object_id, UInt32 in_client_id, Float64* out_sample_time, UInt64* out_host_time);
static UInt32 WillDoIOOperation(AudioServerPlugInDriverRef in_driver, AudioObjectID in_device_object_id, UInt32 in_client_id, UInt32 in_operation_id, Boolean* out_will_do, Boolean* out_will_do_in_place);
static OSStatus BeginIOOperation(AudioServerPlugInDriverRef in_driver, AudioObjectID in_device_object_id, UInt32 in_client_id, UInt32 in_operation_id, UInt32 in_io_buffer_frame_size, const AudioServerPlugInIOOperation* in_io_operation);
static OSStatus DoIOOperation(AudioServerPlugInDriverRef in_driver, AudioObjectID in_device_object_id, AudioObjectID in_stream_object_id, UInt32 in_client_id, UInt32 in_operation_id, UInt32 in_io_buffer_frame_size, const AudioServerPlugInIOOperation* in_io_operation, void* in_main_buffer, void* in_secondary_buffer);
static OSStatus EndIOOperation(AudioServerPlugInDriverRef in_driver, AudioObjectID in_device_object_id, UInt32 in_client_id, UInt32 in_operation_id, UInt32 in_io_buffer_frame_size, const AudioServerPlugInIOOperation* in_io_operation);

// Reference counting
static ULONG g_ref_count = 0;

HRESULT QueryInterface(void* in_this, REFIID in_iid, LPVOID* out_interface) {
    if (out_interface == NULL) {
        return E_POINTER;
    }
    
    // Compare UUID bytes directly (REFIID is CFUUIDBytes)
    CFUUIDBytes iid_bytes = *(CFUUIDBytes*)in_iid;
    CFUUIDBytes iocf_bytes = CFUUIDGetUUIDBytes(kIOCFPlugInInterfaceID);
    
    if (memcmp(&iid_bytes, &iocf_bytes, sizeof(CFUUIDBytes)) == 0) {
        *out_interface = in_this;
        AddRef(in_this);
        return S_OK;
    }
    
    *out_interface = NULL;
    return E_NOINTERFACE;
}

ULONG AddRef(void* in_this) {
    return ++g_ref_count;
}

ULONG Release(void* in_this) {
    if (g_ref_count > 0) {
        g_ref_count--;
    }
    return g_ref_count;
}

OSStatus CreateDevice(AudioServerPlugInDriverRef in_driver, CFDictionaryRef in_description, const AudioServerPlugInClientInfo* in_client_info, AudioObjectID* out_device_object_id) {
    // Device creation is handled by AddDevice
    return AudioDriver_AddDevice(in_driver, in_description, in_client_info, out_device_object_id);
}

OSStatus DestroyDevice(AudioServerPlugInDriverRef in_driver, AudioObjectID in_device_object_id) {
    return AudioDriver_RemoveDevice(in_driver, in_device_object_id);
}

OSStatus StartIO(AudioServerPlugInDriverRef in_driver, AudioObjectID in_device_object_id, UInt32 in_client_id) {
    // Mark capture as active
    g_driver_state.is_capture_active = true;
    if (g_driver_state.shared_memory && g_driver_state.shared_memory->ring_buffer) {
        atomic_store(&g_driver_state.shared_memory->ring_buffer->active, true);
    }
    return noErr;
}

OSStatus StopIO(AudioServerPlugInDriverRef in_driver, AudioObjectID in_device_object_id, UInt32 in_client_id) {
    // Mark capture as inactive
    g_driver_state.is_capture_active = false;
    if (g_driver_state.shared_memory && g_driver_state.shared_memory->ring_buffer) {
        atomic_store(&g_driver_state.shared_memory->ring_buffer->active, false);
    }
    return noErr;
}

OSStatus GetZeroTimeStamp(AudioServerPlugInDriverRef in_driver, AudioObjectID in_device_object_id, UInt32 in_client_id, Float64* out_sample_time, UInt64* out_host_time) {
    if (out_sample_time) {
        *out_sample_time = 0.0;
    }
    if (out_host_time) {
        // Get current host time
        mach_timebase_info_data_t timebase;
        mach_timebase_info(&timebase);
        *out_host_time = mach_absolute_time() * timebase.numer / timebase.denom;
    }
    return noErr;
}

UInt32 WillDoIOOperation(AudioServerPlugInDriverRef in_driver, AudioObjectID in_device_object_id, UInt32 in_client_id, UInt32 in_operation_id, Boolean* out_will_do, Boolean* out_will_do_in_place) {
    if (out_will_do) {
        *out_will_do = true;
    }
    if (out_will_do_in_place) {
        *out_will_do_in_place = true;
    }
    return 0;
}

OSStatus BeginIOOperation(AudioServerPlugInDriverRef in_driver, AudioObjectID in_device_object_id, UInt32 in_client_id, UInt32 in_operation_id, UInt32 in_io_buffer_frame_size, const AudioServerPlugInIOOperation* in_io_operation) {
    return noErr;
}

OSStatus DoIOOperation(AudioServerPlugInDriverRef in_driver, AudioObjectID in_device_object_id, AudioObjectID in_stream_object_id, UInt32 in_client_id, UInt32 in_operation_id, UInt32 in_io_buffer_frame_size, const AudioServerPlugInIOOperation* in_io_operation, void* in_main_buffer, void* in_secondary_buffer) {
    // This is where audio I/O happens
    // For now, return success - actual IOProc handling would go here
    // The driver will receive audio via the device's IOProc callback
    (void)in_driver;
    (void)in_device_object_id;
    (void)in_stream_object_id;
    (void)in_client_id;
    (void)in_operation_id;
    (void)in_io_buffer_frame_size;
    (void)in_io_operation;
    (void)in_main_buffer;
    (void)in_secondary_buffer;
    return noErr;
}

OSStatus EndIOOperation(AudioServerPlugInDriverRef in_driver, AudioObjectID in_device_object_id, UInt32 in_client_id, UInt32 in_operation_id, UInt32 in_io_buffer_frame_size, const AudioServerPlugInIOOperation* in_io_operation) {
    return noErr;
}

// HAL Plug-in function table (complete)
static AudioServerPlugInDriverInterface g_audio_server_plug_in_interface = {
    NULL, // _reserved
    QueryInterface,
    AddRef,
    Release,
    AudioDriver_Initialize,
    CreateDevice,
    DestroyDevice,
    AudioDriver_AddDevice,
    AudioDriver_RemoveDevice,
    AudioDriver_PerformDeviceConfigurationChange,
    AudioDriver_AbortDeviceConfigurationChange,
    AudioDriver_HasProperty,
    AudioDriver_IsPropertySettable,
    AudioDriver_GetPropertyDataSize,
    AudioDriver_GetPropertyData,
    AudioDriver_SetPropertyData,
    StartIO,
    StopIO,
    GetZeroTimeStamp,
    WillDoIOOperation,
    BeginIOOperation,
    DoIOOperation,
    EndIOOperation
};

// Factory function - called by HAL when loading the plug-in
extern void* AudioDriverPlugInFactory(CFAllocatorRef in_allocator, CFUUIDRef in_requested_type_uuid) {
    // kAudioServerPlugInTypeUUID is a macro, compare UUIDs
    CFUUIDRef plug_in_type_uuid = kAudioServerPlugInTypeUUID;
    
    if (CFEqual(in_requested_type_uuid, plug_in_type_uuid)) {
        return (void*)&g_audio_server_plug_in_interface;
    }
    
    return NULL;
}

