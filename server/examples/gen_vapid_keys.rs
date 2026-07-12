//! One-shot VAPID keypair generator for Web Push.
//! Run: cargo run --manifest-path server/Cargo.toml --example gen_vapid_keys
//! Paste the output into .env as VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY.

use ct_codecs::{Base64UrlSafeNoPadding, Encoder};
use jwt_simple::algorithms::ECDSAP256PublicKeyLike;
use jwt_simple::prelude::ES256KeyPair;

fn main() {
    let key = ES256KeyPair::generate();
    let private_b64 = Base64UrlSafeNoPadding::encode_to_string(&key.to_bytes()).unwrap();
    let public_b64 =
        Base64UrlSafeNoPadding::encode_to_string(&key.public_key().public_key().to_bytes_uncompressed())
            .unwrap();
    println!("VAPID_PUBLIC_KEY={public_b64}");
    println!("VAPID_PRIVATE_KEY={private_b64}");
}
