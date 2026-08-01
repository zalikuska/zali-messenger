// Runs the probe page inside a real WKWebView — the exact engine the macOS
// client uses — and prints whatever the page reports back.
import Cocoa
import WebKit

final class Handler: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    var lines = 0
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? String else { return }
        print(body)
        lines += 1
        if body.contains("\"check\":\"done\"") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { exit(0) }
        }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError error: Error) {
        print("{\"step\":\"load-failed\",\"error\":\"\(error.localizedDescription)\"}")
        exit(2)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let handler = Handler()
let config = WKWebViewConfiguration()
config.userContentController.add(handler, name: "probe")
if #available(macOS 14.0, *) {
    // Match the client: no user-gesture requirement for playback.
    config.mediaTypesRequiringUserActionForPlayback = []
}
config.preferences.setValue(true, forKey: "mediaDevicesEnabled")

let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 600), configuration: config)
web.navigationDelegate = handler

let url = URL(string: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "http://localhost:8777/index.html")!
web.load(URLRequest(url: url))

DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
    print("{\"step\":\"host-timeout\"}")
    exit(3)
}
app.run()
