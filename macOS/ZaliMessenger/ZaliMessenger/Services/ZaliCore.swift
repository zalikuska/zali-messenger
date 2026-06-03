import Foundation

class ZaliCore {
    static let shared = ZaliCore()
    
    func packMessage(sender: String, text: String, output: String) -> Bool {
        return zali_pack_message(sender, text, output)
    }
    
    // В будущем здесь можно добавить распаковку через Rust
}
