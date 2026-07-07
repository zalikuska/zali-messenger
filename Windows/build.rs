use std::{env, fs, path::PathBuf};

fn to_variant_name(key: &str) -> String {
    let mut out = String::new();
    for part in key.split('_').filter(|part| !part.is_empty()) {
        let mut chars = part.chars();
        if let Some(first) = chars.next() {
            out.push(first.to_ascii_uppercase());
            out.push_str(chars.as_str().to_ascii_lowercase().as_str());
        }
    }
    if out.is_empty() {
        "Unknown".to_string()
    } else {
        out
    }
}

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let protocol_path = manifest_dir.join("../Web/bridge_protocol.json");

    println!("cargo:rerun-if-changed={}", protocol_path.display());
    // main.rs embeds these via include_str! too, but Cargo only tracks a build
    // script's OWN declared deps — it has no way to know an include_str!'d file
    // changed unless told here. Without this, editing Web/index.html, style.css,
    // or app.js (the bundle_web.py output) silently rebuilds nothing: `cargo build`
    // reports success but the binary still serves the OLD web assets. Confirmed
    // live 2026-07-04: a JS-only fix to interface.js/app.js was verified missing
    // from the compiled binary (grep for the new function found zero matches)
    // after a full rebuild, purely because only bridge_protocol.json was declared.
    for asset in ["index.html", "style.css", "app.js"] {
        println!(
            "cargo:rerun-if-changed={}",
            manifest_dir.join("../Web").join(asset).display()
        );
    }

    let raw = fs::read_to_string(&protocol_path)
        .unwrap_or_else(|error| panic!("failed to read {}: {}", protocol_path.display(), error));

    let value: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|error| panic!("failed to parse {}: {}", protocol_path.display(), error));

    let messages = value
        .get("messages")
        .and_then(serde_json::Value::as_object)
        .unwrap_or_else(|| panic!("{} is missing a messages object", protocol_path.display()));

    if messages.is_empty() {
        panic!(
            "{} must define at least one bridge message",
            protocol_path.display()
        );
    }

    let mut types: Vec<String> = messages.keys().cloned().collect();
    types.sort_unstable();

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let dest = out_dir.join("bridge_protocol.rs");

    let mut code = String::new();
    code.push_str("#[derive(Debug, Clone, Copy, PartialEq, Eq)]\n");
    code.push_str("pub(crate) enum BridgeProtocolMessageType {\n");
    for kind in &types {
        code.push_str(&format!("    {},\n", to_variant_name(kind)));
    }
    code.push_str("}\n\n");
    code.push_str("pub(crate) fn parse_bridge_protocol_message_type(kind: &str) -> Option<BridgeProtocolMessageType> {\n");
    code.push_str("    match kind {\n");
    for kind in &types {
        code.push_str(&format!(
            "        {:?} => Some(BridgeProtocolMessageType::{}),\n",
            kind,
            to_variant_name(kind)
        ));
    }
    code.push_str("        _ => None,\n");
    code.push_str("    }\n");
    code.push_str("}\n");

    fs::write(&dest, code)
        .unwrap_or_else(|error| panic!("failed to write {}: {}", dest.display(), error));
}
