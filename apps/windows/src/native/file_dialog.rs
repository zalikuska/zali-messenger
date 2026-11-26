//! Системные диалоги «Сохранить как…» и «Выбрать папку» (IFileSaveDialog /
//! IFileOpenDialog) для скачивания вложений. Зовутся из рабочего потока, не из потока
//! окна: диалог модальный и блокирует вызвавший его поток, а цикл событий приложения
//! при этом должен жить. Отмена — `Ok(None)`, а не ошибка.

use std::path::{Path, PathBuf};

#[cfg(target_os = "windows")]
mod imp {
    use super::*;
    use windows::core::HSTRING;
    use windows::Win32::Foundation::{ERROR_CANCELLED, HWND};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{
        FileOpenDialog, FileSaveDialog, IFileDialog, IFileOpenDialog, IFileSaveDialog, IShellItem,
        SHCreateItemFromParsingName, FOS_FORCEFILESYSTEM, FOS_OVERWRITEPROMPT, FOS_PATHMUSTEXIST,
        FOS_PICKFOLDERS, SIGDN_FILESYSPATH,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    /// COM в потоке на время диалога; STA — этого требуют диалоги оболочки.
    struct Apartment(bool);
    impl Apartment {
        fn enter() -> Self {
            Self(unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok())
        }
    }
    impl Drop for Apartment {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }

    fn is_cancel(error: &windows::core::Error) -> bool {
        error.code() == windows::core::HRESULT::from_win32(ERROR_CANCELLED.0)
    }

    fn start_folder(dialog: &IFileDialog, dir: &Path) {
        if !dir.is_dir() {
            return;
        }
        if let Ok(item) = unsafe { SHCreateItemFromParsingName::<_, _, IShellItem>(&HSTRING::from(dir.as_os_str()), None) } {
            let _ = unsafe { dialog.SetFolder(&item) };
        }
    }

    fn chosen_path(dialog: &IFileDialog) -> Result<Option<PathBuf>, String> {
        unsafe {
            let item = dialog.GetResult().map_err(|e| e.message())?;
            let raw = item.GetDisplayName(SIGDN_FILESYSPATH).map_err(|e| e.message())?;
            let text = raw.to_string().map_err(|e| e.to_string());
            CoTaskMemFree(Some(raw.0 as *const _));
            Ok(Some(PathBuf::from(text?)))
        }
    }

    pub(crate) fn pick_save_path(suggested: &str, start_dir: &Path) -> Result<Option<PathBuf>, String> {
        let _apartment = Apartment::enter();
        unsafe {
            let dialog: IFileSaveDialog =
                CoCreateInstance(&FileSaveDialog, None, CLSCTX_INPROC_SERVER).map_err(|e| e.message())?;
            let base: IFileDialog = windows::core::Interface::cast(&dialog).map_err(|e| e.message())?;
            let options = base.GetOptions().map_err(|e| e.message())?;
            base.SetOptions(options | FOS_FORCEFILESYSTEM | FOS_OVERWRITEPROMPT | FOS_PATHMUSTEXIST)
                .map_err(|e| e.message())?;
            let _ = base.SetTitle(&HSTRING::from("Сохранить вложение"));
            let _ = base.SetFileName(&HSTRING::from(suggested));
            if let Some(ext) = Path::new(suggested).extension().and_then(|e| e.to_str()) {
                let _ = base.SetDefaultExtension(&HSTRING::from(ext));
            }
            start_folder(&base, start_dir);
            match base.Show(Some(GetForegroundWindow() as HWND)) {
                Ok(()) => chosen_path(&base),
                Err(error) if is_cancel(&error) => Ok(None),
                Err(error) => Err(error.message()),
            }
        }
    }

    pub(crate) fn pick_folder(current: Option<&Path>) -> Result<Option<PathBuf>, String> {
        let _apartment = Apartment::enter();
        unsafe {
            let dialog: IFileOpenDialog =
                CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).map_err(|e| e.message())?;
            let base: IFileDialog = windows::core::Interface::cast(&dialog).map_err(|e| e.message())?;
            let options = base.GetOptions().map_err(|e| e.message())?;
            base.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST)
                .map_err(|e| e.message())?;
            let _ = base.SetTitle(&HSTRING::from("Папка для скачанных файлов"));
            if let Some(dir) = current {
                start_folder(&base, dir);
            }
            match base.Show(Some(GetForegroundWindow() as HWND)) {
                Ok(()) => chosen_path(&base),
                Err(error) if is_cancel(&error) => Ok(None),
                Err(error) => Err(error.message()),
            }
        }
    }
}

#[cfg(target_os = "windows")]
pub(crate) use imp::{pick_folder, pick_save_path};

// Экспериментальный macOS Rust-шелл диалогов не делает: сохраняет в «Загрузки».
#[cfg(not(target_os = "windows"))]
pub(crate) fn pick_save_path(_suggested: &str, start_dir: &Path) -> Result<Option<PathBuf>, String> {
    Ok(Some(start_dir.join(_suggested)))
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn pick_folder(_current: Option<&Path>) -> Result<Option<PathBuf>, String> {
    Ok(None)
}
