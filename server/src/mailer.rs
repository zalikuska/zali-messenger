//! Почтовый сервер мессенджера: исходящие письма — коды подтверждения почты и
//! сброса пароля, уведомления о смене почты и пароля.
//!
//! Режим — `MAIL_TRANSPORT`:
//!
//! - `direct` — сервер сам доставляет письмо на MX домена получателя (порт 25,
//!   STARTTLS там, где его предлагают) и подписывает его DKIM. Отдельный
//!   Postfix не нужен; входящую почту сервер не принимает — письма «no-reply».
//!   Нужны DNS-записи SPF, DKIM и DMARC и PTR адреса сервера (`docs/MAIL.md`),
//!   и открытый исходящий 25-й порт у хостера.
//! - `smtp` — отдаёт письмо SMTP-relay с логином (свой Postfix или провайдер),
//!   STARTTLS (587) или TLS (465); без шифрования — только relay на loopback.
//! - `file` — пишет письма в каталог (`MAIL_OUTBOX_DIR`, по умолчанию
//!   `<data_dir>/mail-outbox`): `.eml`, HTML-превью и `.json`. По умолчанию в
//!   debug-сборке — для разработки и интеграционных тестов.
//! - `off` — почта выключена; по умолчанию в релизе без настройки. Эндпоинты
//!   почты отвечают 503, `/api/auth/email/config` — `enabled: false`, и клиент
//!   не показывает ни поля почты, ни «Забыли пароль?».
//!
//! Ошибка в настройке (нет `MAIL_FROM`, битый DKIM-ключ, relay без TLS наружу)
//! выключает почту целиком с ошибкой в логе, а не шлёт письма кое-как: неподписанное
//! письмо уйдёт в спам, и человек решит, что код просто не пришёл.
//!
//! Отправка — очередь в памяти: обработчик запроса не ждёт SMTP (прямая доставка
//! на чужой MX — секунды, а серый список отвечает «зайдите позже»), повторы на
//! временных ошибках идут через 30 с, 2, 5 и 10 минут — дольше живёт только код.
//! Перезапуск сервера очередь теряет: письмо с кодом проще запросить заново, чем
//! хранить коды на диске открытым текстом.
//!
//! Коды и токены в лог не попадают никогда, адрес — только маской.

use crate::mail_templates;
use hickory_resolver::TokioResolver;
use lettre::{
    message::{
        dkim::{DkimCanonicalization, DkimCanonicalizationType, DkimConfig, DkimSigningAlgorithm, DkimSigningKey},
        header::{HeaderName, HeaderValue},
        Mailbox, MultiPart,
    },
    transport::smtp::{
        authentication::Credentials,
        client::{Tls, TlsParameters},
        extension::ClientId,
    },
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
};
use std::{
    net::IpAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::sync::{mpsc, Semaphore};
use tracing::{error, info, warn};
use uuid::Uuid;

const QUEUE_CAPACITY: usize = 1024;
const MAX_PARALLEL_DELIVERIES: usize = 8;
const RETRY_DELAYS_SECS: [u64; 4] = [30, 120, 300, 600];
const SMTP_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TransportKind {
    Off,
    File,
    Smtp,
    Direct,
}

impl TransportKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            TransportKind::Off => "off",
            TransportKind::File => "file",
            TransportKind::Smtp => "smtp",
            TransportKind::Direct => "direct",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SmtpSecurity {
    StartTls,
    Tls,
    Plain,
}

/// Настройки почты из окружения. Без `Debug`: внутри пароль relay.
#[derive(Clone)]
pub struct MailSettings {
    pub(crate) kind: TransportKind,
    pub(crate) from: String,
    pub(crate) helo: Option<String>,
    pub(crate) smtp_host: Option<String>,
    pub(crate) smtp_port: Option<u16>,
    pub(crate) smtp_security: SmtpSecurity,
    pub(crate) smtp_username: Option<String>,
    pub(crate) smtp_password: Option<String>,
    pub(crate) dkim_selector: Option<String>,
    pub(crate) dkim_domain: Option<String>,
    pub(crate) dkim_key_file: Option<PathBuf>,
    pub(crate) outbox_dir: Option<PathBuf>,
}

fn env_opt(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

impl MailSettings {
    pub fn from_env() -> Self {
        let kind = match env_opt("MAIL_TRANSPORT").map(|v| v.to_lowercase()).as_deref() {
            Some("direct") | Some("mx") => TransportKind::Direct,
            Some("smtp") | Some("relay") => TransportKind::Smtp,
            Some("file") => TransportKind::File,
            Some("off") | Some("none") | Some("disabled") => TransportKind::Off,
            None if cfg!(debug_assertions) => TransportKind::File,
            None => TransportKind::Off,
            Some(other) => {
                warn!("MAIL_TRANSPORT={:?} не распознан (direct|smtp|file|off) — почта выключена", other);
                TransportKind::Off
            }
        };
        let smtp_security = match env_opt("SMTP_SECURITY").map(|v| v.to_lowercase()).as_deref() {
            Some("tls") | Some("ssl") | Some("implicit") => SmtpSecurity::Tls,
            Some("none") | Some("plain") => SmtpSecurity::Plain,
            _ => SmtpSecurity::StartTls,
        };
        let smtp_password = env_opt("SMTP_PASSWORD").or_else(|| {
            env_opt("SMTP_PASSWORD_FILE")
                .and_then(|path| std::fs::read_to_string(path).ok())
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        });
        let default_from = if cfg!(debug_assertions) {
            "ZaliMessenger <no-reply@localhost.localdomain>".to_string()
        } else {
            String::new()
        };
        MailSettings {
            kind,
            from: env_opt("MAIL_FROM").unwrap_or(default_from),
            helo: env_opt("MAIL_HELO_NAME"),
            smtp_host: env_opt("SMTP_HOST"),
            smtp_port: env_opt("SMTP_PORT").and_then(|v| v.parse().ok()),
            smtp_security,
            smtp_username: env_opt("SMTP_USERNAME"),
            smtp_password,
            dkim_selector: env_opt("DKIM_SELECTOR"),
            dkim_domain: env_opt("DKIM_DOMAIN"),
            dkim_key_file: env_opt("DKIM_PRIVATE_KEY_FILE").map(PathBuf::from),
            outbox_dir: env_opt("MAIL_OUTBOX_DIR").map(PathBuf::from),
        }
    }

    /// Почта в файлы, в заданный каталог — для интеграционных тестов.
    pub fn file_outbox(dir: PathBuf) -> Self {
        let mut settings = MailSettings::from_env();
        settings.kind = TransportKind::File;
        settings.outbox_dir = Some(dir);
        if settings.from.is_empty() {
            settings.from = "ZaliMessenger <no-reply@localhost.localdomain>".to_string();
        }
        settings
    }

    /// Почта выключена — как релиз без настройки.
    pub fn disabled() -> Self {
        let mut settings = MailSettings::from_env();
        settings.kind = TransportKind::Off;
        settings
    }
}

/// Письмо в очереди. Тексты уже отрисованы (`mail_templates`).
#[derive(Clone)]
pub(crate) struct OutgoingMail {
    pub to: String,
    pub kind: &'static str,
    pub subject: String,
    pub text: String,
    pub html: String,
}

impl OutgoingMail {
    pub(crate) fn new(to: &str, kind: &'static str, rendered: mail_templates::Rendered) -> Self {
        OutgoingMail {
            to: to.to_string(),
            kind,
            subject: rendered.subject,
            text: rendered.text,
            html: rendered.html,
        }
    }
}

/// Ручка очереди в `AppState`.
pub(crate) struct Mailer {
    tx: Option<mpsc::Sender<OutgoingMail>>,
    kind: TransportKind,
}

impl Mailer {
    pub(crate) fn start(settings: &MailSettings, data_dir: &Path) -> Mailer {
        match Engine::build(settings, data_dir) {
            Ok(None) => {
                info!("Почта выключена (MAIL_TRANSPORT=off): привязка почты и сброс пароля недоступны");
                Mailer { tx: None, kind: TransportKind::Off }
            }
            Ok(Some(engine)) => {
                let kind = engine.kind;
                info!("Почта: режим {}, отправитель {}", kind.as_str(), engine.from);
                let (tx, rx) = mpsc::channel(QUEUE_CAPACITY);
                tokio::spawn(run_queue(Arc::new(engine), rx));
                Mailer { tx: Some(tx), kind }
            }
            Err(e) => {
                error!("Почта выключена: ошибка настройки — {}", e);
                Mailer { tx: None, kind: TransportKind::Off }
            }
        }
    }

    pub(crate) fn enabled(&self) -> bool {
        self.tx.is_some()
    }

    #[allow(dead_code)]
    pub(crate) fn kind(&self) -> TransportKind {
        self.kind
    }

    /// Ставит письмо в очередь. `false` — почта выключена или очередь забита.
    pub(crate) fn enqueue(&self, mail: OutgoingMail) -> bool {
        let Some(tx) = &self.tx else { return false };
        match tx.try_send(mail) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(mail)) => {
                warn!("Почтовая очередь заполнена — письмо {} для {} отброшено", mail.kind, mail_templates::mask_email(&mail.to));
                false
            }
            Err(mpsc::error::TrySendError::Closed(_)) => false,
        }
    }
}

enum Delivery {
    File(PathBuf),
    Smtp(AsyncSmtpTransport<Tokio1Executor>),
    Direct { helo: String, resolver: TokioResolver },
}

enum Outcome {
    Delivered(String),
    Transient(String),
    Permanent(String),
}

struct Engine {
    kind: TransportKind,
    from: Mailbox,
    message_id_domain: String,
    dkim: Option<DkimConfig>,
    delivery: Delivery,
}

fn domain_of(address: &str) -> Option<String> {
    address.rsplit_once('@').map(|(_, d)| d.trim().trim_end_matches('.').to_lowercase()).filter(|d| !d.is_empty())
}

fn is_loopback_host(host: &str) -> bool {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    host.eq_ignore_ascii_case("localhost")
        || host.parse::<IpAddr>().map(|ip| ip.is_loopback()).unwrap_or(false)
}

fn load_dkim(settings: &MailSettings, from_domain: &str) -> Result<Option<DkimConfig>, String> {
    let Some(path) = &settings.dkim_key_file else {
        if settings.dkim_selector.is_some() {
            return Err("DKIM_SELECTOR задан, а DKIM_PRIVATE_KEY_FILE — нет".to_string());
        }
        return Ok(None);
    };
    let selector = settings
        .dkim_selector
        .clone()
        .ok_or_else(|| "DKIM_PRIVATE_KEY_FILE задан, а DKIM_SELECTOR — нет".to_string())?;
    let pem = std::fs::read_to_string(path).map_err(|e| format!("не читается DKIM-ключ {}: {}", path.display(), e))?;
    let key = DkimSigningKey::new(&pem, DkimSigningAlgorithm::Rsa)
        .map_err(|e| format!("DKIM-ключ {} не разобран (нужен RSA PKCS#1 PEM — `zali_server mail dkim-keygen`): {:?}", path.display(), e))?;
    let domain = settings.dkim_domain.clone().unwrap_or_else(|| from_domain.to_string());
    let headers = ["From", "To", "Subject", "Date", "Message-ID", "MIME-Version", "Content-Type"]
        .into_iter()
        .map(HeaderName::new_from_ascii_str)
        .collect();
    Ok(Some(DkimConfig::new(
        selector,
        domain,
        key,
        headers,
        DkimCanonicalization {
            header: DkimCanonicalizationType::Relaxed,
            body: DkimCanonicalizationType::Relaxed,
        },
    )))
}

impl Engine {
    fn build(settings: &MailSettings, data_dir: &Path) -> Result<Option<Engine>, String> {
        if settings.kind == TransportKind::Off {
            return Ok(None);
        }
        if settings.from.is_empty() {
            return Err("не задан MAIL_FROM (например `ZaliMessenger <no-reply@example.org>`)".to_string());
        }
        let from: Mailbox = settings.from.parse().map_err(|e| format!("MAIL_FROM не разобран: {e}"))?;
        let from_domain = domain_of(&from.email.to_string()).ok_or("в MAIL_FROM нет домена")?;
        let helo = settings.helo.clone().unwrap_or_else(|| from_domain.clone());
        let dkim = load_dkim(settings, &from_domain)?;

        let delivery = match settings.kind {
            TransportKind::Off => return Ok(None),
            TransportKind::File => {
                let dir = settings.outbox_dir.clone().unwrap_or_else(|| data_dir.join("mail-outbox"));
                std::fs::create_dir_all(&dir).map_err(|e| format!("каталог писем {}: {}", dir.display(), e))?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    // Внутри — живые коды: только владельцу процесса.
                    let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
                }
                Delivery::File(dir)
            }
            TransportKind::Smtp => {
                let host = settings.smtp_host.clone().ok_or("MAIL_TRANSPORT=smtp, а SMTP_HOST не задан")?;
                if settings.smtp_security == SmtpSecurity::Plain && !is_loopback_host(&host) {
                    return Err(format!(
                        "SMTP_SECURITY=none допустим только для relay на loopback, а SMTP_HOST={host}: логин и письма ушли бы открытым текстом"
                    ));
                }
                let builder = match settings.smtp_security {
                    SmtpSecurity::StartTls => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&host)
                        .map_err(|e| format!("SMTP relay {host}: {e}"))?,
                    SmtpSecurity::Tls => AsyncSmtpTransport::<Tokio1Executor>::relay(&host)
                        .map_err(|e| format!("SMTP relay {host}: {e}"))?,
                    SmtpSecurity::Plain => AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(host.clone()),
                };
                let default_port = match settings.smtp_security {
                    SmtpSecurity::StartTls => 587,
                    SmtpSecurity::Tls => 465,
                    SmtpSecurity::Plain => 25,
                };
                let mut builder = builder
                    .port(settings.smtp_port.unwrap_or(default_port))
                    .hello_name(ClientId::Domain(helo.clone()))
                    .timeout(Some(SMTP_TIMEOUT));
                match (&settings.smtp_username, &settings.smtp_password) {
                    (Some(user), Some(pass)) => {
                        builder = builder.credentials(Credentials::new(user.clone(), pass.clone()));
                    }
                    (Some(_), None) => return Err("SMTP_USERNAME задан без SMTP_PASSWORD/SMTP_PASSWORD_FILE".to_string()),
                    _ => {}
                }
                Delivery::Smtp(builder.build())
            }
            TransportKind::Direct => {
                if dkim.is_none() {
                    warn!(
                        "MAIL_TRANSPORT=direct без DKIM: Gmail и Яндекс положат такие письма в спам или отвергнут. \
                         Сгенерируйте ключ: `zali_server mail dkim-keygen`"
                    );
                }
                let resolver = TokioResolver::builder_tokio()
                    .map_err(|e| format!("системный DNS-резолвер: {e}"))?
                    .build();
                Delivery::Direct { helo, resolver }
            }
        };

        Ok(Some(Engine {
            kind: settings.kind,
            from,
            message_id_domain: from_domain,
            dkim,
            delivery,
        }))
    }

    fn build_message(&self, mail: &OutgoingMail) -> Result<Message, String> {
        let to: Mailbox = mail.to.parse().map_err(|e| format!("адрес получателя не разобран: {e}"))?;
        let mut message = Message::builder()
            .from(self.from.clone())
            .to(to)
            .subject(mail.subject.clone())
            .message_id(Some(format!("<{}@{}>", Uuid::new_v4().simple(), self.message_id_domain)))
            // RFC 3834: автоответчики («я в отпуске») на такие письма не отвечают.
            .raw_header(HeaderValue::new(
                HeaderName::new_from_ascii_str("Auto-Submitted"),
                "auto-generated".to_string(),
            ))
            .raw_header(HeaderValue::new(
                HeaderName::new_from_ascii_str("X-Auto-Response-Suppress"),
                "All".to_string(),
            ))
            .multipart(MultiPart::alternative_plain_html(mail.text.clone(), mail.html.clone()))
            .map_err(|e| format!("письмо не собрано: {e}"))?;
        if let Some(dkim) = &self.dkim {
            message.sign(dkim);
        }
        Ok(message)
    }

    async fn deliver_once(&self, mail: &OutgoingMail, message: &Message) -> Outcome {
        match &self.delivery {
            Delivery::File(dir) => deliver_to_file(dir, mail, message).await,
            Delivery::Smtp(transport) => match transport.send(message.clone()).await {
                Ok(_) => Outcome::Delivered("relay".to_string()),
                Err(e) if e.is_permanent() => Outcome::Permanent(e.to_string()),
                Err(e) => Outcome::Transient(e.to_string()),
            },
            Delivery::Direct { helo, resolver } => {
                let Some(domain) = domain_of(&mail.to) else {
                    return Outcome::Permanent("в адресе нет домена".to_string());
                };
                deliver_direct(helo, resolver, message, &domain).await
            }
        }
    }
}

async fn deliver_to_file(dir: &Path, mail: &OutgoingMail, message: &Message) -> Outcome {
    // Без точек в основе имени: расширение дописывается строкой, а не
    // `with_extension`, который отрезал бы всё после первой же точки.
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%3fZ");
    let base = format!("{stamp}-{}-{}", mail.kind, Uuid::new_v4().simple());
    let path = |ext: &str| dir.join(format!("{base}.{ext}"));
    let json = serde_json::json!({
        "to": mail.to,
        "kind": mail.kind,
        "subject": mail.subject,
        "text": mail.text,
    });
    let writes = async {
        tokio::fs::write(path("eml"), message.formatted()).await?;
        tokio::fs::write(path("html"), mail.html.as_bytes()).await?;
        // `.json` последним: тест ждёт именно его, к этому моменту остальное записано.
        tokio::fs::write(path("json"), json.to_string()).await
    };
    match writes.await {
        Ok(()) => Outcome::Delivered(format!("{}", path("eml").display())),
        Err(e) => Outcome::Transient(format!("запись в {}: {}", dir.display(), e)),
    }
}

/// MX-хосты домена по приоритету. Нет MX — сам домен (неявный MX, RFC 5321 §5.1);
/// «нулевой» MX (`.`, RFC 7505) — домен почту не принимает.
async fn mx_hosts(resolver: &TokioResolver, domain: &str) -> Result<Vec<String>, Outcome> {
    match resolver.mx_lookup(format!("{domain}.")).await {
        Ok(lookup) => {
            let mut records: Vec<(u16, String)> = lookup
                .iter()
                .map(|mx| (mx.preference(), mx.exchange().to_ascii().trim_end_matches('.').to_lowercase()))
                .collect();
            if records.iter().all(|(_, host)| host.is_empty()) {
                return Err(Outcome::Permanent(format!("домен {domain} не принимает почту (null MX)")));
            }
            records.sort_by_key(|(pref, _)| *pref);
            let mut hosts: Vec<String> = Vec::new();
            for (_, host) in records {
                if !host.is_empty() && !hosts.contains(&host) {
                    hosts.push(host);
                }
            }
            Ok(hosts)
        }
        Err(e) if e.is_no_records_found() => Ok(vec![domain.to_string()]),
        Err(e) => Err(Outcome::Transient(format!("MX {domain}: {e}"))),
    }
}

/// Публичные адреса хоста, IPv4 первыми: с IPv6 крупные почтовики строже
/// (обязательный PTR), а у многих VPS исходящего IPv6 нет вовсе. Внутренние
/// адреса отбрасываются: MX чужого домена может указывать на 127.0.0.1 или
/// 10.0.0.0/8, и сервер не должен стучаться по такому адресу во внутреннюю сеть.
async fn public_addrs(resolver: &TokioResolver, host: &str) -> Result<Vec<IpAddr>, String> {
    let lookup = resolver
        .lookup_ip(format!("{host}."))
        .await
        .map_err(|e| format!("{host}: {e}"))?;
    let mut addrs: Vec<IpAddr> = lookup.iter().filter(|ip| crate::push::is_public_ip(*ip)).collect();
    addrs.sort_by_key(|ip| if ip.is_ipv4() { 0 } else { 1 });
    addrs.dedup();
    Ok(addrs)
}

async fn send_direct_once(
    helo: &str,
    host: &str,
    ip: IpAddr,
    message: &Message,
    verify_certificate: bool,
) -> Result<(), lettre::transport::smtp::Error> {
    // Соединение — на проверенный адрес, а имя MX — только для TLS (SNI и проверка
    // сертификата): второй резолв внутри lettre мог бы вернуть уже другой адрес.
    let tls = TlsParameters::builder(host.to_string())
        .dangerous_accept_invalid_certs(!verify_certificate)
        .build()?;
    let transport = AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(ip.to_string())
        .port(25)
        .hello_name(ClientId::Domain(helo.to_string()))
        .tls(Tls::Opportunistic(tls))
        .timeout(Some(SMTP_TIMEOUT))
        .build();
    transport.send(message.clone()).await.map(|_| ())
}

async fn deliver_direct(helo: &str, resolver: &TokioResolver, message: &Message, domain: &str) -> Outcome {
    let hosts = match mx_hosts(resolver, domain).await {
        Ok(hosts) => hosts,
        Err(outcome) => return outcome,
    };
    let mut last_error = format!("у {domain} нет доступных MX");
    let mut any_address = false;
    for host in hosts.iter().take(5) {
        let addrs = match public_addrs(resolver, host).await {
            Ok(addrs) => addrs,
            Err(e) => {
                last_error = e;
                continue;
            }
        };
        if addrs.is_empty() {
            last_error = format!("{host}: нет публичных адресов");
            continue;
        }
        any_address = true;
        for ip in addrs.iter().take(2) {
            match send_direct_once(helo, host, *ip, message, true).await {
                Ok(()) => return Outcome::Delivered(format!("{host} [{ip}]")),
                Err(e) if e.is_permanent() => return Outcome::Permanent(format!("{host}: {e}")),
                Err(e) if e.is_tls() => {
                    // Как Postfix с `smtp_tls_security_level = may`: сертификат MX,
                    // не совпавший с именем, не повод слать открытым текстом или не
                    // слать вовсе — шифрование остаётся, проверка подлинности нет.
                    match send_direct_once(helo, host, *ip, message, false).await {
                        Ok(()) => return Outcome::Delivered(format!("{host} [{ip}], сертификат не проверен")),
                        Err(e) if e.is_permanent() => return Outcome::Permanent(format!("{host}: {e}")),
                        Err(e) => last_error = format!("{host} [{ip}]: {e}"),
                    }
                }
                Err(e) => last_error = format!("{host} [{ip}]: {e}"),
            }
        }
    }
    if !any_address && hosts.len() == 1 && hosts[0] == domain {
        // Ни MX, ни адреса у самого домена: опечатка в домене, а не временная беда.
        return Outcome::Permanent(format!("домен {domain} не принимает почту: {last_error}"));
    }
    Outcome::Transient(last_error)
}

async fn run_queue(engine: Arc<Engine>, mut rx: mpsc::Receiver<OutgoingMail>) {
    let slots = Arc::new(Semaphore::new(MAX_PARALLEL_DELIVERIES));
    while let Some(mail) = rx.recv().await {
        let engine = Arc::clone(&engine);
        let slots = Arc::clone(&slots);
        tokio::spawn(async move { deliver_with_retry(engine, slots, mail).await });
    }
}

async fn deliver_with_retry(engine: Arc<Engine>, slots: Arc<Semaphore>, mail: OutgoingMail) {
    let masked = mail_templates::mask_email(&mail.to);
    let message = match engine.build_message(&mail) {
        Ok(message) => message,
        Err(e) => {
            error!("Письмо {} для {} не отправлено: {}", mail.kind, masked, e);
            return;
        }
    };
    for attempt in 0..=RETRY_DELAYS_SECS.len() {
        let outcome = {
            // Слот — на попытку, а не на всё письмо: ожидание повтора не держит очередь.
            let _slot = slots.acquire().await;
            engine.deliver_once(&mail, &message).await
        };
        match outcome {
            Outcome::Delivered(via) => {
                info!("Письмо {} для {} отправлено ({}, попытка {}): {}", mail.kind, masked, engine.kind.as_str(), attempt + 1, via);
                return;
            }
            Outcome::Permanent(reason) => {
                warn!("Письмо {} для {} отвергнуто окончательно: {}", mail.kind, masked, reason);
                return;
            }
            Outcome::Transient(reason) => {
                let Some(delay) = RETRY_DELAYS_SECS.get(attempt) else {
                    warn!("Письмо {} для {} так и не доставлено после {} попыток: {}", mail.kind, masked, attempt + 1, reason);
                    return;
                };
                warn!("Письмо {} для {}: временная ошибка, повтор через {} с — {}", mail.kind, masked, delay, reason);
                tokio::time::sleep(Duration::from_secs(*delay)).await;
            }
        }
    }
}

// ============================================================
// CLI: zali_server mail <команда>
// ============================================================

fn dkim_public_key_b64(pem: &str) -> Result<String, String> {
    use base64::Engine as _;
    use rsa::{pkcs1::DecodeRsaPrivateKey, pkcs8::EncodePublicKey, RsaPublicKey};
    let private = rsa::RsaPrivateKey::from_pkcs1_pem(pem).map_err(|e| format!("ключ не разобран: {e}"))?;
    let der = RsaPublicKey::from(&private)
        .to_public_key_der()
        .map_err(|e| format!("публичный ключ: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(der.as_bytes()))
}

async fn txt_records(resolver: &TokioResolver, name: &str) -> Vec<String> {
    match resolver.txt_lookup(format!("{name}.")).await {
        Ok(lookup) => lookup
            .iter()
            .map(|txt| {
                txt.txt_data()
                    .iter()
                    .map(|part| String::from_utf8_lossy(part).to_string())
                    .collect::<String>()
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

fn arg_value(args: &[String], flag: &str) -> Option<String> {
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned()
}

const CLI_HELP: &str = "Почтовый сервер ZaliMessenger.

  zali_server mail check                 настройки из окружения, DNS (SPF/DKIM/DMARC), исходящий 25-й порт
  zali_server mail test <адрес>          отправить проверочное письмо сейчас, без очереди
  zali_server mail dkim-keygen [--selector zali] [--domain example.org] [--out dkim.pem]
                                         RSA-2048 для DKIM и готовая TXT-запись для DNS
  zali_server mail preview [каталог]     все письма в HTML-файлы — посмотреть вёрстку в браузере

Переменные: MAIL_TRANSPORT (direct|smtp|file|off), MAIL_FROM, MAIL_HELO_NAME,
DKIM_SELECTOR, DKIM_PRIVATE_KEY_FILE, DKIM_DOMAIN, SMTP_HOST, SMTP_PORT,
SMTP_SECURITY (starttls|tls|none), SMTP_USERNAME, SMTP_PASSWORD(_FILE), MAIL_OUTBOX_DIR.
Подробности — docs/MAIL.md.";

pub async fn cli(args: &[String]) -> i32 {
    match args.first().map(String::as_str) {
        Some("check") => cli_check().await,
        Some("test") => match args.get(1) {
            Some(to) => cli_test(to).await,
            None => {
                eprintln!("Укажите адрес: zali_server mail test you@example.org");
                2
            }
        },
        Some("dkim-keygen") => cli_dkim_keygen(args),
        Some("preview") => cli_preview(args.get(1).map(PathBuf::from)),
        _ => {
            println!("{CLI_HELP}");
            if args.is_empty() { 0 } else { 2 }
        }
    }
}

fn cli_dkim_keygen(args: &[String]) -> i32 {
    use rsa::pkcs1::{EncodeRsaPrivateKey, LineEnding};
    let settings = MailSettings::from_env();
    let selector = arg_value(args, "--selector").or(settings.dkim_selector.clone()).unwrap_or_else(|| "zali".to_string());
    let domain = arg_value(args, "--domain")
        .or(settings.dkim_domain.clone())
        .or_else(|| settings.from.parse::<Mailbox>().ok().and_then(|m| domain_of(&m.email.to_string())))
        .unwrap_or_else(|| "example.org".to_string());
    let out = PathBuf::from(arg_value(args, "--out").unwrap_or_else(|| "dkim.pem".to_string()));
    if out.exists() {
        eprintln!("{} уже существует — не перезаписываю (ключ в DNS сломался бы молча). Удалите файл сами или задайте --out.", out.display());
        return 1;
    }
    println!("Генерирую RSA-2048…");
    let private = match rsa::RsaPrivateKey::new(&mut rand::rngs::OsRng, 2048) {
        Ok(key) => key,
        Err(e) => {
            eprintln!("Не удалось сгенерировать ключ: {e}");
            return 1;
        }
    };
    let pem = match private.to_pkcs1_pem(LineEnding::LF) {
        Ok(pem) => pem,
        Err(e) => {
            eprintln!("Не удалось записать ключ: {e}");
            return 1;
        }
    };
    let write = {
        #[cfg(unix)]
        {
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&out)
                .and_then(|mut f| f.write_all(pem.as_bytes()))
        }
        #[cfg(not(unix))]
        {
            std::fs::write(&out, pem.as_bytes())
        }
    };
    if let Err(e) = write {
        eprintln!("Не удалось записать {}: {e}", out.display());
        return 1;
    }
    let public = match dkim_public_key_b64(&pem) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
    println!("Закрытый ключ: {} (0600). В окружение сервера:", out.display());
    println!("  DKIM_SELECTOR={selector}\n  DKIM_PRIVATE_KEY_FILE={}\n", out.display());
    println!("TXT-запись в DNS домена {domain}:");
    println!("  {selector}._domainkey.{domain}.  TXT  \"v=DKIM1; k=rsa; p={public}\"");
    println!("\nНекоторые панели DNS режут строки длиннее 255 символов — тогда разбейте значение на части в кавычках.");
    0
}

fn cli_preview(dir: Option<PathBuf>) -> i32 {
    let dir = dir.unwrap_or_else(|| PathBuf::from("mail-preview"));
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("{}: {e}", dir.display());
        return 1;
    }
    let letters = [
        ("link-code", mail_templates::link_code("alexander", "482915", 900)),
        ("reset-code", mail_templates::reset_code("alexander", "730264", 900)),
        ("email-changed", mail_templates::email_changed_notice("alexander", "alexander.new@example.org")),
        ("password-reset", mail_templates::password_reset_notice("alexander")),
        ("test", mail_templates::test_letter("123456")),
    ];
    for (name, letter) in letters {
        let path = dir.join(format!("{name}.html"));
        if let Err(e) = std::fs::write(&path, letter.html.as_bytes()) {
            eprintln!("{}: {e}", path.display());
            return 1;
        }
        let _ = std::fs::write(dir.join(format!("{name}.txt")), format!("Subject: {}\n\n{}", letter.subject, letter.text));
        println!("{}", path.display());
    }
    0
}

async fn cli_test(to: &str) -> i32 {
    let settings = MailSettings::from_env();
    let normalized = match crate::account_email::normalize_email(to) {
        Ok(addr) => addr,
        Err(e) => {
            eprintln!("Адрес не принят: {e}");
            return 2;
        }
    };
    let data_dir = crate::canonical_data_dir();
    let engine = match Engine::build(&settings, &data_dir) {
        Ok(Some(engine)) => engine,
        Ok(None) => {
            eprintln!("Почта выключена (MAIL_TRANSPORT=off или не задан в релизе).");
            return 1;
        }
        Err(e) => {
            eprintln!("Ошибка настройки: {e}");
            return 1;
        }
    };
    let code = format!("{:06}", rand::Rng::gen_range(&mut rand::rngs::OsRng, 0..1_000_000u32));
    let mail = OutgoingMail::new(&normalized, "test", mail_templates::test_letter(&code));
    let message = match engine.build_message(&mail) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
    println!(
        "Отправляю через {} от {}{}…",
        engine.kind.as_str(),
        engine.from,
        if engine.dkim.is_some() { ", с DKIM" } else { ", без DKIM" }
    );
    match engine.deliver_once(&mail, &message).await {
        Outcome::Delivered(via) => {
            println!("Принято: {via}");
            0
        }
        Outcome::Transient(e) => {
            eprintln!("Временная ошибка (сервер повторил бы позже): {e}");
            1
        }
        Outcome::Permanent(e) => {
            eprintln!("Отвергнуто: {e}");
            1
        }
    }
}

async fn cli_check() -> i32 {
    let settings = MailSettings::from_env();
    println!("Режим:        {}", settings.kind.as_str());
    println!("Отправитель:  {}", if settings.from.is_empty() { "(MAIL_FROM не задан)" } else { &settings.from });
    let from_domain = settings
        .from
        .parse::<Mailbox>()
        .ok()
        .and_then(|m| domain_of(&m.email.to_string()));
    let helo = settings.helo.clone().or(from_domain.clone()).unwrap_or_default();
    println!("EHLO:         {helo}");
    match settings.kind {
        TransportKind::Smtp => println!(
            "Relay:        {}:{} ({:?}){}",
            settings.smtp_host.as_deref().unwrap_or("(SMTP_HOST не задан)"),
            settings.smtp_port.map(|p| p.to_string()).unwrap_or_else(|| "по умолчанию".to_string()),
            settings.smtp_security,
            if settings.smtp_username.is_some() { ", с логином" } else { "" }
        ),
        TransportKind::File => println!(
            "Каталог:      {}",
            settings
                .outbox_dir
                .clone()
                .unwrap_or_else(|| crate::canonical_data_dir().join("mail-outbox"))
                .display()
        ),
        _ => {}
    }
    let mut problems = 0;
    match Engine::build(&settings, &crate::canonical_data_dir()) {
        Ok(Some(_)) => println!("Настройка:    ✓ разобрана"),
        Ok(None) => println!("Настройка:    почта выключена"),
        Err(e) => {
            println!("Настройка:    ✗ {e}");
            problems += 1;
        }
    }
    let Some(domain) = from_domain else {
        return if problems == 0 { 0 } else { 1 };
    };
    let resolver = match TokioResolver::builder_tokio() {
        Ok(builder) => builder.build(),
        Err(e) => {
            println!("DNS:          ✗ резолвер: {e}");
            return 1;
        }
    };

    let spf = txt_records(&resolver, &domain).await.into_iter().find(|t| t.starts_with("v=spf1"));
    match &spf {
        Some(record) => println!("SPF:          ✓ {record}"),
        None => {
            println!("SPF:          ✗ нет TXT `v=spf1 …` у {domain} — добавьте, например: v=spf1 ip4:<адрес сервера> -all");
            problems += 1;
        }
    }

    match (&settings.dkim_selector, &settings.dkim_key_file) {
        (Some(selector), Some(key_file)) => {
            let dkim_domain = settings.dkim_domain.clone().unwrap_or_else(|| domain.clone());
            let name = format!("{selector}._domainkey.{dkim_domain}");
            let published = txt_records(&resolver, &name).await.into_iter().find(|t| t.contains("p="));
            let local = std::fs::read_to_string(key_file).map_err(|e| e.to_string()).and_then(|pem| dkim_public_key_b64(&pem));
            match (published, local) {
                (Some(record), Ok(public)) => {
                    let compact: String = record.chars().filter(|c| !c.is_whitespace()).collect();
                    if compact.contains(&format!("p={public}")) {
                        println!("DKIM:         ✓ {name} совпадает с ключом");
                    } else {
                        println!("DKIM:         ✗ {name} опубликован, но не совпадает с {}", key_file.display());
                        problems += 1;
                    }
                }
                (None, _) => {
                    println!("DKIM:         ✗ нет TXT у {name}");
                    problems += 1;
                }
                (_, Err(e)) => {
                    println!("DKIM:         ✗ ключ {}: {e}", key_file.display());
                    problems += 1;
                }
            }
        }
        _ => {
            println!("DKIM:         ✗ не настроен (DKIM_SELECTOR + DKIM_PRIVATE_KEY_FILE)");
            if settings.kind == TransportKind::Direct {
                problems += 1;
            }
        }
    }

    let dmarc = txt_records(&resolver, &format!("_dmarc.{domain}")).await.into_iter().find(|t| t.starts_with("v=DMARC1"));
    match dmarc {
        Some(record) => println!("DMARC:        ✓ {record}"),
        None => {
            println!("DMARC:        ✗ нет TXT у _dmarc.{domain} — например: v=DMARC1; p=quarantine; adkim=s; aspf=s");
            problems += 1;
        }
    }

    if settings.kind == TransportKind::Direct {
        // Многие хостеры закрывают исходящий 25-й порт: без него прямая доставка
        // невозможна, остаётся relay.
        let probe = tokio::time::timeout(
            Duration::from_secs(6),
            tokio::net::TcpStream::connect(("gmail-smtp-in.l.google.com", 25)),
        )
        .await;
        match probe {
            Ok(Ok(_)) => println!("Порт 25:      ✓ исходящие соединения проходят"),
            _ => {
                println!("Порт 25:      ✗ исходящий 25-й порт закрыт или фильтруется — попросите хостера открыть или используйте MAIL_TRANSPORT=smtp");
                problems += 1;
            }
        }
        println!("PTR:          проверьте вручную: обратная запись адреса сервера должна указывать на {helo}");
    }

    if problems == 0 {
        println!("\nГотово к отправке. Проверочное письмо: zali_server mail test you@example.org");
        0
    } else {
        println!("\nПроблем: {problems}. Подробности — docs/MAIL.md.");
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_smtp_is_refused_for_a_remote_relay() {
        let mut settings = MailSettings::disabled();
        settings.kind = TransportKind::Smtp;
        settings.from = "Zali <no-reply@example.org>".to_string();
        settings.smtp_host = Some("smtp.example.org".to_string());
        settings.smtp_security = SmtpSecurity::Plain;
        settings.dkim_key_file = None;
        settings.dkim_selector = None;
        let err = Engine::build(&settings, Path::new("/tmp")).err().expect("must refuse");
        assert!(err.contains("loopback"), "{err}");
    }

    #[test]
    fn missing_from_disables_mail() {
        let mut settings = MailSettings::disabled();
        settings.kind = TransportKind::File;
        settings.from = String::new();
        assert!(Engine::build(&settings, Path::new("/tmp")).is_err());
    }

    #[test]
    fn loopback_hosts_are_recognised() {
        assert!(is_loopback_host("localhost"));
        assert!(is_loopback_host("127.0.0.1"));
        assert!(is_loopback_host("[::1]"));
        assert!(!is_loopback_host("smtp.example.org"));
        assert!(!is_loopback_host("10.0.0.5"));
    }

    #[test]
    fn generated_dkim_key_round_trips_through_lettre() {
        use rsa::pkcs1::{EncodeRsaPrivateKey, LineEnding};
        let private = rsa::RsaPrivateKey::new(&mut rand::rngs::OsRng, 1024).unwrap();
        let pem = private.to_pkcs1_pem(LineEnding::LF).unwrap();
        assert!(DkimSigningKey::new(&pem, DkimSigningAlgorithm::Rsa).is_ok());
        assert!(dkim_public_key_b64(&pem).unwrap().len() > 100);
    }
}
