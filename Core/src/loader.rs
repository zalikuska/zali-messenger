use crate::bus::ZaliBus;

pub trait ZaliModule {
    fn name(&self) -> &str;
    fn init(&self, bus: &mut ZaliBus) -> Result<(), String>;
}

pub struct ZaliLoader {
    pub bus: ZaliBus,
    modules: Vec<String>,
}

impl ZaliLoader {
    pub fn new() -> Self {
        Self {
            bus: ZaliBus::new(),
            modules: Vec::new(),
        }
    }

    /// Registers and initializes a module.
    pub fn register_module<M: ZaliModule + 'static>(&mut self, module: M) -> Result<(), String> {
        let name = module.name().to_string();
        module.init(&mut self.bus)?;
        self.modules.push(name);
        Ok(())
    }

    pub fn get_modules(&self) -> Vec<String> {
        self.modules.clone()
    }
}

impl Default for ZaliLoader {
    fn default() -> Self {
        Self::new()
    }
}
