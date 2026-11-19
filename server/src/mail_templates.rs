//! Письма мессенджера: код подтверждения почты, код сброса пароля и два
//! уведомления безопасности (почта сменена, пароль сброшен).
//!
//! Вёрстка — под почтовые клиенты, а не под браузер: таблицы, стили в
//! атрибутах, без внешних картинок и шрифтов (Gmail и Outlook режут `<link>`,
//! картинки по умолчанию скрыты — письмо обязано читаться без них). Знак бренда
//! нарисован ячейкой таблицы. Облик — светлая «бумага» приложения (каменный
//! холст, молочный лист, сплошной лайм только у главного — у кода), а клиентам,
//! которые понимают `prefers-color-scheme` (Apple Mail, iOS), — тёмная тема
//! приложения: почти чёрный холст и тот же лайм.
//!
//! Код в письме один раз и одной строкой: межбуквенный интервал вместо пробелов,
//! поэтому выделение и копирование дают ровно шесть цифр. В тему он тоже
//! попадает — так его видно в уведомлении, не открывая письмо.
//!
//! Ссылок в письмах нет совсем: письмо со ссылкой «войти» — ровно то, что
//! подделывают фишеры, и человек, привыкший к ним, нажмёт и на поддельную.

const BRAND: &str = "ZaliMessenger";

pub(crate) struct Rendered {
    pub subject: String,
    pub text: String,
    pub html: String,
}

/// Экранирование для HTML-текста и значений атрибутов.
pub(crate) fn esc(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 8);
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}

/// `alexander@example.com` → `al•••@example.com`: в уведомлениях о смене почты
/// новый адрес показывается не целиком — письмо уходит на старый, который мог
/// оказаться в чужих руках.
pub(crate) fn mask_email(email: &str) -> String {
    match email.split_once('@') {
        Some((local, domain)) => {
            let shown: String = local.chars().take(if local.chars().count() > 4 { 2 } else { 1 }).collect();
            format!("{shown}•••@{domain}")
        }
        None => "•••".to_string(),
    }
}

fn utc_stamp() -> String {
    // «19 ноября 2026, 14:03 UTC» — без локали ОС и без зависимости от неё.
    const MONTHS: [&str; 12] = [
        "января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября",
        "октября", "ноября", "декабря",
    ];
    use chrono::{Datelike, Timelike};
    let now = chrono::Utc::now();
    format!(
        "{} {} {}, {:02}:{:02} UTC",
        now.day(),
        MONTHS[(now.month0() as usize).min(11)],
        now.year(),
        now.hour(),
        now.minute()
    )
}

/// Главный блок письма: либо код, либо плашка-статус.
enum Hero<'a> {
    Code { code: &'a str, caption: String },
    Status { label: &'a str, value: String },
}

struct Letter<'a> {
    subject: String,
    preheader: String,
    title: &'a str,
    /// Уже собранный HTML (имена внутри экранированы вызывающим).
    lead_html: String,
    lead_text: String,
    hero: Hero<'a>,
    /// Пары (HTML, текст) — заметки под главным блоком.
    notes: Vec<(String, String)>,
    username: &'a str,
}

fn render(letter: Letter<'_>) -> Rendered {
    let stamp = utc_stamp();
    let hero_html = match &letter.hero {
        Hero::Code { code, caption } => format!(
            r##"<tr><td style="padding:26px 0 0 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;">
    <tr><td class="zm-code" align="center" bgcolor="#cbff00" style="background-color:#cbff00;border:1px solid #c0ee10;border-radius:18px;padding:24px 12px 22px 12px;">
      <div style="font-family:'SF Mono','SFMono-Regular',Menlo,Consolas,'Liberation Mono',monospace;font-size:40px;line-height:44px;font-weight:800;letter-spacing:12px;padding-left:12px;color:#0b0d10;mso-line-height-rule:exactly;">{code}</div>
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:18px;font-weight:600;color:#2f3a06;padding-top:8px;">{caption}</div>
    </td></tr>
  </table>
</td></tr>"##,
            code = esc(code),
            caption = esc(caption),
        ),
        Hero::Status { label, value } => format!(
            r##"<tr><td style="padding:24px 0 0 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;">
    <tr><td class="zm-tile" bgcolor="#f0f2ea" style="background-color:#f0f2ea;border-radius:16px;padding:16px 18px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td valign="middle" width="36" style="width:36px;">
          <div class="zm-dot" style="width:36px;height:36px;border-radius:11px;background-color:#cbff00;color:#0b0d10;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:18px;line-height:36px;font-weight:800;text-align:center;">&#10003;</div>
        </td>
        <td valign="middle" style="padding-left:14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
          <div class="zm-muted" style="font-size:12px;line-height:16px;font-weight:600;color:#6b6f76;">{label}</div>
          <div class="zm-ink" style="font-size:16px;line-height:22px;font-weight:700;color:#15171a;">{value}</div>
        </td>
      </tr></table>
    </td></tr>
  </table>
</td></tr>"##,
            label = esc(label),
            value = esc(value),
        ),
    };

    let notes_html: String = letter
        .notes
        .iter()
        .map(|(html, _)| {
            format!(
                r##"<tr><td class="zm-text" style="padding:0 0 10px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:19px;color:#4d5158;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td valign="top" width="14" style="width:14px;padding-top:7px;"><div class="zm-bullet" style="width:5px;height:5px;border-radius:3px;background-color:#9a9ea5;"></div></td>
    <td valign="top" class="zm-text" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:19px;color:#4d5158;">{html}</td>
  </tr></table>
</td></tr>"##
            )
        })
        .collect();

    let html = format!(
        r##"<!DOCTYPE html>
<html lang="ru" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>{title}</title>
<style>
  body {{ margin:0 !important; padding:0 !important; width:100% !important; }}
  table, td {{ mso-table-lspace:0pt; mso-table-rspace:0pt; }}
  @media (max-width:600px) {{
    .zm-card {{ padding:28px 22px 26px 22px !important; border-radius:20px !important; }}
    .zm-title {{ font-size:24px !important; line-height:30px !important; }}
  }}
  @media (prefers-color-scheme: dark) {{
    .zm-bg {{ background-color:#08090b !important; }}
    .zm-card {{ background-color:#14161b !important; border-color:#1d2026 !important; }}
    .zm-ink, .zm-title {{ color:#f2f3f5 !important; }}
    .zm-text {{ color:#b4b8be !important; }}
    .zm-muted {{ color:#878b92 !important; }}
    .zm-tile {{ background-color:#1c1f25 !important; }}
    .zm-bullet {{ background-color:#5d6168 !important; }}
    .zm-code {{ border-color:#cbff00 !important; }}
    .zm-rule {{ border-color:#23262c !important; }}
  }}
  [data-ogsc] .zm-bg {{ background-color:#08090b !important; }}
  [data-ogsc] .zm-card {{ background-color:#14161b !important; }}
  [data-ogsc] .zm-ink, [data-ogsc] .zm-title {{ color:#f2f3f5 !important; }}
  [data-ogsc] .zm-text {{ color:#b4b8be !important; }}
</style>
</head>
<body class="zm-bg" style="margin:0;padding:0;background-color:#eceee6;-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:#eceee6;">{preheader}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" class="zm-bg" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#eceee6" style="background-color:#eceee6;">
  <tr><td align="center" style="padding:40px 14px 36px 14px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">
      <tr><td class="zm-card" bgcolor="#fafbf7" style="background-color:#fafbf7;border:1px solid #e3e6dc;border-radius:24px;padding:36px 40px 34px 40px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
              <td valign="middle" width="40" style="width:40px;">
                <div style="width:40px;height:40px;border-radius:12px;background-color:#cbff00;color:#0b0d10;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:22px;line-height:40px;font-weight:800;text-align:center;">Z</div>
              </td>
              <td valign="middle" class="zm-ink" style="padding-left:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:20px;font-weight:700;color:#15171a;">{brand}</td>
            </tr></table>
          </td></tr>
          <tr><td class="zm-title" style="padding:30px 0 10px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:28px;line-height:33px;font-weight:800;letter-spacing:-0.5px;color:#15171a;">{title}</td></tr>
          <tr><td class="zm-text" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:23px;color:#4d5158;">{lead}</td></tr>
          {hero}
          <tr><td style="padding:26px 0 16px 0;"><div class="zm-rule" style="border-top:1px solid #e6e8e0;height:1px;line-height:1px;font-size:1px;">&nbsp;</div></td></tr>
          {notes}
        </table>
      </td></tr>
      <tr><td align="center" class="zm-muted" style="padding:20px 24px 0 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;color:#8a8e95;">
        Аккаунт <strong style="font-weight:700;">{username}</strong> · {stamp}<br>
        Письмо отправлено автоматически сервером {brand} — отвечать на него не нужно.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>"##,
        title = esc(letter.title),
        preheader = esc(&letter.preheader),
        brand = BRAND,
        lead = letter.lead_html,
        hero = hero_html,
        notes = notes_html,
        username = esc(letter.username),
        stamp = esc(&stamp),
    );

    let mut text = String::new();
    text.push_str(letter.title);
    text.push_str("\n\n");
    text.push_str(&letter.lead_text);
    text.push_str("\n\n");
    match &letter.hero {
        Hero::Code { code, caption } => {
            text.push_str(&format!("    {code}\n\n{caption}\n\n"));
        }
        Hero::Status { label, value } => {
            text.push_str(&format!("{label}: {value}\n\n"));
        }
    }
    for (_, note) in &letter.notes {
        text.push_str("— ");
        text.push_str(note);
        text.push('\n');
    }
    text.push_str(&format!(
        "\nАккаунт {} · {}\nПисьмо отправлено автоматически сервером {} — отвечать на него не нужно.\n",
        letter.username, stamp, BRAND
    ));

    Rendered {
        subject: letter.subject,
        text,
        html,
    }
}

fn ttl_caption(ttl_secs: u64) -> String {
    let minutes = (ttl_secs / 60).max(1);
    format!("Код действует {minutes} минут")
}

/// Код подтверждения: привязка почты к аккаунту (регистрация или смена).
pub(crate) fn link_code(username: &str, code: &str, ttl_secs: u64) -> Rendered {
    render(Letter {
        subject: format!("{code} — код подтверждения почты {BRAND}"),
        preheader: format!("Ваш код: {code}. Введите его в приложении, чтобы привязать почту."),
        title: "Подтвердите почту",
        lead_html: format!(
            "Введите этот код в приложении, чтобы привязать почту к аккаунту <strong class=\"zm-ink\" style=\"color:#15171a;font-weight:700;\">{}</strong>. С ней вы сможете восстановить доступ, если забудете пароль.",
            esc(username)
        ),
        lead_text: format!(
            "Введите этот код в приложении, чтобы привязать почту к аккаунту {username}. С ней вы сможете восстановить доступ, если забудете пароль."
        ),
        hero: Hero::Code { code, caption: ttl_caption(ttl_secs) },
        notes: vec![
            (
                "Никому не сообщайте код — даже тому, кто представится поддержкой ZaliMessenger. Мы никогда его не спрашиваем.".to_string(),
                "Никому не сообщайте код — даже тому, кто представится поддержкой ZaliMessenger. Мы никогда его не спрашиваем.".to_string(),
            ),
            (
                "Не запрашивали код? Просто проигнорируйте письмо: без кода этот адрес к аккаунту не привязать.".to_string(),
                "Не запрашивали код? Просто проигнорируйте письмо: без кода этот адрес к аккаунту не привязать.".to_string(),
            ),
        ],
        username,
    })
}

/// Код сброса пароля.
pub(crate) fn reset_code(username: &str, code: &str, ttl_secs: u64) -> Rendered {
    render(Letter {
        subject: format!("{code} — код для сброса пароля {BRAND}"),
        preheader: format!("Код для сброса пароля: {code}. Если это были не вы — просто проигнорируйте письмо."),
        title: "Сброс пароля",
        lead_html: format!(
            "Для аккаунта <strong class=\"zm-ink\" style=\"color:#15171a;font-weight:700;\">{}</strong> запросили сброс пароля. Введите код на экране входа, чтобы задать новый.",
            esc(username)
        ),
        lead_text: format!(
            "Для аккаунта {username} запросили сброс пароля. Введите код на экране входа, чтобы задать новый."
        ),
        hero: Hero::Code { code, caption: ttl_caption(ttl_secs) },
        notes: vec![
            (
                "Не запрашивали сброс? Ничего не делайте: пароль останется прежним, а код перестанет действовать сам.".to_string(),
                "Не запрашивали сброс? Ничего не делайте: пароль останется прежним, а код перестанет действовать сам.".to_string(),
            ),
            (
                "Никому не сообщайте код. С ним можно сменить пароль и войти в аккаунт.".to_string(),
                "Никому не сообщайте код. С ним можно сменить пароль и войти в аккаунт.".to_string(),
            ),
        ],
        username,
    })
}

/// Уведомление на прежний адрес: к аккаунту привязали другую почту.
pub(crate) fn email_changed_notice(username: &str, new_email: &str) -> Rendered {
    let masked = mask_email(new_email);
    render(Letter {
        subject: format!("Почта аккаунта {BRAND} изменена"),
        preheader: format!("К аккаунту {username} привязана новая почта {masked}."),
        title: "Почта изменена",
        lead_html: format!(
            "К аккаунту <strong class=\"zm-ink\" style=\"color:#15171a;font-weight:700;\">{}</strong> привязана новая почта. Коды для восстановления пароля больше не будут приходить на этот адрес.",
            esc(username)
        ),
        lead_text: format!(
            "К аккаунту {username} привязана новая почта. Коды для восстановления пароля больше не будут приходить на этот адрес."
        ),
        hero: Hero::Status { label: "Новая почта", value: masked },
        notes: vec![
            (
                "Если это сделали не вы — войдите и смените пароль: почту меняют только с текущим паролем, значит он мог стать известен постороннему.".to_string(),
                "Если это сделали не вы — войдите и смените пароль: почту меняют только с текущим паролем, значит он мог стать известен постороннему.".to_string(),
            ),
        ],
        username,
    })
}

/// Уведомление: пароль сброшен по коду из письма.
pub(crate) fn password_reset_notice(username: &str) -> Rendered {
    render(Letter {
        subject: format!("Пароль {BRAND} изменён"),
        preheader: format!("Пароль аккаунта {username} сброшен по коду из письма."),
        title: "Пароль изменён",
        lead_html: format!(
            "Пароль аккаунта <strong class=\"zm-ink\" style=\"color:#15171a;font-weight:700;\">{}</strong> сброшен по коду из письма. Все устройства вышли из аккаунта — войдите на них с новым паролем.",
            esc(username)
        ),
        lead_text: format!(
            "Пароль аккаунта {username} сброшен по коду из письма. Все устройства вышли из аккаунта — войдите на них с новым паролем."
        ),
        hero: Hero::Status { label: "Сеансы", value: "Завершены на всех устройствах".to_string() },
        notes: vec![
            (
                "Если это были не вы — сразу сбросьте пароль ещё раз через «Забыли пароль?» на экране входа и смените пароль от этой почты.".to_string(),
                "Если это были не вы — сразу сбросьте пароль ещё раз через «Забыли пароль?» на экране входа и смените пароль от этой почты.".to_string(),
            ),
            (
                "Переписки, ключи от которых были только в облаке, можно вернуть: в списке чатов нажмите правой кнопкой на собеседника и выберите «Восстановить переписку».".to_string(),
                "Переписки, ключи от которых были только в облаке, можно вернуть: в списке чатов нажмите правой кнопкой на собеседника и выберите «Восстановить переписку».".to_string(),
            ),
        ],
        username,
    })
}

/// Проверочное письмо `zali_server mail test`.
pub(crate) fn test_letter(code: &str) -> Rendered {
    render(Letter {
        subject: format!("Проверка почты {BRAND}"),
        preheader: "Если вы видите это письмо — почтовый сервер настроен.".to_string(),
        title: "Почта работает",
        lead_html: "Это проверочное письмо почтового сервера ZaliMessenger. Если оно дошло во «Входящие», а не в «Спам», — DNS-записи SPF, DKIM и DMARC настроены верно.".to_string(),
        lead_text: "Это проверочное письмо почтового сервера ZaliMessenger. Если оно дошло во «Входящие», а не в «Спам», — DNS-записи SPF, DKIM и DMARC настроены верно.".to_string(),
        hero: Hero::Code { code, caption: "Так выглядит код в настоящих письмах".to_string() },
        notes: vec![(
            "Откройте заголовки письма: в Authentication-Results должны стоять spf=pass и dkim=pass.".to_string(),
            "Откройте заголовки письма: в Authentication-Results должны стоять spf=pass и dkim=pass.".to_string(),
        )],
        username: "проверка",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn username_is_escaped_in_html() {
        let letter = link_code("<b>x</b>", "123456", 900);
        assert!(!letter.html.contains("<b>x</b>"));
        assert!(letter.html.contains("&lt;b&gt;x&lt;/b&gt;"));
    }

    #[test]
    fn code_is_in_subject_text_and_html_once_in_body() {
        let letter = reset_code("alice", "042137", 900);
        assert!(letter.subject.starts_with("042137"));
        assert!(letter.text.contains("042137"));
        assert!(letter.html.contains(">042137<"));
        assert!(letter.text.contains("15 минут"));
    }

    #[test]
    fn masked_email_hides_the_local_part() {
        assert_eq!(mask_email("alexander@example.com"), "al•••@example.com");
        assert_eq!(mask_email("bob@example.com"), "b•••@example.com");
        let notice = email_changed_notice("alice", "alexander@example.com");
        assert!(!notice.html.contains("alexander@"));
        assert!(!notice.text.contains("alexander@"));
    }

    #[test]
    fn letters_carry_no_links() {
        for letter in [
            link_code("a", "111111", 900),
            reset_code("a", "111111", 900),
            email_changed_notice("a", "x@y.zz"),
            password_reset_notice("a"),
        ] {
            assert!(!letter.html.contains("href="), "{}", letter.subject);
            assert!(!letter.html.contains("<img"), "{}", letter.subject);
        }
    }
}
