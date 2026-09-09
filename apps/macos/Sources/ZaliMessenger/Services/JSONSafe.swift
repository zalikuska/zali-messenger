import Foundation

/// The only sanctioned way to turn a dynamic `Any` graph into JSON bytes.
///
/// `JSONSerialization.data(withJSONObject:)` does not *throw* when the graph holds
/// something that has no Foundation bridge — a Swift struct or enum in an `[String: Any]`
/// arrives at the writer as `__SwiftValue` and it **raises an Objective-C
/// `NSInvalidArgumentException`**. `try?` cannot catch that; Swift cannot catch it at all.
/// The exception unwinds straight through the Swift frames that called it.
///
/// When those frames belong to an `async` function, that unwind abandons the Swift
/// concurrency runtime's per-thread bookkeeping mid-flight. From that moment every
/// `swift_task_isCurrentExecutorWithFlags` in the process reads a garbage executor and
/// segfaults — and the caller is whoever happens to ask next: SwiftUI's hit test, WebKit's
/// mouse tracking, AppKit's gesture recognisers, the system menu bar. That is what the
/// 2026-09-09 crash wave was: a `[RemoteReactionSummary]` (a plain Codable struct) put
/// into the history payload at `renderHistoryRecord`, serialized inside a `withTaskGroup`
/// child task. Five crash reports, five unrelated stacks, none of them anywhere near the
/// actual bug.
///
/// So the validity check has to happen **before** the call, never after — that is the
/// whole point of this function. Do not call `JSONSerialization.data(withJSONObject:)`
/// directly on anything whose static type is `Any`.
func zaliJSONData(_ object: Any, options: JSONSerialization.WritingOptions = []) -> Data? {
    guard JSONSerialization.isValidJSONObject(object) else {
        // Loud on purpose: reaching here means a non-bridgeable value got into a payload,
        // which used to be a process-killer and is still silent data loss.
        print("[ZALI][JSON] refused to serialize non-JSON object type=\(type(of: object))")
        return nil
    }
    return try? JSONSerialization.data(withJSONObject: object, options: options)
}

/// `zaliJSONData` + UTF-8 decode, for the many call sites that want a string.
func zaliJSONString(_ object: Any, options: JSONSerialization.WritingOptions = []) -> String? {
    guard let data = zaliJSONData(object, options: options) else { return nil }
    return String(data: data, encoding: .utf8)
}
