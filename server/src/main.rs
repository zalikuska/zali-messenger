#[tokio::main]
async fn main() {
    // `zali_server mail …` — инструменты почтового сервера (проверка DNS, тестовое
    // письмо, DKIM-ключ); без аргументов — обычный запуск сервера.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("mail") {
        std::process::exit(zali_server::mail_cli(&args[1..]).await);
    }
    zali_server::run().await;
}
