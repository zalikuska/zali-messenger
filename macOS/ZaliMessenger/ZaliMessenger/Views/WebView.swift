import SwiftUI
import WebKit
import CoreBridge

class DraggableWebView: WKWebView {
    override func mouseDown(with event: NSEvent) {
        let location = convert(event.locationInWindow, from: nil)
        // Высота title-bar в CSS = 40px
        if location.y >= frame.height - 40 {
            self.window?.performDrag(with: event)
        } else {
            super.mouseDown(with: event)
        }
    }
}

struct WebView: NSViewRepresentable {
    class Coordinator: NSObject, WKScriptMessageHandler {
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            if let dict = message.body as? [String: Any] {
                let type = dict["type"] as? String ?? ""
                let text = dict["text"] as? String ?? ""
                print(">>> [NATIVE] \(type): \(text)")
                
                if type == "SEND_MESSAGE" {
                    let tempPath = NSTemporaryDirectory() + "msg.zali"
                    if zali_pack_message("Zalikus", text, tempPath) {
                        print(">>> [CORE] Packed successfully")
                    }
                }
            }
        }
    }
    
    func makeCoordinator() -> Coordinator { Coordinator() }
    
    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.userContentController.add(context.coordinator, name: "nativeApp")
        let webView = DraggableWebView(frame: .zero, configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
        return webView
    }
    
    func updateNSView(_ nsView: WKWebView, context: Context) {
        nsView.loadHTMLString(WebAssets.html, baseURL: nil)
        
        DispatchQueue.main.async {
            if let window = nsView.window {
                window.titlebarAppearsTransparent = true
                window.titleVisibility = .hidden
                window.styleMask.insert(.fullSizeContentView)
                window.isMovableByWindowBackground = true
            }
            nsView.window?.makeFirstResponder(nsView)
        }
    }
}
