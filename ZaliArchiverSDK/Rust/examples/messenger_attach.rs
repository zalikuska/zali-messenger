use std::fs;
use zali_sdk::ZaliSession;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 1. Имитируем получение файлов в мессенджере
    fs::write("photo.jpg", "image_data_here").unwrap();
    fs::write("document.pdf", "pdf_data_here").unwrap();

    println!("--- Messenger Integration Example ---");

    // 2. Создаем сессию с паролем пользователя
    let sdk = ZaliSession::new(Some("my_secret_chat_password"), None);

    // 3. Упаковываем файлы для отправки
    let files = vec![
        ("photo.jpg".to_string(), "attachments/photo.jpg".to_string()),
        (
            "document.pdf".to_string(),
            "attachments/document.pdf".to_string(),
        ),
    ];

    sdk.create_archive(files, "chat_attachment.zali")?;
    println!("✅ Вложения упакованы и зашифрованы в chat_attachment.zali");

    // 4. На стороне получателя: смотрим список файлов
    let (_magic, contents) = sdk.inspect_archive("chat_attachment.zali")?;
    println!("📂 Содержимое архива:");
    for (name, size) in contents {
        println!(" - {} ({} байт)", name, size);
    }

    // 5. Распаковываем
    sdk.extract_all("chat_attachment.zali", "./received_files")?;
    println!("🚀 Файлы успешно приняты и расшифрованы!");

    // Очистка
    fs::remove_file("photo.jpg").ok();
    fs::remove_file("document.pdf").ok();

    Ok(())
}
