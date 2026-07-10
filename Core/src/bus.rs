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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn send_to_unknown_command_returns_error() {
        let bus = ZaliBus::new();
        let result = bus.send("nonexistent:command", Value::Null);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("nonexistent:command"));
    }

    #[test]
    fn registered_command_is_dispatched_with_its_args() {
        let mut bus = ZaliBus::new();
        bus.register_command(
            "echo",
            "reverse",
            Box::new(|args| {
                let text = args["text"].as_str().unwrap_or_default();
                Ok(Value::String(text.chars().rev().collect()))
            }),
        );

        let result = bus
            .send("echo:reverse", serde_json::json!({ "text": "abc" }))
            .unwrap();
        assert_eq!(result.as_str(), Some("cba"));
    }

    #[test]
    fn registering_same_address_command_replaces_the_previous_handler() {
        let mut bus = ZaliBus::new();
        bus.register_command("x", "y", Box::new(|_| Ok(Value::String("first".into()))));
        bus.register_command("x", "y", Box::new(|_| Ok(Value::String("second".into()))));

        let result = bus.send("x:y", Value::Null).unwrap();
        assert_eq!(result.as_str(), Some("second"));
    }
}
