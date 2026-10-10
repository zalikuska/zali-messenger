//! Определение запущенной игры — для игрового статуса «Играет в …».
//!
//! Зеркало `apps/macos/Sources/ZaliMessenger/Services/GameDetector.swift`; общее
//! поведение — один и тот же контракт с вебом (`web/src/interface/game_activity.js`):
//! веб присылает `GAME_DETECTOR_CONFIG {enabled, games}`, оболочка отвечает
//! realtime-событием `native_game_activity` — и только при смене результата.
//!
//! Оболочка только ВИДИТ процессы. Включено ли, ручной статус, список «это не
//! игра» и отправка на сервер решает веб-слой; сюда настройки не доходят.
//!
//! Игрой считается процесс с одним из положительных признаков — ни один не
//! «угадывает»:
//!  1. `RunningAppID` Steam не ноль — Steam сам знает, что запущено;
//!  2. имя процесса есть в каталоге, который прислал веб;
//!  3. исполняемый файл лежит в папке игры лаунчера: `steamapps\common\<Игра>\`,
//!     `Epic Games\<Игра>\`, `GOG Games\<Игра>\` (название — имя папки).
//! Браузер, редактор и любой «неизвестный» процесс не совпадают ни с одним и в
//! статус не попадают. Наружу уходит только название и источник совпадения —
//! не список процессов.
//!
//! Работает на отдельном потоке: опрос — это снимок процессов и несколько
//! `OpenProcess`, ему не место ни в цикле окна, ни в tokio-рантайме.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::Duration;
use tao::event_loop::EventLoopProxy;

use super::{dispatch_ui_event, AppEvent, UiBusEvent};

const POLL_INTERVAL: Duration = Duration::from_secs(10);

/// Папки внутри каталога лаунчера, которые не игры: рантаймы и инструменты.
const NOT_GAME_FOLDERS: [&str; 11] = [
    "steamworks",
    "steamvr",
    "wallpaper engine",
    "steam linux runtime",
    "proton",
    "source sdk",
    "steam controller",
    "blender",
    "aseprite",
    "krita",
    "godot",
];

/// Запись каталога. `path` — необязательная подстрока пути к exe (без учёта
/// регистра, `/` как `\`): запись подходит, только если она в пути есть. Нужна
/// там, где у разных игр один и тот же процесс (osu! stable и osu!lazer).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CatalogEntry {
    pub(crate) name: String,
    pub(crate) path: Option<String>,
}

pub(crate) type Catalog = HashMap<String, Vec<CatalogEntry>>;

fn normalize_path(path: &str) -> String {
    path.to_lowercase().replace('/', "\\")
}

/// Записи, у которых ограничение по пути выставлено, нельзя решить без пути.
fn is_path_constrained(catalog: &Catalog, stem: &str) -> bool {
    catalog
        .get(stem)
        .map(|entries| entries.iter().any(|entry| entry.path.is_some()))
        .unwrap_or(false)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Detection {
    pub(crate) name: String,
    pub(crate) id: String,
    pub(crate) source: &'static str,
}

/// Что известно о запущенном процессе. `path` может отсутствовать: у защищённых
/// процессов `OpenProcess` отказывает, и это нормально.
#[derive(Debug, Clone)]
pub(crate) struct ProcessInfo {
    /// Читается только в Windows-ветке опроса.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub(crate) pid: u32,
    pub(crate) exe_name: String,
    pub(crate) path: Option<String>,
}

/// Имя папки игры, если путь лежит внутри каталога лаунчера. Разделители любые.
pub(crate) fn launcher_game_folder(path: &str) -> Option<String> {
    let components: Vec<&str> = path
        .split(|c| c == '\\' || c == '/')
        .filter(|part| !part.is_empty())
        .collect();
    let markers: [(&str, Option<&str>); 3] = [
        ("common", Some("steamapps")),
        ("Epic Games", None),
        ("GOG Games", None),
    ];
    for (parent, grandparent) in markers {
        let Some(index) = components
            .iter()
            .position(|part| part.eq_ignore_ascii_case(parent))
        else {
            continue;
        };
        if let Some(grand) = grandparent {
            if index == 0 || !components[index - 1].eq_ignore_ascii_case(grand) {
                continue;
            }
        }
        // Нужна папка игры и ещё хотя бы один компонент после неё (сам файл).
        if index + 2 >= components.len() {
            continue;
        }
        let folder = components[index + 1];
        let lowered = folder.to_lowercase();
        if NOT_GAME_FOLDERS.iter().any(|skip| lowered.contains(skip)) {
            return None;
        }
        return Some(folder.to_string());
    }
    None
}

/// Совпадение одного процесса с правилами 2 и 3. Правило 1 (Steam) проверяется
/// отдельно — оно не про процесс.
pub(crate) fn classify(process: &ProcessInfo, catalog: &Catalog) -> Option<Detection> {
    let lowered = process.exe_name.to_lowercase();
    let stem = lowered.strip_suffix(".exe").unwrap_or(&lowered);
    if let Some(entries) = catalog.get(stem) {
        let path = process.path.as_deref().map(normalize_path).unwrap_or_default();
        // Сначала записи с ограничением по пути, потом без него: «osu!lazer»
        // важнее общего «osu!».
        let constrained = entries.iter().find(|entry| {
            entry
                .path
                .as_deref()
                .map(|needle| !path.is_empty() && path.contains(needle))
                .unwrap_or(false)
        });
        let hit = constrained.or_else(|| entries.iter().find(|entry| entry.path.is_none()));
        if let Some(entry) = hit {
            return Some(Detection {
                name: entry.name.clone(),
                id: format!("proc:{stem}"),
                source: "process",
            });
        }
    }
    let folder = launcher_game_folder(process.path.as_deref()?)?;
    Some(Detection {
        id: format!("launcher:{}", folder.to_lowercase()),
        name: folder,
        source: "steam",
    })
}

/// Из нескольких найденных: игра в фокусе важнее фоновой, из фоновых — запущенная
/// позже (pid у недавних процессов, как правило, больше).
pub(crate) fn pick(
    found: Vec<(u32, Detection)>,
    foreground_pid: Option<u32>,
) -> Option<Detection> {
    if let Some(pid) = foreground_pid {
        if let Some((_, detection)) = found.iter().find(|(candidate, _)| *candidate == pid) {
            return Some(detection.clone());
        }
    }
    found
        .into_iter()
        .max_by_key(|(pid, _)| *pid)
        .map(|(_, detection)| detection)
}

enum Command {
    Configure {
        enabled: bool,
        catalog: Catalog,
    },
}

static WORKER: OnceLock<Mutex<mpsc::Sender<Command>>> = OnceLock::new();

/// Принять `GAME_DETECTOR_CONFIG`. Поток опроса заводится при первом вызове и
/// спит на канале, пока детектор выключен.
pub(crate) fn configure(proxy: &EventLoopProxy<AppEvent>, enabled: bool, games: &[Value]) {
    let mut catalog: Catalog = HashMap::new();
    for entry in games {
        let process = entry
            .get("process")
            .and_then(Value::as_str)
            .map(|value| value.trim().to_lowercase())
            .unwrap_or_default();
        let name = entry
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        let path = entry
            .get("path")
            .and_then(Value::as_str)
            .map(normalize_path)
            .filter(|value| !value.trim().is_empty());
        if !process.is_empty() && !name.is_empty() {
            catalog.entry(process).or_default().push(CatalogEntry {
                name: name.to_string(),
                path,
            });
        }
    }
    let sender = WORKER.get_or_init(|| {
        let (tx, rx) = mpsc::channel();
        let proxy = proxy.clone();
        std::thread::Builder::new()
            .name("zali-game-detector".to_string())
            .spawn(move || worker(rx, proxy))
            .ok();
        Mutex::new(tx)
    });
    if let Ok(tx) = sender.lock() {
        let _ = tx.send(Command::Configure { enabled, catalog });
    }
}

fn emit(proxy: &EventLoopProxy<AppEvent>, detection: Option<&Detection>) {
    let mut event = json!({ "type": "native_game_activity" });
    if let Some(detection) = detection {
        event["activity"] = json!({
            "name": detection.name,
            "id": detection.id,
            "source": detection.source,
        });
    }
    dispatch_ui_event(proxy, UiBusEvent::RealtimeEvent, event);
}

fn worker(rx: mpsc::Receiver<Command>, proxy: EventLoopProxy<AppEvent>) {
    let mut enabled = false;
    let mut catalog: Catalog = HashMap::new();
    let mut current: Option<Detection> = None;
    loop {
        let command = if enabled {
            match rx.recv_timeout(POLL_INTERVAL) {
                Ok(command) => Some(command),
                Err(mpsc::RecvTimeoutError::Timeout) => None,
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        } else {
            match rx.recv() {
                Ok(command) => Some(command),
                Err(_) => return,
            }
        };
        if let Some(Command::Configure {
            enabled: next_enabled,
            catalog: next_catalog,
        }) = command
        {
            enabled = next_enabled;
            catalog = next_catalog;
            if !enabled && current.take().is_some() {
                emit(&proxy, None);
            }
        }
        if !enabled {
            continue;
        }
        let next = imp::detect(&catalog);
        if next != current {
            emit(&proxy, next.as_ref());
            current = next;
        }
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{classify, is_path_constrained, pick, Catalog, Detection, ProcessInfo};
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_SUCCESS, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }

    fn wide_to_string(units: &[u16]) -> String {
        let end = units.iter().position(|unit| *unit == 0).unwrap_or(units.len());
        String::from_utf16_lossy(&units[..end])
    }

    fn image_path(pid: u32) -> Option<String> {
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return None;
            }
            let mut buffer = vec![0u16; 1024];
            let mut size = buffer.len() as u32;
            let ok = QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut size);
            CloseHandle(handle);
            if ok == 0 {
                return None;
            }
            Some(String::from_utf16_lossy(&buffer[..size as usize]))
        }
    }

    fn processes() -> Vec<ProcessInfo> {
        let mut out = Vec::new();
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot == INVALID_HANDLE_VALUE || snapshot.is_null() {
                return out;
            }
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut more = Process32FirstW(snapshot, &mut entry) != 0;
            let own_pid = std::process::id();
            while more {
                let pid = entry.th32ProcessID;
                if pid != 0 && pid != own_pid {
                    out.push(ProcessInfo {
                        pid,
                        exe_name: wide_to_string(&entry.szExeFile),
                        path: None,
                    });
                }
                more = Process32NextW(snapshot, &mut entry) != 0;
            }
            CloseHandle(snapshot);
        }
        out
    }

    fn foreground_pid() -> Option<u32> {
        unsafe {
            let window = GetForegroundWindow();
            if window.is_null() {
                return None;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(window, &mut pid);
            (pid != 0).then_some(pid)
        }
    }

    fn read_dword(subkey: &str, name: &str) -> Option<u32> {
        let subkey = wide(subkey);
        let name = wide(name);
        let mut value: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_DWORD,
                std::ptr::null_mut(),
                &mut value as *mut u32 as *mut _,
                &mut size,
            )
        };
        (status == ERROR_SUCCESS).then_some(value)
    }

    fn read_string(subkey: &str, name: &str) -> Option<String> {
        let subkey = wide(subkey);
        let name = wide(name);
        let mut buffer = vec![0u16; 1024];
        let mut size = (buffer.len() * 2) as u32;
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buffer.as_mut_ptr() as *mut _,
                &mut size,
            )
        };
        if status != ERROR_SUCCESS {
            return None;
        }
        Some(wide_to_string(&buffer))
    }

    /// Значение `"key"  "value"` из текстового VDF Steam; строки разбираются
    /// грубо, но для `name` и `path` этого достаточно.
    fn vdf_value(line: &str, key: &str) -> Option<String> {
        let mut quoted = line.split('"').filter(|part| !part.trim().is_empty());
        let found = quoted.next()?;
        if !found.eq_ignore_ascii_case(key) {
            return None;
        }
        quoted.next().map(|value| value.replace("\\\\", "\\"))
    }

    fn steam_library_dirs(steam_path: &str) -> Vec<std::path::PathBuf> {
        let root = std::path::PathBuf::from(steam_path.replace('/', "\\"));
        let mut dirs = vec![root.clone()];
        let vdf = root.join("steamapps").join("libraryfolders.vdf");
        if let Ok(text) = std::fs::read_to_string(vdf) {
            for line in text.lines() {
                if let Some(path) = vdf_value(line.trim(), "path") {
                    dirs.push(std::path::PathBuf::from(path));
                }
            }
        }
        dirs
    }

    fn steam_game_name(app_id: u32) -> Option<String> {
        let steam_path = read_string("Software\\Valve\\Steam", "SteamPath")?;
        for dir in steam_library_dirs(&steam_path) {
            let manifest = dir.join("steamapps").join(format!("appmanifest_{app_id}.acf"));
            let Ok(text) = std::fs::read_to_string(manifest) else {
                continue;
            };
            for line in text.lines() {
                if let Some(name) = vdf_value(line.trim(), "name") {
                    if !name.trim().is_empty() {
                        return Some(name);
                    }
                }
            }
        }
        None
    }

    pub(super) fn detect(catalog: &Catalog) -> Option<Detection> {
        // 1. Steam знает точнее любого угадывания по процессам.
        if let Some(app_id) = read_dword("Software\\Valve\\Steam", "RunningAppID") {
            if app_id != 0 {
                if let Some(name) = steam_game_name(app_id) {
                    return Some(Detection {
                        name,
                        id: format!("steam:{app_id}"),
                        source: "steam",
                    });
                }
            }
        }
        // 2–3. Каталог и папки лаунчеров. Путь запрашивается только у процессов,
        // не нашедшихся в каталоге, — OpenProcess на сотню процессов не бесплатен.
        let mut found: Vec<(u32, Detection)> = Vec::new();
        for mut process in processes() {
            let lowered = process.exe_name.to_lowercase();
            let stem = lowered.strip_suffix(".exe").unwrap_or(&lowered);
            // Запись с ограничением по пути без пути не решается — идём за путём.
            if !is_path_constrained(catalog, stem) {
                if let Some(detection) = classify(&process, catalog) {
                    found.push((process.pid, detection));
                    continue;
                }
            }
            process.path = image_path(process.pid);
            if process.path.is_some() {
                if let Some(detection) = classify(&process, catalog) {
                    found.push((process.pid, detection));
                }
            }
        }
        pick(found, foreground_pid())
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::{Catalog, Detection};

    /// Экспериментальный macOS Rust-шелл процессы не опрашивает (`gameActivity`
    /// там не объявляется); основной macOS-клиент — Swift.
    pub(super) fn detect(_catalog: &Catalog) -> Option<Detection> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, path: Option<&str>) -> CatalogEntry {
        CatalogEntry {
            name: name.to_string(),
            path: path.map(normalize_path),
        }
    }

    fn catalog() -> Catalog {
        let mut map: Catalog = HashMap::new();
        map.insert("cs2".to_string(), vec![entry("Counter-Strike 2", None)]);
        map.insert("eldenring".to_string(), vec![entry("ELDEN RING", None)]);
        map.insert("deadlock".to_string(), vec![entry("Deadlock", None)]);
        map.insert("project8".to_string(), vec![entry("Deadlock", None)]);
        // Один и тот же osu!.exe — различаются папкой установки.
        map.insert(
            "osu!".to_string(),
            vec![
                entry("osu!", Some(r"\osu!\")),
                entry("osu!lazer", Some("osulazer")),
            ],
        );
        map
    }

    fn process(pid: u32, exe: &str, path: Option<&str>) -> ProcessInfo {
        ProcessInfo {
            pid,
            exe_name: exe.to_string(),
            path: path.map(str::to_string),
        }
    }

    #[test]
    fn a_catalog_process_matches_regardless_of_case_and_extension() {
        let hit = classify(&process(1, "CS2.EXE", None), &catalog()).expect("detected");
        assert_eq!(hit.name, "Counter-Strike 2");
        assert_eq!(hit.source, "process");
    }

    #[test]
    fn deadlock_is_recognised_by_its_process_and_the_old_codename() {
        for exe in ["deadlock.exe", "Deadlock.exe", "project8.exe"] {
            let hit = classify(&process(1, exe, None), &catalog()).expect("detected");
            assert_eq!(hit.name, "Deadlock", "{exe}");
        }
    }

    #[test]
    fn osu_stable_and_lazer_share_a_process_and_differ_by_install_path() {
        let stable = process(1, "osu!.exe", Some(r"C:\Users\a\AppData\Local\osu!\osu!.exe"));
        let lazer = process(2, "osu!.exe", Some(r"C:\Users\a\AppData\Local\osulazer\current\osu!.exe"));
        assert_eq!(classify(&stable, &catalog()).expect("stable").name, "osu!");
        assert_eq!(classify(&lazer, &catalog()).expect("lazer").name, "osu!lazer");
        // Путь неизвестен — не гадаем, какая из двух.
        assert!(classify(&process(3, "osu!.exe", None), &catalog()).is_none());
        // Запись с путём требует пути: без него решать нельзя.
        assert!(is_path_constrained(&catalog(), "osu!"));
        assert!(!is_path_constrained(&catalog(), "cs2"));
    }

    #[test]
    fn a_launcher_folder_names_the_game() {
        let path = r"C:\Program Files (x86)\Steam\steamapps\common\Hades\x64\Hades.exe";
        let hit = classify(&process(1, "Hades.exe", Some(path)), &catalog()).expect("detected");
        assert_eq!(hit.name, "Hades");
        assert_eq!(hit.source, "steam");
        assert_eq!(
            launcher_game_folder(r"D:\Games\Epic Games\Fortnite\FortniteClient.exe").as_deref(),
            Some("Fortnite")
        );
    }

    #[test]
    fn tools_and_unrelated_processes_are_not_games() {
        let steam_tool = r"C:\Steam\steamapps\common\Steamworks Shared\redist.exe";
        assert!(classify(&process(1, "redist.exe", Some(steam_tool)), &catalog()).is_none());
        assert!(classify(
            &process(2, "chrome.exe", Some(r"C:\Program Files\Google\Chrome\chrome.exe")),
            &catalog()
        )
        .is_none());
        // Сама папка без файла внутри — не игра.
        assert!(launcher_game_folder(r"C:\Steam\steamapps\common\Hades").is_none());
    }

    #[test]
    fn the_foreground_game_wins_then_the_newest() {
        let a = Detection { name: "A".into(), id: "a".into(), source: "process" };
        let b = Detection { name: "B".into(), id: "b".into(), source: "process" };
        let found = vec![(10, a.clone()), (20, b.clone())];
        assert_eq!(pick(found.clone(), Some(10)), Some(a));
        assert_eq!(pick(found, None), Some(b));
        assert_eq!(pick(vec![], Some(1)), None);
    }
}
