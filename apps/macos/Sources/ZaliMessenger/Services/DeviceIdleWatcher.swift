import AppKit
import CoreGraphics

/// Системный простой этого Mac для маршрута уведомлений (server/src/device_activity.rs):
/// уведомление о сообщении уходит только на устройства, где человек что-то делал последние
/// две минуты, а если бездельничают все — на все.
///
/// «Что-то делал» — любой ввод в системе вообще, а не в окне мессенджера: человек,
/// который работает в другом приложении, сидит за этим компьютером, и вибрировать
/// телефону незачем. Вебвью этого не знает — окно за другим приложением ни мыши, ни
/// клавиатуры не видит, — поэтому меряет оболочка (`CGEventSource`, без разрешений
/// «Универсального доступа») и сама отправляет `client_idle` (NetworkService.reportDeviceIdle).
///
/// Опрос раз в 5 с на своей очереди: дёшево, а частоту отправки режет reportDeviceIdle
/// (раз в 30 с, пока активен). Переключение приложений, пробуждение экрана и сеанса —
/// сразу, не дожидаясь тика: App Nap вправе растянуть таймер свёрнутого приложения.
final class DeviceIdleWatcher {
    static let shared = DeviceIdleWatcher()

    private let queue = DispatchQueue(label: "org.zalikus.messenger.device-idle", qos: .utility)
    private var timer: DispatchSourceTimer?
    private var observers: [NSObjectProtocol] = []

    func start() {
        guard timer == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 2, repeating: .seconds(5), leeway: .seconds(1))
        timer.setEventHandler { DeviceIdleWatcher.report() }
        timer.resume()
        self.timer = timer

        let center = NSWorkspace.shared.notificationCenter
        for name in [
            NSWorkspace.didActivateApplicationNotification,
            NSWorkspace.screensDidWakeNotification,
            NSWorkspace.sessionDidBecomeActiveNotification,
            NSWorkspace.didWakeNotification,
        ] {
            observers.append(center.addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in
                self?.queue.async { DeviceIdleWatcher.report() }
            })
        }
    }

    /// Секунды с последнего ввода в сеансе пользователя (мышь, клавиатура, трекпад).
    static func systemIdleSeconds() -> TimeInterval? {
        // kCGAnyInputEventType (~0): любой тип ввода.
        guard let anyInput = CGEventType(rawValue: ~0) else { return nil }
        let idle = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: anyInput)
        return idle.isFinite ? idle : nil
    }

    private static func report() {
        guard let idle = systemIdleSeconds() else { return }
        NetworkService.shared.reportDeviceIdle(idleSeconds: idle)
    }
}
