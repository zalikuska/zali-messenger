param(
    [switch]$Run,
    [switch]$SkipBundle,
    [switch]$OnlineInstallerOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

if ($OnlineInstallerOnly) {
    # The online installer (apps\windows\installer\ZaliMessenger.iss) downloads
    # ZaliMessenger.exe from the server's /api/version endpoint at install time
    # instead of bundling a locally built one, so this path needs neither
    # cargo nor a web-asset bundle — just ISCC.exe.
    $iscc = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if (-not $iscc) {
        throw 'Inno Setup (ISCC.exe) not found on PATH. Install it from https://jrsoftware.org/isinfo.php'
    }

    $issPath = Join-Path $RepoRoot 'apps\windows\installer\ZaliMessenger.iss'
    & $iscc.Source $issPath
    if ($LASTEXITCODE -ne 0) {
        throw "ISCC.exe failed with exit code $LASTEXITCODE"
    }

    $installerExe = Join-Path $RepoRoot 'dist\windows\installer\ZaliMessengerOnlineSetup.exe'
    Write-Host "Online installer ready: $installerExe"
    exit 0
}

function Resolve-PythonCommand {
    if (Get-Command py -ErrorAction SilentlyContinue) {
        return @{ Command = 'py'; Args = @('-3') }
    }

    if (Get-Command python3 -ErrorAction SilentlyContinue) {
        return @{ Command = 'python3'; Args = @() }
    }

    if (Get-Command python -ErrorAction SilentlyContinue) {
        return @{ Command = 'python'; Args = @() }
    }

    throw 'Python 3 is required to bundle the web assets.'
}

function Invoke-CommandChecked {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command,
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed: $Command $($Arguments -join ' ')"
    }
}

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw 'Rust/Cargo is required. Install Rust with the MSVC toolchain before building.'
}

$python = Resolve-PythonCommand

if (-not $SkipBundle) {
    Write-Host 'Bundling web assets...'
    Invoke-CommandChecked -Command $python.Command -Arguments ($python.Args + @('.\scripts\bundle_web.py'))
}

Write-Host 'Building Windows client in release mode...'
Invoke-CommandChecked -Command 'cargo' -Arguments @('build', '--release', '--manifest-path', '.\apps\windows\Cargo.toml')

$sourceExe = Join-Path $RepoRoot 'apps\windows\target\release\zali_messenger_win.exe'
if (-not (Test-Path $sourceExe)) {
    throw "Expected executable not found: $sourceExe"
}

$distDir = Join-Path $RepoRoot 'dist\windows'
New-Item -ItemType Directory -Force -Path $distDir | Out-Null

$distExe = Join-Path $distDir 'ZaliMessenger.exe'
Copy-Item $sourceExe $distExe -Force

Write-Host "Windows build ready: $distExe"
Write-Host 'Notes:'
Write-Host '  - Install the Microsoft Edge WebView2 Runtime on the target machine.'
Write-Host '  - Start the server before launching the client.'
Write-Host '  - To publish this build, upload it and run POST /api/version (see CLAUDE.md'
Write-Host '    "Publishing a client release") — the online installer (-OnlineInstallerOnly)'
Write-Host '    downloads whatever that endpoint currently points to, not this local build.'

if ($Run) {
    Write-Host 'Launching Windows client...'
    & $distExe
}
