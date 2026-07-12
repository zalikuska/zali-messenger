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

// --- In-memory (bytes) archive API, added for the browser/WASM client ---
// These prove create_archive_bytes/extract_all_bytes are wire-compatible
// with the filesystem-based create_archive/extract_all — same format, same
// key, interchangeable in either direction.

#[test]
fn bytes_roundtrip_with_password() {
    let sdk = ZaliSession::new(Some("hunter2"), Some(b"ZALIMSSG"));
    let files = vec![
        ("message.json".to_string(), b"{\"text\":\"hi\"}".to_vec()),
        ("attachments/photo.png".to_string(), vec![7u8; 3000]),
    ];
    let archive = sdk.create_archive_bytes(files.clone()).unwrap();
    let extracted = sdk.extract_all_bytes(&archive).unwrap();
    assert_eq!(extracted, files);
}

#[test]
fn bytes_roundtrip_without_password() {
    let sdk = ZaliSession::new(None, None);
    let files = vec![("note.txt".to_string(), b"hello".to_vec())];
    let archive = sdk.create_archive_bytes(files.clone()).unwrap();
    let extracted = sdk.extract_all_bytes(&archive).unwrap();
    assert_eq!(extracted, files);
}

#[test]
fn bytes_archive_wrong_password_fails() {
    let sdk = ZaliSession::new(Some("right"), None);
    let archive = sdk
        .create_archive_bytes(vec![("a.txt".to_string(), b"data".to_vec())])
        .unwrap();
    let wrong = ZaliSession::new(Some("wrong"), None);
    assert!(matches!(
        wrong.extract_all_bytes(&archive),
        Err(ZaliError::AuthFailed)
    ));
}

#[test]
fn bytes_archive_created_by_path_api_extracts_via_bytes_api() {
    let dir = scratch_dir();
    let src = write_file(&dir, "note.txt", b"cross-api interop");
    let archive_path = dir.join("out.zali");

    let sdk = ZaliSession::new(Some("shared-key"), Some(b"ZALIMSSG"));
    sdk.create_archive(
        vec![(src, "note.txt".to_string())],
        archive_path.to_string_lossy().as_ref(),
    )
    .unwrap();

    let archive_bytes = fs::read(&archive_path).unwrap();
    let extracted = sdk.extract_all_bytes(&archive_bytes).unwrap();
    assert_eq!(extracted, vec![("note.txt".to_string(), b"cross-api interop".to_vec())]);
}

#[test]
fn bytes_archive_created_via_bytes_api_extracts_via_path_api() {
    let dir = scratch_dir();
    let extract_dir = dir.join("extracted");

    let sdk = ZaliSession::new(Some("shared-key"), Some(b"ZALIMSSG"));
    let archive_bytes = sdk
        .create_archive_bytes(vec![("note.txt".to_string(), b"cross-api interop 2".to_vec())])
        .unwrap();
    let archive_path = dir.join("out.zali");
    fs::write(&archive_path, &archive_bytes).unwrap();

    sdk.extract_all(archive_path.to_string_lossy().as_ref(), extract_dir.to_string_lossy().as_ref())
        .unwrap();
    let content = fs::read(extract_dir.join("note.txt")).unwrap();
    assert_eq!(content, b"cross-api interop 2");
}

#[test]
fn bytes_multi_chunk_file_roundtrips_exactly() {
    let sdk = ZaliSession::new(Some("secret"), None);
    let big = (0..(2 * 1024 * 1024 + 12345))
        .map(|i| (i % 251) as u8)
        .collect::<Vec<u8>>();
    let archive = sdk
        .create_archive_bytes(vec![("big.bin".to_string(), big.clone())])
        .unwrap();
    let extracted = sdk.extract_all_bytes(&archive).unwrap();
    assert_eq!(extracted, vec![("big.bin".to_string(), big)]);
}
