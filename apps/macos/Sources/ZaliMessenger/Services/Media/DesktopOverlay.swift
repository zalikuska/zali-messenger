import AppKit

/// Плашки поверх всех окон, которых нет в трансляции (op `overlay` страницы,
/// web/src/interface/screen_privacy.js):
///
/// * `privacy-warning` — «скрытие выключено», висит, пока страница не скажет убрать;
/// * `hud` — короткий отклик горячей клавиши, гаснет сам через `timeoutMs`.
///
/// `sharingType = .none` — окно не попадает ни в ScreenCaptureKit, ни в чужие захваты;
/// клики проходят насквозь, фокус не забирается. Только главный поток.
final class DesktopOverlay {
    static let shared = DesktopOverlay()

    private var panels: [String: NSPanel] = [:]
    private var hideTimers: [String: DispatchWorkItem] = [:]

    /// Номера наших окон-плашек: трекер скрытых окон не считает их перекрывающими.
    private(set) var windowNumbers = Set<Int>()
    private let numbersLock = NSLock()

    func numbersSnapshot() -> Set<Int> {
        numbersLock.lock(); defer { numbersLock.unlock() }
        return windowNumbers
    }

    func handle(_ options: [String: Any]) {
        let id = options["id"] as? String ?? ""
        guard id == "hud" || id == "privacy-warning" else { return }
        let visible = options["visible"] as? Bool ?? true
        let text = String((options["text"] as? String ?? "").prefix(200))
        hideTimers.removeValue(forKey: id)?.cancel()
        guard visible, !text.isEmpty else {
            hide(id)
            return
        }
        show(id, text: text, warning: id == "privacy-warning")
        if let timeout = (options["timeoutMs"] as? NSNumber)?.doubleValue, timeout > 0 {
            let work = DispatchWorkItem { [weak self] in self?.hide(id) }
            hideTimers[id] = work
            DispatchQueue.main.asyncAfter(deadline: .now() + min(timeout, 10_000) / 1000, execute: work)
        }
    }

    private func show(_ id: String, text: String, warning: Bool) {
        let panel = panels[id] ?? makePanel()
        panels[id] = panel
        guard let content = panel.contentView, let label = content.subviews.first as? NSTextField else { return }
        label.stringValue = warning ? "⚠︎  " + text : text
        label.textColor = warning ? NSColor(calibratedRed: 1, green: 0.84, blue: 0.4, alpha: 1) : .white
        let size = label.intrinsicContentSize
        let width = min(ceil(size.width) + 36, 720)
        let height: CGFloat = 40
        // Экран с курсором — там человек сейчас смотрит.
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { $0.frame.contains(mouse) } ?? NSScreen.main
        guard let frame = screen?.visibleFrame else { return }
        let y = warning ? frame.maxY - height - 12 : frame.minY + 72
        panel.setFrame(NSRect(x: frame.midX - width / 2, y: y, width: width, height: height), display: true)
        label.frame = NSRect(x: 18, y: (height - size.height) / 2, width: width - 36, height: size.height)
        panel.alphaValue = 1
        panel.orderFrontRegardless()
        numbersLock.lock()
        windowNumbers = Set(panels.values.filter { $0.isVisible }.map { $0.windowNumber })
        numbersLock.unlock()
    }

    private func hide(_ id: String) {
        guard let panel = panels[id] else { return }
        panel.orderOut(nil)
        numbersLock.lock()
        windowNumbers = Set(panels.values.filter { $0.isVisible }.map { $0.windowNumber })
        numbersLock.unlock()
    }

    private func makePanel() -> NSPanel {
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 320, height: 40),
                            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        // Выше обычных и плавающих окон и над полноэкранными приложениями.
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        // Не попадает в захват экрана (ScreenCaptureKit и любые чужие трансляции).
        panel.sharingType = .none
        let view = NSView()
        view.wantsLayer = true
        view.layer?.backgroundColor = NSColor(calibratedWhite: 0.06, alpha: 0.9).cgColor
        view.layer?.cornerRadius = 12
        let label = NSTextField(labelWithString: "")
        label.font = NSFont.systemFont(ofSize: 14, weight: .semibold)
        label.alignment = .center
        label.lineBreakMode = .byTruncatingTail
        view.addSubview(label)
        panel.contentView = view
        return panel
    }
}
