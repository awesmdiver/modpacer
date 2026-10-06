// ModPacer: the tray program (queue: updater-tray-program, 2026-10-03).
//
// A tiny native Windows program, compiled with the C# compiler that ships with Windows itself
// (see build-launcher.ps1), so a player installs nothing and nothing is packed or obfuscated.
// It runs the updater's own server (runtime\node.exe + server.js, hidden), puts an icon in the
// system tray, and opens the updater's page. One copy only: if the updater already answers on its
// port, a second launch just opens the page and exits.
//
// First start after an install (and only then): one tray balloon says the program is here and where to find it. A small flag file in the data
// folder (tray-notice-shown) makes it once; an update keeps the data folder, so it never repeats.
// The page is opened by THIS program (the shell opens the default browser), never by the hidden Node child, and the browser is allowed to take
// the foreground, so it comes up in front when ModPacer was started from the installer's last page or the Start Menu.
//
// Test hooks (environment): PORT (spare port), MODPACER_NO_BROWSER (never open a page),
// MODPACER_DATA_DIR (scratch data folder; passed on to the server untouched).

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

static class Launcher
{
    const string Title = "ModPacer";
    const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    const string RunValueName = "ModPacer";

    static int port;
    static string url;
    static string installDir;
    static Process server;
    static NotifyIcon tray;
    static IntPtr job = IntPtr.Zero;
    static bool stopping;
    const string NoticeFlagName = "tray-notice-shown";
    const string NoticeTitle = "ModPacer is running";
    const string NoticeText = "Look for its icon by the clock. Double-click it to open ModPacer.";

    [STAThread]
    static int Main()
    {
        installDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        int.TryParse(Environment.GetEnvironmentVariable("PORT"), out port);
        if (port <= 0) port = 47821;
        url = "http://127.0.0.1:" + port + "/";

        // One copy only: the updater already answers -> just open it.
        if (PingIsUpdater())
        {
            OpenPage();
            return 0;
        }

        string nodeExe = Path.Combine(installDir, "runtime", "node.exe");
        if (!File.Exists(nodeExe)) nodeExe = "node"; // the dev repo: Node.js on the PATH
        string serverJs = Path.Combine(installDir, "server.js");
        if (!File.Exists(serverJs))
        {
            MessageBox.Show("ModPacer's files are missing next to this program. Download ModPacer again and unzip all of it.", Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 1;
        }

        var psi = new ProcessStartInfo(nodeExe, "\"" + serverJs + "\"")
        {
            WorkingDirectory = installDir,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
        };
        psi.EnvironmentVariables["PORT"] = port.ToString();
        psi.EnvironmentVariables["MODPACER_NO_BROWSER"] = "1"; // this program opens the page itself
        try
        {
            server = Process.Start(psi);
        }
        catch (Exception)
        {
            MessageBox.Show("ModPacer couldn't start. Its Node.js program wasn't found.", Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 1;
        }
        KeepServerInJob(server);

        // Wait (up to ~20 s) for it to answer. If it dies first, a copy that started a moment before
        // us may own the port: then it's the same "just open it" case.
        bool up = false;
        for (int i = 0; i < 80 && !up; i++)
        {
            if (server.HasExited) break;
            up = PingIsUpdater();
            if (!up) Thread.Sleep(250);
        }
        if (!up)
        {
            if (PingIsUpdater()) { OpenPage(); return 0; }
            try { if (!server.HasExited) KillServer(); } catch { }
            MessageBox.Show("ModPacer didn't start. Something else may be using port " + port + ".", Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 1;
        }

        Application.EnableVisualStyles();
        BuildTray();
        OpenPage();
        ShowFirstStartNotice();

        // If the server ever ends on its own, the icon goes away with it.
        server.EnableRaisingEvents = true;
        server.Exited += delegate { if (!stopping) Quit(); };
        Application.Run();
        return 0;
    }

    static void BuildTray()
    {
        var menu = new ContextMenuStrip();
        var status = new ToolStripMenuItem(Title + " · Running") { Enabled = false };
        var open = new ToolStripMenuItem("Open ModPacer", null, delegate { OpenPage(); });
        open.Font = new Font(open.Font, FontStyle.Bold);
        var check = new ToolStripMenuItem("Check for updates now", null, delegate { CheckNow(); });
        var autostart = new ToolStripMenuItem("Start with Windows") { CheckOnClick = true, Checked = AutostartOn() };
        autostart.CheckedChanged += delegate { SetAutostart(autostart.Checked); };
        var stop = new ToolStripMenuItem("Stop", null, delegate { Quit(); });
        menu.Items.AddRange(new ToolStripItem[] { status, open, check, new ToolStripSeparator(), autostart, new ToolStripSeparator(), stop });

        Icon icon;
        try { icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
        catch { icon = SystemIcons.Application; }

        tray = new NotifyIcon { Icon = icon, Text = Title, ContextMenuStrip = menu, Visible = true };
        tray.DoubleClick += delegate { OpenPage(); };
    }

    static void Quit()
    {
        stopping = true;
        try { if (tray != null) { tray.Visible = false; tray.Dispose(); } } catch { }
        KillServer();
        Application.ExitThread();
        Environment.Exit(0);
    }

    static void KillServer()
    {
        try
        {
            if (server != null && !server.HasExited)
            {
                server.Kill();
                server.WaitForExit(3000);
            }
        }
        catch { }
    }

    // Where ModPacer keeps its own data: MODPACER_DATA_DIR (tests) or its own folder (every player), the same rule as lib/data-dir.js.
    static string DataDir()
    {
        string d = Environment.GetEnvironmentVariable("MODPACER_DATA_DIR");
        return string.IsNullOrEmpty(d) ? installDir : d;
    }

    // One balloon, the first time this program ever runs against this data folder.
    static void ShowFirstStartNotice()
    {
        try
        {
            string flag = Path.Combine(DataDir(), NoticeFlagName);
            if (File.Exists(flag) || tray == null) return;
            tray.ShowBalloonTip(10000, NoticeTitle, NoticeText, ToolTipIcon.Info);
            File.WriteAllText(flag, "shown");
        }
        catch { /* a read-only folder or no notification area: never a reason to stop */ }
    }

    [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int processId);

    static void OpenPage()
    {
        if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MODPACER_NO_BROWSER"))) return;
        // Windows only lets a program take the foreground when the program that asks has it. This one is started from the installer's last page or
        // the Start Menu, so it has it; ASFW_ANY (-1) passes that permission on to the browser the shell starts.
        try { AllowSetForegroundWindow(-1); } catch { }
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
    }

    static void CheckNow()
    {
        ThreadPool.QueueUserWorkItem(delegate
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(url + "api/check");
                req.Method = "POST";
                req.ContentType = "application/json";
                req.Headers.Add("X-ModPacer", "1"); // tells the server this call is ours, not another website's
                req.Timeout = 120000;
                byte[] body = Encoding.UTF8.GetBytes("{}");
                req.ContentLength = body.Length;
                using (var s = req.GetRequestStream()) s.Write(body, 0, body.Length);
                using (req.GetResponse()) { }
            }
            catch { }
        });
    }

    // ---- start with Windows (this player's own Run key; off by default) ----
    static bool AutostartOn()
    {
        try
        {
            using (var k = Registry.CurrentUser.OpenSubKey(RunKeyPath))
                return k != null && k.GetValue(RunValueName) != null;
        }
        catch { return false; }
    }

    static void SetAutostart(bool on)
    {
        try
        {
            using (var k = Registry.CurrentUser.CreateSubKey(RunKeyPath))
            {
                if (on) k.SetValue(RunValueName, "\"" + Application.ExecutablePath + "\"");
                else k.DeleteValue(RunValueName, false);
            }
        }
        catch { }
    }

    // ---- is the thing on our port this updater? (same question as server.js's pingExistingServer) ----
    static bool PingIsUpdater()
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create(url + "api/ping");
            req.Timeout = 2000;
            using (var res = req.GetResponse())
            using (var r = new StreamReader(res.GetResponseStream()))
                return r.ReadToEnd().Contains("\"modpacer\"");
        }
        catch { return false; }
    }

    // ---- the server is tied to this program: if this program is ended any way at all, Windows ends it too ----
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint size);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    static void KeepServerInJob(Process p)
    {
        try
        {
            job = CreateJobObject(IntPtr.Zero, null);
            var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr ptr = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(info, ptr, false);
                SetInformationJobObject(job, 9, ptr, (uint)size); // JobObjectExtendedLimitInformation
            }
            finally { Marshal.FreeHGlobal(ptr); }
            AssignProcessToJobObject(job, p.Handle);
        }
        catch { /* best effort: Stop still ends the server */ }
    }
}
