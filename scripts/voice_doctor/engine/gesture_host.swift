// Runs a probe page in a real WKWebView window and delivers a REAL mouse click,
// because WebKit will not resume an AudioContext outside a user gesture — and
// without a running context the remote-audio question cannot be measured at all.
import Cocoa
import WebKit

final class Handler: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? String else { return }
        print(body)
        if body.contains("\"check\":\"done\"") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { exit(0) }
        }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // Click the middle of the window once the page is up.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            guard let window = webView.window else { return }
            let inWindow = NSPoint(x: window.frame.width / 2, y: window.frame.height / 2)
            for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                if let ev = NSEvent.mouseEvent(with: type, location: inWindow, modifierFlags: [],
                                               timestamp: ProcessInfo.processInfo.systemUptime,
                                               windowNumber: window.windowNumber, context: nil,
                                               eventNumber: 0, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0) {
                    window.sendEvent(ev)
                }
            }
            print("{\"check\":\"host\",\"clicked\":true}")
        }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError error: Error) {
        print("{\"check\":\"done\",\"error\":\"load failed: \(error.localizedDescription)\"}")
        exit(2)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)

let handler = Handler()
let config = WKWebViewConfiguration()
config.userContentController.add(handler, name: "probe")
config.mediaTypesRequiringUserActionForPlayback = []

let rect = NSRect(x: 0, y: 0, width: 600, height: 400)
let window = NSWindow(contentRect: rect,
                      styleMask: [.titled, .closable],
                      backing: .buffered, defer: false)
let web = WKWebView(frame: rect, configuration: config)
web.navigationDelegate = handler
window.contentView = web
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)

let url = URL(string: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "http://localhost:8791/remote_audio.html")!
web.load(URLRequest(url: url))

DispatchQueue.main.asyncAfter(deadline: .now() + 60) {
    print("{\"check\":\"done\",\"error\":\"host timeout\"}")
    exit(3)
}
app.run()
