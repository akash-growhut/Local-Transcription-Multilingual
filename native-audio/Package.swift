// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ScreenCaptureKitBridge",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .library(
            name: "ScreenCaptureKitBridge",
            type: .dynamic,
            targets: ["ScreenCaptureKitBridge"]
        )
    ],
    targets: [
        .target(
            name: "ScreenCaptureKitBridge",
            path: "src",
            sources: ["ScreenCaptureKitBridge.swift"],
            publicHeadersPath: "."
        )
    ]
)

