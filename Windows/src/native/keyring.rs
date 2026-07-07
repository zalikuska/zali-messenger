//! OS keyring access (non-macOS only; macOS uses the shared-file identity,
//! see project notes on Keychain consent prompts).




#[cfg(not(target_os = "macos"))]
pub(crate) fn keyring_entry(name: &str) -> Option<keyring::Entry> {
    keyring::Entry::new("ZaliMessenger", name).ok()
}

// Windows' keyring backend (Credential Manager) reads/writes the app's own item
// silently — no per-launch consent prompt. macOS Keychain does show one, and its
// ACL is tied to the code-signing identity: build_macos_rust_app.sh's ad-hoc
// signature changes on every rebuild, so after any rebuild the OS treats this as
// "a different app" and reprompts. These calls run synchronously on the startup
// path (NativeState::load()), so a prompt here blocks the whole app before the
// window ever appears — confirmed live (SecurityAgent stuck holding the process
// with no visible dialog to answer). macOS relies solely on the plaintext
// native_config.json fallback these already have (see call sites).
#[cfg(not(target_os = "macos"))]
pub(crate) fn load_secret_from_keyring(name: &str) -> Option<String> {
    keyring_entry(name)?.get_password().ok()
}

#[cfg(target_os = "macos")]
pub(crate) fn load_secret_from_keyring(_name: &str) -> Option<String> {
    None
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn store_secret_in_keyring(name: &str, value: Option<&str>) -> bool {
    let Some(entry) = keyring_entry(name) else {
        return false;
    };
    match value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
    {
        Some(secret) => entry.set_password(&secret).is_ok(),
        None => entry.delete_password().is_ok(),
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn store_secret_in_keyring(_name: &str, _value: Option<&str>) -> bool {
    false
}
