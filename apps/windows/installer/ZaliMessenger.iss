; Inno Setup script for the Windows client — ONLINE installer.
;
; Unlike a classic Inno installer, this one does NOT bundle ZaliMessenger.exe
; at compile time. Instead, at install time it calls the server's existing
; update-check endpoint (GET {#UpdateApiBaseUrl}/api/version?platform=windows —
; see server/src/updates.rs::get_latest_version, the same one the in-app
; updater in interface.js's checkForAppUpdate() polls), downloads whatever
; `downloadUrl` it returns, verifies the `sha256` it returns, and only then
; installs. This means the compiled ZaliMessengerOnlineSetup.exe always ships
; whatever is currently published via POST /api/version, without needing a
; new installer build for every release.
;
; Build with: scripts\build_windows_app.ps1 -OnlineInstallerOnly
; (no local Rust build needed — just ISCC.exe on PATH, see
; https://jrsoftware.org/isinfo.php, Inno Setup 6.1+ for the [Icons]
; AppUserModelID parameter used below).

#ifndef UpdateApiBaseUrl
  #define UpdateApiBaseUrl "https://msgs.zalikus.org"
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
; This is the bootstrapper's own version, not the downloaded app's — the
; actual app version isn't known until install time (see DownloadedVersion
; in [Code]). Add/Remove Programs will show this placeholder, not the live
; app version; that's a known cosmetic limitation of the online-install approach.
AppVersion=1.0.0
AppPublisher=Zali
DefaultDirName={autopf}\ZaliMessenger
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=..\..\dist\windows\installer
OutputBaseFilename=ZaliMessengerOnlineSetup
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

; No [Files] entry: ZaliMessenger.exe is downloaded at install time (see
; NextButtonClick/CurStepChanged in [Code]) rather than bundled in the installer.

[Icons]
; AppUserModelID here is the actual notification fix — see comment above.
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; AppUserModelID: "{#MyAppUserModelID}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; AppUserModelID: "{#MyAppUserModelID}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "ZaliMessenger"; ValueData: """{app}\{#MyAppExeName}"" --start-minimized"; Tasks: autostart; Flags: uninsdeletevalue

[UninstallDelete]
; The exe isn't tracked via [Files] (it's downloaded, not bundled), so it
; needs an explicit uninstall-delete entry or the uninstaller would leave it behind.
Type: files; Name: "{app}\{#MyAppExeName}"

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Запустить {#MyAppName}"; Flags: postinstall nowait skipifsilent unchecked

[Code]
var
  DownloadPage: TOutputProgressWizardPage;
  DownloadedVersion: String;
  DownloadedExePath: String;

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

procedure InitializeWizard;
begin
  DownloadPage := CreateOutputProgressPage('Загрузка Zali Messenger', 'Пожалуйста, подождите — устанавливается актуальная версия с сервера.');
  // The download itself is a single blocking HTTP call with no byte-level progress
  // callback available from Pascal Script, so use a marquee (indeterminate) bar
  // instead of leaving it frozen at 0%.
  DownloadPage.ProgressBar.Style := npbstMarquee;
end;

// Minimal string-field extraction — good enough for the flat JSON object
// GET /api/version returns (server/src/updates.rs ReleaseResponse): no nested
// objects/arrays, no escaped quotes in the fields we read (version/downloadUrl/sha256).
function ExtractJSONString(const JSON, Key: string): string;
var
  SearchKey, Rest: string;
  KeyPos, QuotePos: Integer;
begin
  Result := '';
  SearchKey := '"' + Key + '"';
  KeyPos := Pos(SearchKey, JSON);
  if KeyPos = 0 then Exit;
  Rest := Copy(JSON, KeyPos + Length(SearchKey), Length(JSON));
  QuotePos := Pos(':', Rest);
  if QuotePos = 0 then Exit;
  Rest := Copy(Rest, QuotePos + 1, Length(Rest));
  QuotePos := Pos('"', Rest);
  if QuotePos = 0 then Exit;
  Rest := Copy(Rest, QuotePos + 1, Length(Rest));
  QuotePos := Pos('"', Rest);
  if QuotePos = 0 then Exit;
  Result := Copy(Rest, 1, QuotePos - 1);
end;

function HttpGetText(const Url: string; var ResponseText: string): Boolean;
var
  Http: Variant;
begin
  Result := False;
  try
    Http := CreateOleObject('WinHttp.WinHttpRequest.5.1');
    Http.Open('GET', Url, False);
    Http.SetRequestHeader('User-Agent', 'ZaliMessengerOnlineInstaller');
    Http.Send('');
    if Http.Status = 200 then
    begin
      ResponseText := Http.ResponseText;
      Result := True;
    end;
  except
    Result := False;
  end;
end;

function HttpDownloadFile(const Url, DestFile: string): Boolean;
var
  Http, Stream: Variant;
begin
  Result := False;
  try
    Http := CreateOleObject('WinHttp.WinHttpRequest.5.1');
    Http.Open('GET', Url, False);
    Http.SetRequestHeader('User-Agent', 'ZaliMessengerOnlineInstaller');
    Http.Send('');
    if Http.Status = 200 then
    begin
      Stream := CreateOleObject('ADODB.Stream');
      Stream.Type := 1; // adTypeBinary
      Stream.Open;
      Stream.Write(Http.ResponseBody);
      Stream.SaveToFile(DestFile, 2); // adSaveCreateOverWrite
      Stream.Close;
      Result := True;
    end;
  except
    Result := False;
  end;
end;

// certutil ships with Windows (XP+) — avoids needing a bundled hashing tool.
function VerifySha256(const FilePath, ExpectedHashLower: string): Boolean;
var
  ResultCode, I: Integer;
  TmpFile, Line: string;
  Lines: TArrayOfString;
begin
  Result := False;
  TmpFile := ExpandConstant('{tmp}\zali_hash.txt');
  if Exec(ExpandConstant('{cmd}'), '/C certutil -hashfile "' + FilePath + '" SHA256 > "' + TmpFile + '"', '',
     SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0) then
  begin
    if LoadStringsFromFile(TmpFile, Lines) then
    begin
      for I := 0 to GetArrayLength(Lines) - 1 do
      begin
        Line := Trim(Lines[I]);
        Line := StringChange(Line, ' ', '');
        if (Length(Line) = 64) and (CompareText(Line, ExpectedHashLower) = 0) then
        begin
          Result := True;
          Exit;
        end;
      end;
    end;
  end;
  DeleteFile(TmpFile);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  JsonText, DownloadUrl, Sha256: string;
begin
  Result := True;
  if CurPageID <> wpReady then Exit;

  DownloadPage.Show;
  try
    DownloadPage.SetText('Проверка последней версии на сервере...', '');
    if not HttpGetText('{#UpdateApiBaseUrl}/api/version?platform=windows', JsonText) then
    begin
      MsgBox('Не удалось получить информацию о последней версии с сервера ({#UpdateApiBaseUrl}). Проверьте подключение к интернету и повторите попытку.', mbError, MB_OK);
      Result := False;
      Exit;
    end;

    DownloadedVersion := ExtractJSONString(JsonText, 'version');
    DownloadUrl := ExtractJSONString(JsonText, 'downloadUrl');
    Sha256 := Lowercase(ExtractJSONString(JsonText, 'sha256'));
    if DownloadUrl = '' then
    begin
      MsgBox('Сервер не вернул ссылку на файл установки. Обратитесь к администратору сервера.', mbError, MB_OK);
      Result := False;
      Exit;
    end;

    DownloadedExePath := ExpandConstant('{tmp}\ZaliMessenger-download.exe');
    DownloadPage.SetText('Загрузка версии ' + DownloadedVersion + '...', DownloadUrl);
    if not HttpDownloadFile(DownloadUrl, DownloadedExePath) then
    begin
      MsgBox('Не удалось загрузить файл установки с сервера.', mbError, MB_OK);
      Result := False;
      Exit;
    end;

    if Sha256 <> '' then
    begin
      DownloadPage.SetText('Проверка контрольной суммы...', '');
      if not VerifySha256(DownloadedExePath, Sha256) then
      begin
        MsgBox('Контрольная сумма загруженного файла не совпадает с ожидаемой. Установка отменена — файл мог быть повреждён при загрузке.', mbError, MB_OK);
        DeleteFile(DownloadedExePath);
        Result := False;
        Exit;
      end;
    end;
  finally
    DownloadPage.Hide;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then
  begin
    ForceDirectories(ExpandConstant('{app}'));
    if not FileCopy(DownloadedExePath, ExpandConstant('{app}\{#MyAppExeName}'), False) then
    begin
      MsgBox('Не удалось скопировать загруженный файл в папку установки.', mbError, MB_OK);
      Abort;
    end;
    DeleteFile(DownloadedExePath);
  end;
end;
