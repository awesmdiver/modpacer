# Compiles ModPacer.exe from launcher\Launcher.cs with the C# compiler that ships with Windows
# (.NET Framework 4, present on every Windows 10/11 PC), so nothing extra is needed to build it or run it.
# Usage: pwsh launcher\build-launcher.ps1 [-OutDir <folder>]    (default: the dev repo root, gitignored)
param([string]$OutDir = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference = "Stop"
$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { throw "Windows' own C# compiler wasn't found at $csc." }
$exe = Join-Path $OutDir "ModPacer.exe"
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$ico = Join-Path $PSScriptRoot "modpacer.ico"
$src = Join-Path $PSScriptRoot "Launcher.cs"
& $csc /nologo /target:winexe /platform:x64 /optimize+ "/out:$exe" "/win32icon:$ico" `
    /reference:System.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll $src
if ($LASTEXITCODE -ne 0) { throw "The launcher didn't compile (exit $LASTEXITCODE)." }
Write-Host "Built $exe"
