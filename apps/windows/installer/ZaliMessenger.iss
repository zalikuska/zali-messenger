; Inno Setup script for the Windows client. Built via
; scripts\build_windows_app.ps1 -Installer, which passes /DMyAppVersion=<version>
; (kept in sync with apps\windows\Cargo.toml's `version`) and expects
; dist\windows\ZaliMessenger.exe to already exist (this script only packages it,
; it never builds Rust itself).
;
; Requires Inno Setup 6.1+ (for the [Icons] AppUserModelID parameter — see below)
; and the ISCC.exe compiler on PATH. https://jrsoftware.org/isinfo.php

#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif

#define MyAppName "Zali Messenger"
#define MyAppExeName "ZaliMessenger.exe"
; AppUserModelID matches set_windows_app_user_model_id() in src/main.rs and
; notify-rust's app_id() call in src/native/transport.rs. Windows' toast API only
; reliably shows notifications for unpackaged Win32 apps when this exact AUMID is
; ALSO registered via a persistent Start Menu shortcut — this line is that fix.
#define MyAppUserModelID "com.zali.messenger"

[Setup]
; Fixed GUID for this app — do not change between releases, it's how Windows
; tells "upgrade of the same app" apart from "a different app".
AppId={{E1C1B6C0-6B2A-4C7C-9C77-4E5C5C5A9B2E}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=Zali
DefaultDirName={autopf}\ZaliMessenger
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=..\..\dist\windows\installer
OutputBaseFilename=ZaliMessengerSetup-{#MyAppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\{#MyAppExeName}
ArchitecturesInstallIn64BitMode=x64

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Создать ярлык на рабочем столе"; Flags: unchecked
Name: "autostart"; Description: "Запускать при входе в Windows (в свёрнутом виде, для уведомлений)"

[Files]
Source: "..\..\dist\windows\ZaliMessenger.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; AppUserModelID here is the actual notification fix — see comment above.
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; AppUserModelID: "{#MyAppUserModelID}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; AppUserModelID: "{#MyAppUserModelID}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "ZaliMessenger"; ValueData: """{app}\{#MyAppExeName}"" --start-minimized"; Tasks: autostart; Flags: uninsdeletevalue

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Запустить {#MyAppName}"; Flags: postinstall nowait skipifsilent unchecked

[Code]
// Standard WebView2 Runtime presence check: a bare Win32 app (this one) needs it
// installed separately, unlike an MSIX-packaged app which can bundle it.
function IsWebView2RuntimeInstalled: Boolean;
var
  Version: String;
begin
  Result :=
    RegQueryStringValue(HKLM64, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) or
    RegQueryStringValue(HKCU, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version);
end;

function InitializeSetup: Boolean;
var
  ErrorCode: Integer;
begin
  Result := True;
  if not IsWebView2RuntimeInstalled then
  begin
    if MsgBox(
      'Для работы Zali Messenger требуется Microsoft Edge WebView2 Runtime, который не найден в системе.' + #13#10 + #13#10 +
      'Открыть страницу загрузки сейчас? (Установку самого Zali Messenger можно продолжить и без этого — тогда WebView2 нужно будет поставить позже.)',
      mbConfirmation, MB_YESNO) = IDYES then
    begin
      ShellExec('open', 'https://developer.microsoft.com/en-us/microsoft-edge/webview2/', '', '', SW_SHOW, ewNoWait, ErrorCode);
    end;
  end;
end;
