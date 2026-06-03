// swift-tools-version: 5.9
import PackageDescription
import Foundation

let packageDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().path

let package = Package(
    name: "ZaliMessenger",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "ZaliMessenger", targets: ["ZaliMessenger"])
    ],
    targets: [
        .target(
            name: "CoreBridge",
            path: "Sources/CoreBridge"
        ),
        .executableTarget(
            name: "ZaliMessenger",
            dependencies: ["CoreBridge"],
            path: "Sources/ZaliMessenger",
            resources: [
                .copy("Resources/Web")
            ],
            linkerSettings: [
                .unsafeFlags(["-L\(packageDir)/../Core/target/release"]),
                .linkedLibrary("zali_messenger_core")
            ]
        )
    ]
)
