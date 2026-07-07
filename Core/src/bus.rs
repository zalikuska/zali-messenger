use serde_json::Value;
use std::collections::HashMap;

pub type CommandHandler = Box<dyn Fn(Value) -> Result<Value, String> + Send + Sync>;

pub struct ZaliBus {
    handlers: HashMap<String, CommandHandler>,
}

impl ZaliBus {
    pub fn new() -> Self {
        Self {
            handlers: HashMap::new(),
        }
    }

    /// Registers a command handler for a module address/namespace.
    pub fn register_command(&mut self, address: &str, command: &str, handler: CommandHandler) {
        let key = format!("{}:{}", address, command);
        self.handlers.insert(key, handler);
    }

    /// Dispatches a command payload and returns the result.
    pub fn send(&self, address_command: &str, args: Value) -> Result<Value, String> {
        if let Some(handler) = self.handlers.get(address_command) {
            handler(args)
        } else {
            Err(format!(
                "[zali_bus] Command handler not found for: {}",
                address_command
            ))
        }
    }
}

impl Default for ZaliBus {
    fn default() -> Self {
        Self::new()
    }
}
