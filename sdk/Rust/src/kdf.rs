//! PBKDF2 один раз на ключ, а не на каждое сообщение.
//!
//! Каждое сообщение — это архив `.zali` (PBKDF2 на 210 000 итераций) и внутри него
//! текст `ZALIENCv3:` (ещё один PBKDF2), плюс по одному на цитату и запись о звонке.
//! Соль была случайной на каждый вызов, поэтому вывод ключа повторялся всякий раз:
//! два-три вывода на отправку и столько же на приём — и ещё по одному на каждый
//! неподошедший ключ-кандидат. В WASM это ~35 мс за вывод, на телефоне больше; на
//! этом и стояла задержка «сообщение приходит не сразу» (замер 2026-11-26).
//!
//! Формат не меняется: соль, как и раньше, лежит в заголовке, и любой клиент — в
//! том числе старый — выводит ключ из неё сам. Меняется только то, какую соль
//! выбирает упаковщик: одну случайную на пару (назначение, ключ) на время жизни
//! процесса. Тогда ключ выводится один раз и у отправителя, и у получателя, который
//! кэширует результат по (ключ, соль, итерации).
//!
//! Повтор ключа AES-GCM между сообщениями безопасен: nonce у архива — случайные
//! 96 бит на архив со счётчиком чанков в младших 32, у текста — случайные 96 бит на
//! каждое шифрование. Подбор пароля общая соль не облегчает: все эти сообщения и так
//! зашифрованы одним и тем же паролем.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock};

use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use sha2::{Digest, Sha256};

/// Потолок записей. Ключей разговоров у человека десятки, солей на ключ — по одной
/// на устройство собеседника и запуск приложения; при переполнении кэш просто
/// очищается (дальше снова один вывод на новую пару).
const DERIVED_LIMIT: usize = 2048;
const SALT_LIMIT: usize = 1024;

type Fingerprint = [u8; 32];

#[derive(Default)]
struct KdfState {
    derived: HashMap<(Fingerprint, Vec<u8>, u32), [u8; 32]>,
    writer_salts: HashMap<(&'static str, Fingerprint), [u8; 16]>,
}

fn state() -> MutexGuard<'static, KdfState> {
    static STATE: OnceLock<Mutex<KdfState>> = OnceLock::new();
    STATE
        .get_or_init(|| Mutex::new(KdfState::default()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Сам пароль в кэше не хранится — только его SHA-256.
fn fingerprint(password: &str) -> Fingerprint {
    Sha256::digest(password.as_bytes()).into()
}

/// PBKDF2-HMAC-SHA256 → 32 байта, с запоминанием по (пароль, соль, итерации).
/// Сам вывод идёт вне блокировки: параллельные распаковки не ждут друг друга.
pub fn derive_key(password: &str, salt: &[u8], iterations: u32) -> [u8; 32] {
    let cache_key = (fingerprint(password), salt.to_vec(), iterations);
    if let Some(key) = state().derived.get(&cache_key) {
        return *key;
    }
    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, iterations, &mut key);
    let mut st = state();
    if st.derived.len() >= DERIVED_LIMIT {
        st.derived.clear();
    }
    st.derived.insert(cache_key, key);
    key
}

/// Соль, которую упаковщик пишет в заголовок: случайная, но одна на пару
/// (назначение, пароль) до конца процесса. `domain` разводит слои, которые шифруют
/// одним паролем (архив и текст внутри него), по разным ключам AES.
pub fn writer_salt(domain: &'static str, password: &str) -> [u8; 16] {
    let slot = (domain, fingerprint(password));
    let mut st = state();
    if let Some(salt) = st.writer_salts.get(&slot) {
        return *salt;
    }
    if st.writer_salts.len() >= SALT_LIMIT {
        st.writer_salts.clear();
    }
    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    st.writer_salts.insert(slot, salt);
    salt
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cached_key_matches_plain_pbkdf2() {
        let salt = [7u8; 16];
        let mut expected = [0u8; 32];
        pbkdf2_hmac::<Sha256>(b"pw", &salt, 1000, &mut expected);
        assert_eq!(derive_key("pw", &salt, 1000), expected);
        // Второй раз — из кэша, тот же результат.
        assert_eq!(derive_key("pw", &salt, 1000), expected);
        assert_ne!(derive_key("pw2", &salt, 1000), expected);
        assert_ne!(derive_key("pw", &salt, 1001), expected);
    }

    #[test]
    fn writer_salt_is_stable_per_domain_and_password() {
        let a = writer_salt("test-a", "pw");
        assert_eq!(a, writer_salt("test-a", "pw"));
        assert_ne!(a, writer_salt("test-b", "pw"));
        assert_ne!(a, writer_salt("test-a", "other"));
    }
}
