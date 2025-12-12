@_exported import Foundation
@_exported import ScreenCaptureKit
@_exported import AVFoundation
@_exported import CoreMedia

// Objective-C compatible interface for ScreenCaptureKit
@objc public class ScreenCaptureKitBridge: NSObject {
    private var stream: SCStream?
    private var outputHandler: AudioStreamOutput?
    private var isCapturing = false
    private var audioCallback: ((UnsafePointer<Float>, Int) -> Void)?
    
    @objc public static let shared = ScreenCaptureKitBridge()
    
    private override init() {
        super.init()
    }
    
    @objc public func setAudioCallback(_ callback: @escaping (UnsafePointer<Float>, Int) -> Void) {
        self.audioCallback = callback
    }
    
    @objc public func startCapture() -> Bool {
        guard !isCapturing else {
            print("Audio capture already started")
            return false
        }
        
        Task {
            do {
                // Use ScreenCaptureKit's async API with audio-only permission
                // excludingDesktopWindows: true = requests "System Audio Recording" permission only
                // onScreenWindowsOnly: false = allows system audio capture
                let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
                
                // For audio-only permission (macOS 14.4+):
                // Use nil display to capture system audio without screen recording permission
                let filter = SCContentFilter(display: nil, excludingApplications: [], exceptingWindows: [])
                
                let config = SCStreamConfiguration()
                config.capturesAudio = true
                config.capturesVideo = false  // Explicitly disable video capture
                config.sampleRate = 16000
                config.channelCount = 1
                
                let output = AudioStreamOutput()
                output.setCallback { [weak self] buffer, length in
                    self?.audioCallback?(buffer, length)
                }
                
                let stream = SCStream(filter: filter, configuration: config, delegate: nil)
                
                try stream.addStreamOutput(output, type: .audio, sampleHandlerQueue: nil)
                
                try await stream.startCapture()
                
                self.stream = stream
                self.outputHandler = output
                self.isCapturing = true
                
                print("✅ macOS system audio capture started successfully")
                
            } catch {
                print("❌ Error starting audio capture: \(error.localizedDescription)")
                self.isCapturing = false
            }
        }
        
        return true
    }
    
    @objc public func stopCapture() {
        guard isCapturing, let stream = stream else {
            return
        }
        
        Task {
            do {
                try await stream.stopCapture()
                self.stream = nil
                self.outputHandler = nil
                self.isCapturing = false
                print("✅ Audio capture stopped")
            } catch {
                print("❌ Error stopping audio capture: \(error.localizedDescription)")
            }
        }
    }
    
    @objc public func isActive() -> Bool {
        return isCapturing
    }
}

// Audio stream output handler
@objc class AudioStreamOutput: NSObject, SCStreamOutput {
    private var callback: ((UnsafePointer<Float>, Int) -> Void)?
    
    func setCallback(_ callback: @escaping (UnsafePointer<Float>, Int) -> Void) {
        self.callback = callback
    }
    
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return }
        guard let callback = callback else { return }
        
        var audioBufferList = AudioBufferList()
        var blockBuffer: CMBlockBuffer?
        
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: &audioBufferList,
            bufferListSize: MemoryLayout<AudioBufferList>.size,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: 0,
            blockBufferOut: &blockBuffer
        )
        
        guard status == noErr else {
            print("Error getting audio buffer: \(status)")
            return
        }
        
        let numBuffers = audioBufferList.mNumberBuffers
        for i in 0..<numBuffers {
            let buffer = audioBufferList.mBuffers.advanced(by: Int(i)).pointee
            if let data = buffer.mData {
                let length = Int(buffer.mDataByteSize) / MemoryLayout<Float>.size
                data.assumingMemoryBound(to: Float.self).withMemoryRebound(to: Float.self, capacity: length) { floatPtr in
                    callback(floatPtr, length)
                }
            }
        }
        
        if let blockBuffer = blockBuffer {
            CFRelease(blockBuffer)
        }
    }
}

