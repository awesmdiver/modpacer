'use strict';
// The Vortex Bridge comes inside ModPacer: the release package holds it unpacked (helper/vortex-bridge/) and as a ready-to-drop
// .zip (helper/vortex-bridge.zip). ModPacer never installs it: it must NEVER write, copy, rename or delete anything in Vortex's folders
// (director, 2026-10-05). The setup step and the banner only give the person a quick way to the .zip (Explorer opens on it, file selected)
// and tell them to drop it onto Vortex's Extensions page themselves. Reading Vortex's add-ons folder, to notice whether the Bridge (or the
// extension it replaced) is there, is lib/mod-manager.js's job and is read-only. A dev checkout has no bundle: "not bundled".

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process'); // used as childProcess.spawn so a test can stand in for it
const modManager = require('./mod-manager');

const APP_ROOT = path.join(__dirname, '..');
const BUNDLED_DIR = path.join(APP_ROOT, 'helper', modManager.HELPER_FOLDER_NAME);
const BUNDLED_ZIP = path.join(APP_ROOT, 'helper', modManager.HELPER_FOLDER_NAME + '.zip');

// Overridable so tests can use a scratch "package" (HELPER_BUNDLE_DIR holds the unpacked folder's parent: <dir>/<name>/ and <dir>/<name>.zip).
function bundlePaths() {
    if (process.env.HELPER_BUNDLE_DIR) {
        const base = process.env.HELPER_BUNDLE_DIR;
        return { dir: path.join(base, modManager.HELPER_FOLDER_NAME), zip: path.join(base, modManager.HELPER_FOLDER_NAME + '.zip') };
    }
    return { dir: BUNDLED_DIR, zip: BUNDLED_ZIP };
}

function readVersion(folder) {
    try {
        const info = JSON.parse(fs.readFileSync(path.join(folder, 'info.json'), 'utf8'));
        return typeof info.version === 'string' ? info.version : null;
    } catch {
        return null;
    }
}

// True when this copy of ModPacer carries the Bridge (folder with its files AND the .zip).
function isBundled() {
    const { dir, zip } = bundlePaths();
    try {
        return fs.statSync(path.join(dir, 'info.json')).isFile() && fs.statSync(path.join(dir, 'index.js')).isFile() && fs.statSync(zip).isFile();
    } catch {
        return false;
    }
}

function bundledVersion() { return isBundled() ? readVersion(bundlePaths().dir) : null; }

// PowerShell that finds the Explorer window showing `folder`, brings it to the front (Alt key trick so Windows allows the
// focus change, restore if minimised) and, when that is refused, flashes its taskbar button. Run once, a moment after
// Explorer starts. Everything is best effort; the page text tells the player to look at the taskbar anyway.
const FRONT_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -Namespace W -Name N -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, int f, int e);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[StructLayout(LayoutKind.Sequential)] public struct FLASHWINFO { public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout; }
[DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO f);
'@
$want = ([System.IO.Path]::GetFullPath($env:HELPER_FRONT_FOLDER)).TrimEnd('\\').ToLowerInvariant()
$shell = New-Object -ComObject Shell.Application
for ($i = 0; $i -lt 30; $i++) {
    foreach ($w in $shell.Windows()) {
        $loc = $null
        try { $loc = [Uri]::UnescapeDataString(([Uri]$w.LocationURL).LocalPath).TrimEnd('\\').ToLowerInvariant() } catch { }
        if ($loc -eq $want) {
            $h = [IntPtr]$w.HWND
            if ([W.N]::IsIconic($h)) { [void][W.N]::ShowWindow($h, 9) }
            [W.N]::keybd_event(0x12, 0, 0, 0); [W.N]::keybd_event(0x12, 0, 2, 0)
            [void][W.N]::SetForegroundWindow($h)
            Start-Sleep -Milliseconds 150
            if ([W.N]::GetForegroundWindow() -ne $h) {
                $f = New-Object W.N+FLASHWINFO
                $f.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($f); $f.hwnd = $h; $f.dwFlags = 3 -bor 12; $f.uCount = 5
                [void][W.N]::FlashWindowEx([ref]$f)
                Write-Output 'flashed'
            } else { Write-Output 'front' }
            exit 0
        }
    }
    Start-Sleep -Milliseconds 200
}
Write-Output 'notfound'
`;

// Opens Windows Explorer on the folder holding the bundled .zip with the .zip selected, then tries to bring that window to
// the front. Returns { ok, zip } -- ok false when the package carries no .zip. Never throws. The returned `front`
// promise settles with 'front' | 'flashed' | 'notfound' | 'error' (for tests; the player's window says nothing about it: a
// window that could not be brought forward is written to logs/update.log only).
function openZipFolder() {
    if (!isBundled()) return { ok: false, reason: 'not_bundled', front: Promise.resolve('error') };
    const { zip } = bundlePaths();
    try {
        childProcess.spawn('explorer.exe', [`/select,"${zip}"`], { windowsHide: false, windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }) // explorer wants /select,"path" with the quotes around the path only.unref();
    } catch {
        return { ok: false, reason: 'explorer_failed', front: Promise.resolve('error') };
    }
    const front = new Promise((resolve) => {
        try {
            const ps = childProcess.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(FRONT_SCRIPT, 'utf16le').toString('base64')], {
                windowsHide: true, env: { ...process.env, HELPER_FRONT_FOLDER: path.dirname(zip) },
            });
            let out = '';
            ps.stdout.on('data', (d) => { out += d; });
            ps.on('error', () => resolve('error'));
            ps.on('close', () => resolve(out.trim() || 'error'));
        } catch {
            resolve('error');
        }
    });
    return { ok: true, zip, front };
}

module.exports = { isBundled, bundledVersion, openZipFolder, bundlePaths, FRONT_SCRIPT };
