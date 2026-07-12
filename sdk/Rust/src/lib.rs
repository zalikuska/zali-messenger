//! # ZaliArchiver SDK (Rust)
//!
//! Современный и безопасный инструмент для архивации и шифрования файлов.
//! Идеально подходит для мессенджеров, систем хранения и обмена файлами.
//!
//! ## Основные возможности:
//! - **AES-256-GCM**: Криптография военного уровня для защиты содержимого.
//! - **PBKDF2**: Надежная генерация ключей из паролей пользователей.
//! - **Безопасность**: Защита от Path Traversal и других атак.
//! - **Гибкость**: Выборочная распаковка и поддержка больших файлов (1MB чанки).

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, Key, KeyInit, Nonce};
use byteorder::{LittleEndian, ReadBytesExt, WriteBytesExt};
use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use sha2::Sha256;
use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use thiserror::Error;

const MAGIC: &[u8; 8] = b"ZALIARCH";
const PROTOCOL_VERSION: u8 = 1;
const CHUNK_SIZE: usize = 1024 * 1024;
const PBKDF2_ITERS: u32 = 210_000;

/// Ошибки, которые может вернуть SDK.
#[derive(Error, Debug)]
pub enum ZaliError {
    #[error("Ошибка ввода-вывода: {0}")]
    Io(#[from] io::Error),
    #[error("Неверный формат архива")]
    FormatMismatch,
    #[error("Неподдерживаемая версия протокола")]
    VersionMismatch,
    #[error("Ошибка аутентификации: неверный пароль или данные повреждены")]
    AuthFailed,
    #[error("Попытка выхода за пределы папки (Path Traversal) заблокирована")]
    PathTraversal,
    #[error("Ошибка криптографии: {0}")]
    Crypto(String),
}

/// Инвентарь архива: обнаруженный магический маркер и список файлов `(имя, размер)`.
pub type ArchiveInventory = ([u8; 8], Vec<(String, u64)>);

/// Основная структура сессии ZaliArchiver для мессенджера.
pub struct ZaliSession {
    password: Option<String>,
    magic: [u8; 8],
}

impl ZaliSession {
    /// Создает новую сессию.
    /// * `password` - Пароль для шифрования.
    /// * `magic` - Кастомный 8-байтовый маркер (по умолчанию "ZALIARCH").
    pub fn new(password: Option<&str>, magic: Option<&[u8; 8]>) -> Self {
        Self {
            password: password.map(|s| s.to_string()),
            magic: magic.copied().unwrap_or(*MAGIC),
        }
    }

    /// Возвращает текущий магический маркер сессии.
    pub fn get_magic(&self) -> [u8; 8] {
        self.magic
    }

    /// Упаковывает список файлов в зашифрованный архив.
    pub fn create_archive(
        &self,
        files: Vec<(String, String)>,
        output: &str,
    ) -> Result<(), ZaliError> {
        self.pack_internal(files, output, |_, _| {})
    }

    /// Распаковывает архив в указанную директорию.
    pub fn extract_all(&self, archive_path: &str, output_dir: &str) -> Result<(), ZaliError> {
        self.unpack_internal(archive_path, output_dir, None, |_, _| {})
    }

    /// Упаковывает файлы, уже находящиеся в памяти, в зашифрованный архив и возвращает его байты.
    /// Формат идентичен `create_archive` (тот же magic/версия/чанки/nonce-схема) — используется
    /// в средах без файловой системы (WASM в браузере).
    pub fn create_archive_bytes(
        &self,
        files: Vec<(String, Vec<u8>)>,
    ) -> Result<Vec<u8>, ZaliError> {
        let mut out = Vec::new();
        out.write_all(&self.magic)?;
        out.write_u8(PROTOCOL_VERSION)?;

        let write_str = |buf: &mut Vec<u8>, s: &str| -> io::Result<()> {
            let len = s.len().min(255) as u8;
            buf.write_u8(len)?;
            buf.write_all(&s.as_bytes()[..len as usize])
        };
        write_str(&mut out, "ZALI")?;
        write_str(&mut out, "messenger")?;

        let is_enc = self.password.is_some();
        out.write_u8(if is_enc { 1 } else { 0 })?;

        let file_count = u32::try_from(files.len())
            .map_err(|_| ZaliError::Crypto("Too many files to archive".to_string()))?;
        out.write_u32::<LittleEndian>(file_count)?;

        let mut key = [0u8; 32];
        let mut base_nonce = [0u8; 12];
        if let Some(pwd) = &self.password {
            let mut salt = [0u8; 16];
            rand::thread_rng().fill_bytes(&mut salt);
            out.write_all(&salt)?;
            rand::thread_rng().fill_bytes(&mut base_nonce);
            out.write_all(&base_nonce)?;
            pbkdf2_hmac::<Sha256>(pwd.as_bytes(), &salt, PBKDF2_ITERS, &mut key);
        }

        let mut chunk_idx: u32 = 1;

        for (arc_name, content) in &files {
            let size = content.len() as u64;

            let n_len = arc_name.len().min(65535) as u16;
            out.write_u16::<LittleEndian>(n_len)?;
            out.write_all(&arc_name.as_bytes()[..n_len as usize])?;
            out.write_u64::<LittleEndian>(size)?;

            let num_chunks = size.div_ceil(CHUNK_SIZE as u64);
            out.write_u64::<LittleEndian>(if is_enc { size + num_chunks * 16 } else { size })?;

            for chunk in content.chunks(CHUNK_SIZE) {
                if is_enc {
                    let mut n_b = base_nonce;
                    let counter = u32::from_le_bytes(n_b[8..12].try_into().unwrap_or([0u8; 4]));
                    n_b[8..12].copy_from_slice(&counter.wrapping_add(chunk_idx).to_le_bytes());
                    chunk_idx = chunk_idx
                        .checked_add(1)
                        .ok_or_else(|| ZaliError::Crypto("Chunk index overflow".to_string()))?;
                    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
                    let cipher_text = cipher
                        .encrypt(Nonce::from_slice(&n_b), chunk)
                        .map_err(|e| ZaliError::Crypto(e.to_string()))?;
                    out.write_all(&cipher_text)?;
                } else {
                    out.write_all(chunk)?;
                }
            }
        }
        Ok(out)
    }

    /// Распаковывает архив из байтов в памяти и возвращает список `(имя, содержимое)`.
    /// Используется в средах без файловой системы (WASM в браузере) — не пишет на диск.
    pub fn extract_all_bytes(&self, archive: &[u8]) -> Result<Vec<(String, Vec<u8>)>, ZaliError> {
        let mut cur = std::io::Cursor::new(archive);

        let mut found_mag = [0u8; 8];
        cur.read_exact(&mut found_mag)?;
        if found_mag != self.magic {
            return Err(ZaliError::FormatMismatch);
        }
        let version = cur.read_u8()?;
        if version != PROTOCOL_VERSION {
            return Err(ZaliError::VersionMismatch);
        }

        let read_str = |c: &mut std::io::Cursor<&[u8]>| -> io::Result<String> {
            let len = c.read_u8()? as usize;
            let mut b = vec![0u8; len];
            c.read_exact(&mut b)?;
            Ok(String::from_utf8_lossy(&b).into_owned())
        };
        read_str(&mut cur)?;
        read_str(&mut cur)?; // skip id, dom
        let flags = cur.read_u8()?;
        let count = cur.read_u32::<LittleEndian>()?;

        const MAX_ARCHIVE_FILES: u32 = 10_000;
        const MAX_TOTAL_EXTRACTED_BYTES: u64 = 4 * 1024 * 1024 * 1024;
        if count > MAX_ARCHIVE_FILES {
            return Err(ZaliError::FormatMismatch);
        }

        let is_enc = flags & 1 != 0;
        let mut key = [0u8; 32];
        let mut base_nonce = [0u8; 12];
        if is_enc {
            let pwd = self.password.as_ref().ok_or(ZaliError::AuthFailed)?;
            let mut salt = [0u8; 16];
            cur.read_exact(&mut salt)?;
            cur.read_exact(&mut base_nonce)?;
            pbkdf2_hmac::<Sha256>(pwd.as_bytes(), &salt, PBKDF2_ITERS, &mut key);
        }

        let mut chunk_idx: u32 = 1;
        let mut total_extracted: u64 = 0;
        let mut results = Vec::new();

        for _ in 0..count {
            let n_len = cur.read_u16::<LittleEndian>()? as usize;
            let mut n_b = vec![0u8; n_len];
            cur.read_exact(&mut n_b)?;
            let name = String::from_utf8_lossy(&n_b).into_owned();
            let o_size = cur.read_u64::<LittleEndian>()?;
            let e_size = cur.read_u64::<LittleEndian>()?;

            total_extracted = total_extracted.saturating_add(o_size);
            if total_extracted > MAX_TOTAL_EXTRACTED_BYTES {
                return Err(ZaliError::Io(io::Error::other(
                    "Archive extraction limit exceeded",
                )));
            }

            let name_path = Path::new(&name);
            if name_path.is_absolute()
                || name_path.components().any(|component| {
                    matches!(
                        component,
                        std::path::Component::ParentDir
                            | std::path::Component::RootDir
                            | std::path::Component::Prefix(_)
                    )
                })
            {
                return Err(ZaliError::PathTraversal);
            }

            let mut encoded = vec![0u8; e_size as usize];
            cur.read_exact(&mut encoded)?;

            let content = if is_enc {
                let mut plain = Vec::with_capacity(o_size as usize);
                for enc_chunk in encoded.chunks(CHUNK_SIZE + 16) {
                    let mut n_b = base_nonce;
                    let counter = u32::from_le_bytes(n_b[8..12].try_into().unwrap_or([0u8; 4]));
                    n_b[8..12].copy_from_slice(&counter.wrapping_add(chunk_idx).to_le_bytes());
                    chunk_idx = chunk_idx
                        .checked_add(1)
                        .ok_or_else(|| ZaliError::Crypto("Chunk index overflow".to_string()))?;
                    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
                    let decrypted = cipher
                        .decrypt(Nonce::from_slice(&n_b), enc_chunk)
                        .map_err(|_| ZaliError::AuthFailed)?;
                    plain.extend_from_slice(&decrypted);
                }
                plain
            } else {
                encoded
            };

            results.push((name, content));
        }
        Ok(results)
    }

    /// Возвращает список файлов и обнаруженный магический маркер архива.
    pub fn inspect_archive(&self, archive_path: &str) -> Result<ArchiveInventory, ZaliError> {
        let mut in_file = File::open(archive_path)?;
        let mut found_mag = [0u8; 8];
        in_file.read_exact(&mut found_mag)?;
        if found_mag != self.magic {
            return Err(ZaliError::FormatMismatch);
        }
        if in_file.read_u8()? != PROTOCOL_VERSION {
            return Err(ZaliError::VersionMismatch);
        }

        let read_string = |f: &mut File| -> io::Result<String> {
            let len = f.read_u8()? as usize;
            let mut b = vec![0u8; len];
            f.read_exact(&mut b)?;
            Ok(String::from_utf8_lossy(&b).into_owned())
        };

        let _id = read_string(&mut in_file)?;
        let _dom = read_string(&mut in_file)?;
        let flags = in_file.read_u8()?;
        let count = in_file.read_u32::<LittleEndian>()?;

        if flags & 1 != 0 {
            in_file.seek(SeekFrom::Current(28))?;
        }

        let mut results = Vec::new();
        for _ in 0..count {
            let name_len = in_file.read_u16::<LittleEndian>()? as usize;
            let mut name_bytes = vec![0u8; name_len];
            in_file.read_exact(&mut name_bytes)?;
            let name = String::from_utf8_lossy(&name_bytes).into_owned();
            let o_size = in_file.read_u64::<LittleEndian>()?;
            let e_size = in_file.read_u64::<LittleEndian>()?;
            results.push((name, o_size));
            let offset = i64::try_from(e_size)
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "File too large"))?;
            in_file.seek(SeekFrom::Current(offset))?;
        }
        Ok((found_mag, results))
    }

    // Внутренние реализации с поддержкой прогресса
    fn pack_internal(
        &self,
        files: Vec<(String, String)>,
        output: &str,
        progress: impl Fn(f64, &str),
    ) -> Result<(), ZaliError> {
        let mut out = File::create(output)?;
        out.write_all(&self.magic)?;
        out.write_u8(PROTOCOL_VERSION)?;

        let write_str = |f: &mut File, s: &str| -> io::Result<()> {
            let len = s.len().min(255) as u8;
            f.write_u8(len)?;
            f.write_all(&s.as_bytes()[..len as usize])
        };
        write_str(&mut out, "ZALI")?;
        write_str(&mut out, "messenger")?;

        let is_enc = self.password.is_some();
        out.write_u8(if is_enc { 1 } else { 0 })?;

        let valid: Vec<_> = files
            .into_iter()
            .filter(|(p, _)| Path::new(p).exists())
            .collect();
        let file_count = u32::try_from(valid.len())
            .map_err(|_| ZaliError::Crypto("Too many files to archive".to_string()))?;
        out.write_u32::<LittleEndian>(file_count)?;

        let mut key = [0u8; 32];
        let mut base_nonce = [0u8; 12];
        if let Some(pwd) = &self.password {
            let mut salt = [0u8; 16];
            rand::thread_rng().fill_bytes(&mut salt);
            out.write_all(&salt)?;
            rand::thread_rng().fill_bytes(&mut base_nonce);
            out.write_all(&base_nonce)?;
            pbkdf2_hmac::<Sha256>(pwd.as_bytes(), &salt, PBKDF2_ITERS, &mut key);
        }

        let mut chunk_idx: u32 = 1;
        let mut buf = vec![0u8; CHUNK_SIZE + 64];

        for (i, (path, arc_name)) in valid.iter().enumerate() {
            let mut f_in = File::open(path)?;
            let size = fs::metadata(path)?.len();

            let n_len = arc_name.len().min(65535) as u16;
            out.write_u16::<LittleEndian>(n_len)?;
            out.write_all(&arc_name.as_bytes()[..n_len as usize])?;
            out.write_u64::<LittleEndian>(size)?;

            let num_chunks = size.div_ceil(CHUNK_SIZE as u64);
            out.write_u64::<LittleEndian>(if is_enc { size + num_chunks * 16 } else { size })?;

            let mut rem = size;
            while rem > 0 {
                let n = (rem as usize).min(CHUNK_SIZE);
                f_in.read_exact(&mut buf[..n])?;
                if is_enc {
                    let mut n_b = base_nonce;
                    let counter = u32::from_le_bytes(n_b[8..12].try_into().unwrap_or([0u8; 4]));
                    n_b[8..12].copy_from_slice(&counter.wrapping_add(chunk_idx).to_le_bytes());
                    chunk_idx = chunk_idx
                        .checked_add(1)
                        .ok_or_else(|| ZaliError::Crypto("Chunk index overflow".to_string()))?;
                    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
                    let cipher_text = cipher
                        .encrypt(Nonce::from_slice(&n_b), &buf[..n])
                        .map_err(|e| ZaliError::Crypto(e.to_string()))?;
                    out.write_all(&cipher_text)?;
                } else {
                    out.write_all(&buf[..n])?;
                }
                rem -= n as u64;
            }
            progress((i + 1) as f64 / valid.len() as f64, arc_name);
        }
        Ok(())
    }

    fn unpack_internal(
        &self,
        archive_path: &str,
        output_dir: &str,
        items: Option<Vec<String>>,
        progress: impl Fn(f64, &str),
    ) -> Result<(), ZaliError> {
        let mut in_file = File::open(archive_path)?;
        let mut found_mag = [0u8; 8];
        in_file.read_exact(&mut found_mag)?;
        if found_mag != self.magic {
            return Err(ZaliError::FormatMismatch);
        }
        let version = in_file.read_u8()?;
        if version != PROTOCOL_VERSION {
            return Err(ZaliError::VersionMismatch);
        }

        let read_str = |f: &mut File| -> io::Result<String> {
            let len = f.read_u8()? as usize;
            let mut b = vec![0u8; len];
            f.read_exact(&mut b)?;
            Ok(String::from_utf8_lossy(&b).into_owned())
        };
        read_str(&mut in_file)?;
        read_str(&mut in_file)?; // skip id, dom
        let flags = in_file.read_u8()?;
        let count = in_file.read_u32::<LittleEndian>()?;

        const MAX_ARCHIVE_FILES: u32 = 10_000;
        const MAX_TOTAL_EXTRACTED_BYTES: u64 = 4 * 1024 * 1024 * 1024;
        if count > MAX_ARCHIVE_FILES {
            return Err(ZaliError::FormatMismatch);
        }

        let is_enc = flags & 1 != 0;
        let mut key = [0u8; 32];
        let mut base_nonce = [0u8; 12];
        if is_enc {
            let pwd = self.password.as_ref().ok_or(ZaliError::AuthFailed)?;
            let mut salt = [0u8; 16];
            in_file.read_exact(&mut salt)?;
            in_file.read_exact(&mut base_nonce)?;
            pbkdf2_hmac::<Sha256>(pwd.as_bytes(), &salt, PBKDF2_ITERS, &mut key);
        }

        let out_base = PathBuf::from(output_dir);
        let mut chunk_idx: u32 = 1;
        let mut buf = vec![0u8; CHUNK_SIZE + 64];
        let mut total_extracted: u64 = 0;

        for i in 0..count {
            let n_len = in_file.read_u16::<LittleEndian>()? as usize;
            let mut n_b = vec![0u8; n_len];
            in_file.read_exact(&mut n_b)?;
            let name = String::from_utf8_lossy(&n_b).into_owned();
            let o_size = in_file.read_u64::<LittleEndian>()?;
            let e_size = in_file.read_u64::<LittleEndian>()?;

            total_extracted = total_extracted.saturating_add(o_size);
            if total_extracted > MAX_TOTAL_EXTRACTED_BYTES {
                return Err(ZaliError::Io(io::Error::other(
                    "Archive extraction limit exceeded",
                )));
            }

            let skip = match &items {
                Some(list) => !list.contains(&name),
                None => false,
            };
            if skip {
                let offset = i64::try_from(e_size)
                    .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "File too large"))?;
                in_file.seek(SeekFrom::Current(offset))?;
                if is_enc {
                    let num = o_size.div_ceil(CHUNK_SIZE as u64);
                    let num = u32::try_from(num)
                        .map_err(|_| ZaliError::Crypto("Chunk index overflow".to_string()))?;
                    chunk_idx = chunk_idx
                        .checked_add(num)
                        .ok_or_else(|| ZaliError::Crypto("Chunk index overflow".to_string()))?;
                }
                continue;
            }

            let name_path = Path::new(&name);
            if name_path.is_absolute()
                || name_path.components().any(|component| {
                    matches!(
                        component,
                        std::path::Component::ParentDir
                            | std::path::Component::RootDir
                            | std::path::Component::Prefix(_)
                    )
                })
            {
                return Err(ZaliError::PathTraversal);
            }
            let target = out_base.join(&name);
            if !target.starts_with(&out_base) {
                return Err(ZaliError::PathTraversal);
            }
            if let Some(p) = target.parent() {
                fs::create_dir_all(p)?;
            }

            let mut out_file = File::create(&target)?;
            let mut rem = e_size;
            while rem > 0 {
                if is_enc {
                    let c = (rem as usize).min(CHUNK_SIZE + 16);
                    in_file.read_exact(&mut buf[..c])?;
                    let mut n_b = base_nonce;
                    let counter = u32::from_le_bytes(n_b[8..12].try_into().unwrap_or([0u8; 4]));
                    n_b[8..12].copy_from_slice(&counter.wrapping_add(chunk_idx).to_le_bytes());
                    chunk_idx = chunk_idx
                        .checked_add(1)
                        .ok_or_else(|| ZaliError::Crypto("Chunk index overflow".to_string()))?;
                    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
                    let decrypted = cipher
                        .decrypt(Nonce::from_slice(&n_b), &buf[..c])
                        .map_err(|_| ZaliError::AuthFailed)?;
                    out_file.write_all(&decrypted)?;
                    rem -= c as u64;
                } else {
                    let n = (rem as usize).min(CHUNK_SIZE);
                    in_file.read_exact(&mut buf[..n])?;
                    out_file.write_all(&buf[..n])?;
                    rem -= n as u64;
                }
            }
            progress((i + 1) as f64 / count as f64, &name);
        }
        Ok(())
    }
}
