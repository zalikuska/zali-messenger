//! Integration tests for the ZaliArchiver SDK: real files on disk, real
//! pack/unpack roundtrips, and the failure modes that would break a
//! messenger relying on this format (wrong password, tampered ciphertext,
//! path traversal, chunk-boundary edge cases).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use zali_sdk::{ZaliError, ZaliSession};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A fresh, empty scratch directory unique to this test invocation.
fn scratch_dir() -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("zali-sdk-test-{}-{}", std::process::id(), n));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_file(dir: &Path, name: &str, contents: &[u8]) -> String {
    let path = dir.join(name);
    fs::write(&path, contents).unwrap();
    path.to_string_lossy().into_owned()
}

#[test]
fn roundtrip_without_password() {
    let dir = scratch_dir();
    let src = write_file(&dir, "note.txt", b"hello from zali");
    let archive = dir.join("out.zali").to_string_lossy().into_owned();
    let extract_dir = dir.join("extracted");

    let sdk = ZaliSession::new(None, None);
    sdk.create_archive(vec![(src, "note.txt".to_string())], &archive)
        .unwrap();
    sdk.extract_all(&archive, extract_dir.to_string_lossy().as_ref())
        .unwrap();

    let content = fs::read(extract_dir.join("note.txt")).unwrap();
    assert_eq!(content, b"hello from zali");
}

#[test]
fn roundtrip_with_password() {
    let dir = scratch_dir();
    let src = write_file(&dir, "secret.txt", b"encrypted payload contents");
    let archive = dir.join("out.zali").to_string_lossy().into_owned();
    let extract_dir = dir.join("extracted");

    let sdk = ZaliSession::new(Some("correct horse battery staple"), None);
    sdk.create_archive(vec![(src, "secret.txt".to_string())], &archive)
        .unwrap();
    sdk.extract_all(&archive, extract_dir.to_string_lossy().as_ref())
        .unwrap();

    let content = fs::read(extract_dir.join("secret.txt")).unwrap();
    assert_eq!(content, b"encrypted payload contents");
}

#[test]
fn wrong_password_fails_to_authenticate() {
    let dir = scratch_dir();
    let src = write_file(&dir, "secret.txt", b"top secret");
    let archive = dir.join("out.zali").to_string_lossy().into_owned();
    let extract_dir = dir.join("extracted");

    let sdk = ZaliSession::new(Some("right-password"), None);
    sdk.create_archive(vec![(src, "secret.txt".to_string())], &archive)
        .unwrap();

    let wrong_sdk = ZaliSession::new(Some("wrong-password"), None);
    let result = wrong_sdk.extract_all(&archive, extract_dir.to_string_lossy().as_ref());
    assert!(matches!(result, Err(ZaliError::AuthFailed)));
}

#[test]
fn missing_password_fails_to_authenticate_encrypted_archive() {
    let dir = scratch_dir();
    let src = write_file(&dir, "secret.txt", b"top secret");
    let archive = dir.join("out.zali").to_string_lossy().into_owned();
    let extract_dir = dir.join("extracted");

    let sdk = ZaliSession::new(Some("right-password"), None);
    sdk.create_archive(vec![(src, "secret.txt".to_string())], &archive)
        .unwrap();

    let no_password_sdk = ZaliSession::new(None, None);
    let result = no_password_sdk.extract_all(&archive, extract_dir.to_string_lossy().as_ref());
    assert!(matches!(result, Err(ZaliError::AuthFailed)));
}

#[test]
fn tampered_ciphertext_fails_authentication_instead_of_silently_corrupting() {
    let dir = scratch_dir();
    let src = write_file(&dir, "secret.txt", b"do not tamper with this message");
    let archive_path = dir.join("out.zali");
    let extract_dir = dir.join("extracted");

    let sdk = ZaliSession::new(Some("a-password"), None);
    sdk.create_archive(
        vec![(src, "secret.txt".to_string())],
        archive_path.to_string_lossy().as_ref(),
    )
    .unwrap();

    // Flip the last byte of the file — inside the AES-GCM ciphertext/tag,
    // never inside the plaintext header — so this exercises tamper
    // detection, not just a parse failure.
    let mut bytes = fs::read(&archive_path).unwrap();
    let last = bytes.len() - 1;
    bytes[last] ^= 0xFF;
    fs::write(&archive_path, &bytes).unwrap();

    let result = sdk.extract_all(
        archive_path.to_string_lossy().as_ref(),
        extract_dir.to_string_lossy().as_ref(),
    );
    assert!(matches!(result, Err(ZaliError::AuthFailed)));
}

#[test]
fn path_traversal_via_parent_dir_is_rejected() {
    let dir = scratch_dir();
    let src = write_file(&dir, "payload.txt", b"malicious");
    let archive = dir.join("out.zali").to_string_lossy().into_owned();
    let extract_dir = dir.join("extracted");

    let sdk = ZaliSession::new(None, None);
    // The SDK doesn't validate arc_name at pack time — only at unpack — so a
    // malicious/buggy peer's archive is exactly what we need to simulate here.
    sdk.create_archive(vec![(src, "../../escaped.txt".to_string())], &archive)
        .unwrap();

    let result = sdk.extract_all(&archive, extract_dir.to_string_lossy().as_ref());
    assert!(matches!(result, Err(ZaliError::PathTraversal)));
    assert!(!dir.join("escaped.txt").exists());
}

#[test]
fn absolute_path_arc_name_is_rejected() {
    let dir = scratch_dir();
    let src = write_file(&dir, "payload.txt", b"malicious");
    let archive = dir.join("out.zali").to_string_lossy().into_owned();
    let extract_dir = dir.join("extracted");

    let sdk = ZaliSession::new(None, None);
    let absolute_name = if cfg!(windows) {
        "C:\\Windows\\evil.txt".to_string()
    } else {
        "/etc/evil.txt".to_string()
    };
    sdk.create_archive(vec![(src, absolute_name)], &archive)
        .unwrap();

    let result = sdk.extract_all(&archive, extract_dir.to_string_lossy().as_ref());
    assert!(matches!(result, Err(ZaliError::PathTraversal)));
}

#[test]
fn zero_byte_file_roundtrips_with_encryption() {
    let dir = scratch_dir();
    let src = write_file(&dir, "empty.txt", b"");
    let archive = dir.join("out.zali").to_string_lossy().into_owned();
    let extract_dir = dir.join("extracted");

    let sdk = ZaliSession::new(Some("pw"), None);
    sdk.create_archive(vec![(src, "empty.txt".to_string())], &archive)
        .unwrap();
    sdk.extract_all(&archive, extract_dir.to_string_lossy().as_ref())
        .unwrap();

    let content = fs::read(extract_dir.join("empty.txt")).unwrap();
    assert!(content.is_empty());
}

#[test]
fn multi_chunk_file_roundtrips_exactly() {
    const CHUNK_SIZE: usize = 1024 * 1024;
    let dir = scratch_dir();
    // 2.5 chunks worth of pseudo-random-ish bytes so a chunk-boundary or
    // nonce-counter bug would corrupt the tail instead of passing by luck.
    let size = CHUNK_SIZE * 2 + CHUNK_SIZE / 2;
    let payload: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
    let src = write_file(&dir, "big.bin", &payload);
    let archive = dir.join("out.zali").to_string_lossy().into_owned();
    let extract_dir = dir.join("extracted");

    let sdk = ZaliSession::new(Some("pw"), None);
    sdk.create_archive(vec![(src, "big.bin".to_string())], &archive)
        .unwrap();
    sdk.extract_all(&archive, extract_dir.to_string_lossy().as_ref())
        .unwrap();

    let content = fs::read(extract_dir.join("big.bin")).unwrap();
    assert_eq!(content.len(), payload.len());
    assert_eq!(content, payload);
}

#[test]
fn multi_chunk_file_roundtrips_without_encryption() {
    const CHUNK_SIZE: usize = 1024 * 1024;
    let dir = scratch_dir();
    let size = CHUNK_SIZE + 1024;
    let payload: Vec<u8> = (0..size).map(|i| (i % 233) as u8).collect();
    let src = write_file(&dir, "big.bin", &payload);
    let archive = dir.join("out.zali").to_string_lossy().into_owned();
    let extract_dir = dir.join("extracted");

    let sdk = ZaliSession::new(None, None);
    sdk.create_archive(vec![(src, "big.bin".to_string())], &archive)
        .unwrap();
    sdk.extract_all(&archive, extract_dir.to_string_lossy().as_ref())
        .unwrap();

    let content = fs::read(extract_dir.join("big.bin")).unwrap();
    assert_eq!(content, payload);
}

#[test]
fn inspect_archive_reports_names_and_sizes_without_extracting() {
    let dir = scratch_dir();
    let a = write_file(&dir, "a.txt", b"aaaa");
    let b = write_file(&dir, "b.txt", b"bbbbbbbb");
    let archive = dir.join("out.zali").to_string_lossy().into_owned();
    let extract_dir = dir.join("extracted");

    let sdk = ZaliSession::new(None, None);
    sdk.create_archive(
        vec![(a, "a.txt".to_string()), (b, "b.txt".to_string())],
        &archive,
    )
    .unwrap();

    let (magic, contents) = sdk.inspect_archive(&archive).unwrap();
    assert_eq!(&magic, sdk.get_magic().as_slice() as &[u8]);
    assert_eq!(contents.len(), 2);
    assert!(contents.contains(&("a.txt".to_string(), 4)));
    assert!(contents.contains(&("b.txt".to_string(), 8)));

    // inspect_archive must not have extracted anything to disk.
    assert!(!extract_dir.exists());
}

#[test]
fn multiple_files_all_roundtrip_together() {
    let dir = scratch_dir();
    let a = write_file(&dir, "a.txt", b"first file contents");
    let b = write_file(&dir, "b.txt", b"second file, different length!!");
    let archive = dir.join("out.zali").to_string_lossy().into_owned();
    let extract_dir = dir.join("extracted");

    let sdk = ZaliSession::new(Some("multi-pw"), None);
    sdk.create_archive(
        vec![(a, "a.txt".to_string()), (b, "b.txt".to_string())],
        &archive,
    )
    .unwrap();
    sdk.extract_all(&archive, extract_dir.to_string_lossy().as_ref())
        .unwrap();

    assert_eq!(
        fs::read(extract_dir.join("a.txt")).unwrap(),
        b"first file contents"
    );
    assert_eq!(
        fs::read(extract_dir.join("b.txt")).unwrap(),
        b"second file, different length!!"
    );
}

#[test]
fn mismatched_custom_magic_is_rejected_as_format_mismatch() {
    let dir = scratch_dir();
    let src = write_file(&dir, "note.txt", b"content");
    let archive = dir.join("out.zali").to_string_lossy().into_owned();
    let extract_dir = dir.join("extracted");

    let writer = ZaliSession::new(None, Some(b"CUSTOM01"));
    writer
        .create_archive(vec![(src, "note.txt".to_string())], &archive)
        .unwrap();

    // A reader expecting the default magic must reject this archive outright
    // rather than misinterpreting a foreign/incompatible format.
    let default_reader = ZaliSession::new(None, None);
    let result = default_reader.extract_all(&archive, extract_dir.to_string_lossy().as_ref());
    assert!(matches!(result, Err(ZaliError::FormatMismatch)));
}

#[test]
fn nonexistent_source_file_is_silently_skipped_not_archived() {
    let dir = scratch_dir();
    let archive = dir.join("out.zali").to_string_lossy().into_owned();
    let extract_dir = dir.join("extracted");

    let sdk = ZaliSession::new(None, None);
    sdk.create_archive(
        vec![(
            dir.join("does-not-exist.txt")
                .to_string_lossy()
                .into_owned(),
            "ghost.txt".to_string(),
        )],
        &archive,
    )
    .unwrap();

    let (_magic, contents) = sdk.inspect_archive(&archive).unwrap();
    assert!(contents.is_empty());

    sdk.extract_all(&archive, extract_dir.to_string_lossy().as_ref())
        .unwrap();
    assert!(!extract_dir.join("ghost.txt").exists());
}
