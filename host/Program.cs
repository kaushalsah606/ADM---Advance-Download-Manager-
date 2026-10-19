// Advance Download Manager - native Windows host.
//   * one real top-level window (taskbar button, icon, snap/maximize, DPI aware) showing the app UI through Microsoft WebView2
//   * notification-area icon with menu, live speed tooltip and completion balloons
//   * starts and supervises the download engine (adm-engine.exe); closing the window keeps downloads running in the tray
//   * single instance; a second launch (or a /d link) is handed to the running one
// Written for the C# 5 compiler that ships with Windows (no SDK needed).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: AssemblyTitle("Advance Download Manager")]
[assembly: AssemblyProduct("Advance Download Manager")]
[assembly: AssemblyCompany("@kaushalsah606")]
[assembly: AssemblyCopyright("MIT License - Copyright (c) 2026 @kaushalsah606")]
[assembly: AssemblyVersion("1.1.0.0")]
[assembly: AssemblyFileVersion("1.1.0.0")]
[assembly: AssemblyDescription("Free, open-source download manager")]

namespace AdvanceDownloadManager
{
    sealed class Session
    {
        public int Port;
        public string Token;
    }

    static class Fmt
    {
        // B/s below 1 KB, KB/s below 1 MB, MB/s below 1 GB, then GB/s
        public static string Speed(double bytesPerSecond)
        {
            double n = Math.Max(0, bytesPerSecond);
            if (n < 1024) return string.Format("{0:N0} B/s", n);
            if (n < 1048576) return string.Format("{0:N0} KB/s", n / 1024);
            if (n < 1073741824) return string.Format("{0:N2} MB/s", n / 1048576);
            return string.Format("{0:N2} GB/s", n / 1073741824);
        }
    }

    static class Engine
    {
        public static string Dir { get { return Path.GetDirectoryName(Application.ExecutablePath); } }
        public static string ExePath { get { return Path.Combine(Dir, "adm-engine.exe"); } }

        /// <summary>Engine data folder; ADM_DATA_DIR overrides the default (used by tests).</summary>
        public static string DataDir
        {
            get
            {
                string d = Environment.GetEnvironmentVariable("ADM_DATA_DIR");
                return string.IsNullOrEmpty(d) ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".advance-download-manager") : d;
            }
        }

        public static string QuoteArg(string a)
        {
            if (a.Length > 0 && a.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return a;
            return "\"" + a.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        }

        public static Session ReadSession()
        {
            try
            {
                string p = Path.Combine(DataDir, "session.json");
                var d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(p));
                return new Session { Port = Convert.ToInt32(d["port"]), Token = (string)d["token"] };
            }
            catch { return null; }
        }

        public static string Call(Session s, string method, string path, int timeoutMs, string body = null)
        {
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + s.Port + path);
            req.Method = method;
            req.Timeout = timeoutMs;
            req.ReadWriteTimeout = timeoutMs;
            req.Proxy = null;
            req.Headers["X-Token"] = s.Token;
            if (method == "POST" || method == "PUT")
            {
                byte[] payload = Encoding.UTF8.GetBytes(body ?? "{}");
                req.ContentType = "application/json";
                req.ContentLength = payload.Length;
                using (var w = req.GetRequestStream()) w.Write(payload, 0, payload.Length);
            }
            using (var res = (HttpWebResponse)req.GetResponse())
            using (var r = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                return r.ReadToEnd();
        }

        public static bool Ping(Session s)
        {
            if (s == null) return false;
            try { Call(s, "GET", "/api/state", 2500); return true; } catch { return false; }
        }

        /// <summary>Starts the engine (or hands the command line to the running one) and waits until its API answers.</summary>
        public static Session Ensure(string[] passArgs, int waitMs)
        {
            var existing = ReadSession();
            if (passArgs.Length == 0 && Ping(existing)) return existing;
            if (!File.Exists(ExePath)) return null;
            var psi = new ProcessStartInfo(ExePath);
            var sb = new StringBuilder("--no-open --no-tray");
            if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable("ADM_DATA_DIR"))) sb.Append(" --data ").Append(QuoteArg(DataDir));
            foreach (var a in passArgs) sb.Append(' ').Append(QuoteArg(a));
            psi.Arguments = sb.ToString();
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.EnvironmentVariables["ADM_HOST_EXE"] = Application.ExecutablePath;
            Process.Start(psi);
            var until = DateTime.UtcNow.AddMilliseconds(waitMs);
            while (DateTime.UtcNow < until)
            {
                Thread.Sleep(300);
                var s = ReadSession();
                if (Ping(s)) return s;
            }
            return null;
        }
    }

    sealed class MainForm : Form
    {
        readonly string[] args;
        /// <summary>Window position and the WebView2 profile; ADM_HOST_DATA overrides it (tests must not share a profile with a real running copy).</summary>
        static string HostDataDir
        {
            get
            {
                string d = Environment.GetEnvironmentVariable("ADM_HOST_DATA");
                return string.IsNullOrEmpty(d) ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Advance Download Manager") : d;
            }
        }
        readonly bool startHidden;
        readonly string logFile = Environment.GetEnvironmentVariable("ADM_HOST_LOG");
        readonly bool selfTest = Environment.GetEnvironmentVariable("ADM_HOST_SELFTEST") == "1";
        readonly EventWaitHandle showEvent, quitEvent, setupEvent;
        bool setupAtStart;
        string lastClip, offeredUrl;
        bool clipOffer = true, firstClip = true;
        readonly HashSet<string> pairNotified = new HashSet<string>();
        readonly HashSet<string> proposalNotified = new HashSet<string>();
        readonly HashSet<string> videoNotified = new HashSet<string>();
        readonly System.Windows.Forms.Timer clipTimer = new System.Windows.Forms.Timer();
        readonly string settingsFile;
        readonly HashSet<string> seenComplete = new HashSet<string>();
        readonly System.Windows.Forms.Timer poll = new System.Windows.Forms.Timer();
        readonly JavaScriptSerializer json = new JavaScriptSerializer();
        WebView2 web;
        NotifyIcon tray;
        string balloonFile; // set while the "Download complete" balloon is showing: clicking it opens the folder with the file
        ToolStripMenuItem miOpen, miStart, miStop, miTurbo, miExit;
        Session session;
        bool allowVisible, exiting, firstState = true, trayEnabled = true, busy, turboOn;
        int failures;

        public MainForm(string[] args, EventWaitHandle showEvent, EventWaitHandle quitEvent, EventWaitHandle setupEvent)
        {
            this.args = args;
            this.showEvent = showEvent;
            this.quitEvent = quitEvent;
            this.setupEvent = setupEvent;
            setupAtStart = Array.IndexOf(args, "--setup-browsers") >= 0;
            startHidden = Array.IndexOf(args, "--minimized") >= 0;
            string dir = HostDataDir;
            Directory.CreateDirectory(dir);
            settingsFile = Path.Combine(dir, "window.json");
            EnsureAutostartOnFirstRun(dir);

            Text = "Advance Download Manager";
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            MinimumSize = new Size(900, 560);
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(1200, 760);
            LoadBounds();

            tray = new NotifyIcon();
            tray.Icon = new Icon(Icon, SystemInformation.SmallIconSize);
            tray.Text = "Advance Download Manager";
            var menu = new ContextMenuStrip();
            miOpen = new ToolStripMenuItem("Open Advance Download Manager");
            miStart = new ToolStripMenuItem("Start main queue");
            miStop = new ToolStripMenuItem("Stop all downloads");
            miTurbo = new ToolStripMenuItem("Turbo mode (no speed limits)");
            miExit = new ToolStripMenuItem("Exit");
            miOpen.Font = new Font(miOpen.Font, FontStyle.Bold);
            menu.Items.Add(miOpen);
            menu.Items.Add(miStart);
            menu.Items.Add(miStop);
            menu.Items.Add(miTurbo);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(miExit);
            tray.ContextMenuStrip = menu;
            miOpen.Click += delegate { Log("tray: open"); ShowWindow(); };
            miStart.Click += delegate { Log("tray: start queue"); Fire("POST", "/api/queues/main/start"); };
            miStop.Click += delegate { Log("tray: stop all"); Fire("POST", "/api/stop-all"); };
            miTurbo.Click += delegate { Log("tray: turbo " + (turboOn ? "off" : "on")); Fire("PUT", "/api/settings", "{\"turbo\":" + (turboOn ? "false" : "true") + "}"); };
            miExit.Click += delegate { Log("tray: exit"); ExitApp(true); };
            tray.MouseClick += delegate (object s, MouseEventArgs e) { if (e.Button == MouseButtons.Left) ShowWindow(); };
            tray.Visible = true;

            poll.Interval = 1500;
            poll.Tick += delegate { Poll(); };
            clipTimer.Interval = 1000;
            clipTimer.Tick += delegate { CheckClipboard(); };
            tray.BalloonTipClicked += delegate { BalloonClicked(); };

            var t = new Thread(WaitForSignals) { IsBackground = true };
            t.Start();

            var unused = Handle; // create the window handle now so background work can marshal back to the UI thread
            StartEngine();
        }

        void Log(string m)
        {
            if (string.IsNullOrEmpty(logFile)) return;
            try { File.AppendAllText(logFile, DateTime.Now.ToString("HH:mm:ss.fff") + " " + m + "\r\n"); } catch { }
        }

        protected override void SetVisibleCore(bool value)
        {
            // when started with --minimized the window stays hidden until the user asks for it
            if (!allowVisible && !startHidden) allowVisible = true;
            base.SetVisibleCore(allowVisible ? value : false);
        }

        void WaitForSignals()
        {
            var handles = new WaitHandle[] { showEvent, quitEvent, setupEvent };
            while (true)
            {
                int i = WaitHandle.WaitAny(handles);
                try
                {
                    if (i == 0) BeginInvoke((MethodInvoker)ShowWindow);
                    else if (i == 2) BeginInvoke((MethodInvoker)delegate { ShowWindow(); OpenBrowserSetup(); });
                    else BeginInvoke((MethodInvoker)delegate { ExitApp(true); });
                }
                catch { return; }
            }
        }

        /// <summary>Show the window on top of other windows (a new download needs an answer), without staying topmost.</summary>
        void ShowWindowForeground()
        {
            ShowWindow();
            try { TopMost = true; TopMost = false; } catch { }
        }

        void OpenBrowserSetup()
        {
            Log("open browser setup");
            try { if (web != null && web.CoreWebView2 != null) web.CoreWebView2.ExecuteScriptAsync("openBrowserSetup()"); } catch { }
        }

        public void ShowWindow()
        {
            allowVisible = true;
            if (!Visible) Show();
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
            BringToFront();
            Log("window shown");
        }

        void LoadBounds()
        {
            try
            {
                var d = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(settingsFile));
                var r = new Rectangle(Convert.ToInt32(d["x"]), Convert.ToInt32(d["y"]), Convert.ToInt32(d["w"]), Convert.ToInt32(d["h"]));
                foreach (var sc in Screen.AllScreens)
                    if (sc.WorkingArea.IntersectsWith(r) && r.Width >= 600 && r.Height >= 400)
                    {
                        StartPosition = FormStartPosition.Manual;
                        Bounds = r;
                        if (d.ContainsKey("max") && Convert.ToBoolean(d["max"])) WindowState = FormWindowState.Maximized;
                        return;
                    }
            }
            catch { }
        }

        // The first time the app runs it registers itself to start (in the tray) when you sign in to Windows. Turning it off in
        // Options -> General is remembered: the marker file keeps this from running again.
        void EnsureAutostartOnFirstRun(string dir)
        {
            try
            {
                if (selfTest) return;
                string marker = Path.Combine(dir, "autostart.set");
                if (File.Exists(marker)) return;
                using (var key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run"))
                {
                    if (key != null && key.GetValue("Advance Download Manager") == null) key.SetValue("Advance Download Manager", "\"" + Application.ExecutablePath + "\" --minimized");
                }
                File.WriteAllText(marker, DateTime.Now.ToString("o"));
            }
            catch { }
        }

        void SaveBounds()
        {
            try
            {
                var b = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
                File.WriteAllText(settingsFile, json.Serialize(new Dictionary<string, object> {
                    { "x", b.X }, { "y", b.Y }, { "w", b.Width }, { "h", b.Height }, { "max", WindowState == FormWindowState.Maximized } }));
            }
            catch { }
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
        }

        // Started from the constructor, not OnLoad: a window that starts hidden (--minimized) never raises Load.
        void StartEngine()
        {
            Task.Factory.StartNew(delegate { return Engine.Ensure(args, 25000); }).ContinueWith(t =>
            {
                BeginInvoke((MethodInvoker)delegate { OnEngineReady(t.Result); });
            });
        }

        void OnEngineReady(Session s)
        {
            if (s == null)
            {
                MessageBox.Show("Advance Download Manager could not start its download engine (adm-engine.exe).\r\nReinstall the application and try again.",
                    "Advance Download Manager", MessageBoxButtons.OK, MessageBoxIcon.Error);
                ExitApp(false);
                return;
            }
            session = s;
            Log("engine ready on port " + s.Port);
            StartWebView();
            poll.Start();
            clipTimer.Start();
            if (selfTest) StartSelfTest();
        }

        async void StartWebView()
        {
            try
            {
                string data = Path.Combine(HostDataDir, "webview");
                var env = await CoreWebView2Environment.CreateAsync(null, data, null);
                web = new WebView2();
                web.Dock = DockStyle.Fill;
                web.DefaultBackgroundColor = Color.White;
                Controls.Add(web);
                await web.EnsureCoreWebView2Async(env);
                var st = web.CoreWebView2.Settings;
                st.AreDevToolsEnabled = Environment.GetEnvironmentVariable("ADM_HOST_DEVTOOLS") == "1";
                st.IsStatusBarEnabled = false;
                st.IsGeneralAutofillEnabled = false;
                st.IsPasswordAutosaveEnabled = false;
                st.IsPinchZoomEnabled = false;
                st.IsSwipeNavigationEnabled = false;
                // the window should feel like an application, not like a web page: no browser dialogs, shortcuts, permission popups or page menu
                st.AreDefaultScriptDialogsEnabled = false;
                st.AreBrowserAcceleratorKeysEnabled = false;
                st.IsZoomControlEnabled = false;
                web.CoreWebView2.PermissionRequested += delegate (object s, CoreWebView2PermissionRequestedEventArgs e) { e.State = CoreWebView2PermissionState.Deny; };
                web.CoreWebView2.ContextMenuRequested += delegate (object s, CoreWebView2ContextMenuRequestedEventArgs e)
                {
                    // keep only editing entries (Cut / Copy / Paste ...), drop Back, Reload, Save as, Print, Inspect ...
                    for (int i = e.MenuItems.Count - 1; i >= 0; i--)
                    {
                        string n = e.MenuItems[i].Name;
                        if (n != "cut" && n != "copy" && n != "paste" && n != "pasteAsPlainText" && n != "selectAll" && n != "undo" && n != "redo" && n != "delete") e.MenuItems.RemoveAt(i);
                    }
                };
                // questions the page cannot ask the system itself (the web page only talks to this window, never to other sites)
                web.CoreWebView2.WebMessageReceived += delegate (object s, CoreWebView2WebMessageReceivedEventArgs e)
                {
                    try
                    {
                        if (e.Source == null || !e.Source.StartsWith("http://127.0.0.1:")) return;
                        var msg = json.DeserializeObject(e.TryGetWebMessageAsString()) as Dictionary<string, object>;
                        if (msg == null || !msg.ContainsKey("type")) return;
                        if (selfTest && Convert.ToString(msg["type"]) == "log") { Log("page: " + Convert.ToString(msg["text"])); return; }
                        if (Convert.ToString(msg["type"]) != "clipboard") return;
                        string text = "";
                        try { if (Clipboard.ContainsText()) text = Clipboard.GetText().Trim(); } catch { }
                        if (text.Length > 2000 || !Regex.IsMatch(text, @"^(https?|ftp)://\S+$", RegexOptions.IgnoreCase)) text = ""; // only a web address ever leaves the clipboard
                        web.CoreWebView2.PostWebMessageAsString(json.Serialize(new Dictionary<string, object> { { "id", msg.ContainsKey("id") ? msg["id"] : 0 }, { "text", text } }));
                    }
                    catch { }
                };
                web.CoreWebView2.NewWindowRequested += delegate (object s, CoreWebView2NewWindowRequestedEventArgs e) { e.Handled = true; OpenExternal(e.Uri); };
                web.CoreWebView2.NavigationStarting += delegate (object s, CoreWebView2NavigationStartingEventArgs e)
                {
                    Uri u;
                    if (Uri.TryCreate(e.Uri, UriKind.Absolute, out u) && (u.Scheme == "http" || u.Scheme == "https") && u.Host != "127.0.0.1") { e.Cancel = true; OpenExternal(e.Uri); }
                };
                web.CoreWebView2.DocumentTitleChanged += delegate { /* the window keeps its fixed title */ };
                web.CoreWebView2.NavigationCompleted += delegate (object s, CoreWebView2NavigationCompletedEventArgs e) { Log("page loaded ok=" + e.IsSuccess); if (e.IsSuccess && setupAtStart) { setupAtStart = false; ShowWindow(); OpenBrowserSetup(); } };
                web.Source = new Uri("http://127.0.0.1:" + session.Port + "/");
            }
            catch (Exception ex)
            {
                Log("webview failed: " + ex.GetType().Name + " " + ex.Message);
                FallbackToBrowser(ex);
            }
        }

        void FallbackToBrowser(Exception ex)
        {
            if (web != null) { Controls.Remove(web); web.Dispose(); web = null; }
            var r = MessageBox.Show("The Microsoft Edge WebView2 Runtime is not installed, so the built-in window cannot be shown.\r\n\r\n" +
                "Yes: open the page in your browser now\r\nNo: download the WebView2 Runtime (recommended)", "Advance Download Manager", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
            if (r == DialogResult.No) OpenExternal("https://go.microsoft.com/fwlink/p/?LinkId=2124703");
            else OpenExternal("http://127.0.0.1:" + session.Port + "/");
            Hide();
        }

        static void OpenExternal(string url)
        {
            Uri u;
            if (!Uri.TryCreate(url, UriKind.Absolute, out u) || (u.Scheme != "http" && u.Scheme != "https")) return;
            try { Process.Start(new ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true }); } catch { }
        }

        void Fire(string method, string path, string body = null)
        {
            var s = session;
            if (s == null) return;
            Task.Factory.StartNew(delegate { try { Engine.Call(s, method, path, 5000, body); } catch { } });
        }

        void Poll()
        {
            if (busy || session == null) return;
            busy = true;
            var s = session;
            Task.Factory.StartNew(delegate { try { return Engine.Call(s, "GET", "/api/state", 2500); } catch { return null; } }).ContinueWith(t =>
            {
                try { BeginInvoke((MethodInvoker)delegate { busy = false; OnState(t.Result); }); } catch { }
            });
        }

        void OnState(string body)
        {
            if (exiting) return;
            if (body == null)
            {
                failures++;
                if (failures >= 3) { Log("engine gone, exiting"); ExitApp(false); }
                return;
            }
            failures = 0;
            try
            {
                var root = json.Deserialize<Dictionary<string, object>>(body);
                var list = root["downloads"] as System.Collections.IList;
                int active = 0; double speed = 0;
                if (list != null)
                    foreach (Dictionary<string, object> d in list)
                    {
                        string status = d.ContainsKey("status") ? Convert.ToString(d["status"]) : "";
                        if (status == "downloading") { active++; if (d.ContainsKey("speed") && d["speed"] != null) speed += Convert.ToDouble(d["speed"]); }
                        if (status == "complete")
                        {
                            string id = Convert.ToString(d["id"]);
                            if (seenComplete.Add(id) && (!firstState || selfTest) && tray.Visible)
                            {
                                string dir = d.ContainsKey("saveDir") ? Convert.ToString(d["saveDir"]) : "";
                                balloonFile = dir.Length > 0 ? Path.Combine(dir, Convert.ToString(d["fileName"])) : null;
                                tray.ShowBalloonTip(4000, "Download complete (click to open the folder)", Convert.ToString(d["fileName"]), ToolTipIcon.Info);
                                if (selfTest) BalloonClicked(); // the self-test clicks the balloon
                            }
                        }
                    }
                firstState = false;
                string tip = active > 0 ? string.Format("Advance Download Manager - {0} active, {1}", active, Fmt.Speed(speed)) : "Advance Download Manager - idle";
                tray.Text = tip.Length > 63 ? tip.Substring(0, 63) : tip;
                if (selfTest) Log("tooltip=" + tray.Text);
                var settings = root.ContainsKey("settings") ? root["settings"] as Dictionary<string, object> : null;
                trayEnabled = settings == null || !settings.ContainsKey("trayIcon") || Convert.ToBoolean(settings["trayIcon"]);
                turboOn = settings != null && settings.ContainsKey("turbo") && settings["turbo"] != null && Convert.ToBoolean(settings["turbo"]);
                miTurbo.Checked = turboOn;
                if (turboOn && active > 0) tray.Text = (tray.Text.Length > 55 ? tray.Text.Substring(0, 55) : tray.Text) + " [TURBO]";
                tray.Visible = trayEnabled;
                clipOffer = settings == null || !settings.ContainsKey("clipboardOffer") || Convert.ToBoolean(settings["clipboardOffer"]);
                var props = root.ContainsKey("proposals") ? root["proposals"] as System.Collections.IList : null;
                if (props != null)
                    foreach (Dictionary<string, object> pr in props)
                    {
                        string pid = Convert.ToString(pr["id"]);
                        if (!proposalNotified.Add(pid)) continue;
                        Log("download request: " + Convert.ToString(pr["url"]));
                        ShowWindowForeground(); // the "Download File Info" dialog is inside the window
                    }
                var vids = root.ContainsKey("videoRequests") ? root["videoRequests"] as System.Collections.IList : null;
                if (vids != null)
                    foreach (Dictionary<string, object> vr in vids)
                    {
                        string vid = Convert.ToString(vr["id"]);
                        if (!videoNotified.Add(vid)) continue;
                        Log("video request: " + Convert.ToString(vr["id"]));
                        ShowWindowForeground(); // the "Download video" dialog is inside the window
                    }
                var pend = root.ContainsKey("pendingPairs") ? root["pendingPairs"] as System.Collections.IList : null;
                if (pend != null)
                    foreach (Dictionary<string, object> p in pend)
                    {
                        string o = Convert.ToString(p["origin"]);
                        if (!pairNotified.Add(o)) continue;
                        Log("pair request: " + o);
                        ShowWindow(); // the Allow / Deny prompt is inside the window
                        tray.ShowBalloonTip(6000, "Browser extension wants to connect", "Press Allow in the Advance Download Manager window.", ToolTipIcon.Info);
                    }
            }
            catch (Exception ex) { Log("state parse: " + ex.Message); }
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (!exiting && e.CloseReason == CloseReason.UserClosing)
            {
                if (trayEnabled)
                {
                    e.Cancel = true;
                    SaveBounds();
                    Hide();
                    Log("window hidden to tray");
                    return;
                }
                ExitApp(true);
                return;
            }
            SaveBounds();
            base.OnFormClosing(e);
        }

        // ---- clipboard: offer (never auto-start) to download a link the user copied ----
        void BalloonClicked()
        {
            string f = balloonFile; balloonFile = null;
            if (f != null) ShowInFolder(f); else AddOffered();
        }

        // opens Explorer with the finished file selected (or just its folder when the file was moved / renamed)
        void ShowInFolder(string file)
        {
            try
            {
                if (selfTest) { Log("balloon: would open " + (File.Exists(file) ? "folder with the file selected: " : "folder (file missing): ") + file); return; }
                if (File.Exists(file)) Process.Start(new ProcessStartInfo("explorer.exe", "/select,\"" + file + "\"") { UseShellExecute = false });
                else if (Directory.Exists(Path.GetDirectoryName(file))) Process.Start(new ProcessStartInfo("explorer.exe", "\"" + Path.GetDirectoryName(file) + "\"") { UseShellExecute = false });
                Log("balloon: opened folder of " + Path.GetFileName(file));
            }
            catch (Exception ex) { Log("balloon: could not open folder: " + ex.Message); }
        }

        void CheckClipboard()
        {
            if (!clipOffer || session == null || exiting) return;
            string t;
            try { if (!Clipboard.ContainsText()) return; t = Clipboard.GetText().Trim(); } catch { return; }
            if (t == lastClip) return;
            lastClip = t;
            if (firstClip) { firstClip = false; if (!selfTest) return; } // ignore whatever was on the clipboard before the app started
            if (t.Length > 2000 || !Regex.IsMatch(t, @"^(https?|ftp)://\S+$", RegexOptions.IgnoreCase)) return;
            var s = session;
            string body = json.Serialize(new Dictionary<string, object> { { "url", t } });
            Task.Factory.StartNew(delegate { try { return Engine.Call(s, "POST", "/api/capture-check", 3000, body); } catch { return null; } }).ContinueWith(r =>
            {
                try
                {
                    BeginInvoke((MethodInvoker)delegate
                    {
                        if (r.Result == null || r.Result.IndexOf("\"capture\":true") < 0 || exiting) return;
                        offeredUrl = t;
                        string name = t; try { name = Path.GetFileName(new Uri(t).AbsolutePath); if (string.IsNullOrEmpty(name)) name = t; } catch { }
                        Log("clipboard: offered " + t);
                        balloonFile = null;
                        tray.ShowBalloonTip(10000, "Download this link? (click here)", name, ToolTipIcon.Info);
                        if (selfTest) AddOffered();
                    });
                }
                catch { }
            });
        }

        void AddOffered()
        {
            if (offeredUrl == null) return;
            string u = offeredUrl;
            offeredUrl = null;
            Fire("POST", "/api/propose", json.Serialize(new Dictionary<string, object> { { "url", u }, { "startNow", true }, { "queue", null }, { "source", "clipboard" } }));
            Log("clipboard: download started " + u);
        }

        void ExitApp(bool stopEngine)
        {
            if (exiting) return;
            exiting = true;
            poll.Stop();
            SaveBounds();
            if (stopEngine && session != null) { try { Engine.Call(session, "POST", "/api/shutdown", 3000); } catch { } }
            tray.Visible = false;
            tray.Dispose();
            Log("exit");
            Application.Exit();
        }

        // ---- test hook (ADM_HOST_SELFTEST=1): exercises the real window and tray menu on a schedule and logs the results ----
        void StartSelfTest()
        {
            int n = 0;
            var t = new System.Windows.Forms.Timer { Interval = 1000 };
            t.Tick += delegate
            {
                n++;
                Log("selftest " + n + " visible=" + Visible + " handle=" + (IsHandleCreated ? Handle.ToInt64().ToString() : "0") + " state=" + WindowState);
                if (n == 12) { Log("selftest: add url dialog"); try { web.CoreWebView2.ExecuteScriptAsync("openAdd().then(function () { var v = document.getElementById('fAdd').elements.url.value; document.getElementById('dAdd').close(); window.chrome.webview.postMessage(JSON.stringify({ type: 'log', text: 'add dialog url=' + v })); })"); } catch { } }
                if (n == 45) { Log("selftest: close window"); Close(); }
                if (n == 48) { Log("selftest: tray open"); miOpen.PerformClick(); }
                if (n == 51) { Log("selftest: tray start queue"); miStart.PerformClick(); }
                if (n == 55) { Log("selftest: tray turbo"); miTurbo.PerformClick(); }
                if (n == 60) { Log("selftest: tray stop all"); miStop.PerformClick(); }
                if (n == 66) { Log("selftest: tray exit"); miExit.PerformClick(); }
            };
            t.Start();
        }
    }

    static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            string inst = Environment.GetEnvironmentVariable("ADM_INSTANCE") ?? ""; // tests use a unique name so they never reach a real running copy
            bool first;
            var mutex = new Mutex(true, "Local\\AdvanceDownloadManager.Host" + inst, out first);
            var show = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\AdvanceDownloadManager.Show" + inst);
            var quit = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\AdvanceDownloadManager.Quit" + inst);
            var setup = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\AdvanceDownloadManager.Setup" + inst);
            if (!first)
            {
                // a second launch: pass the command line on, then bring the first window forward (or ask it to quit)
                if (Array.IndexOf(args, "--quit") >= 0) { quit.Set(); return 0; }
                var passArgs = new List<string>();
                foreach (var a in args) if (a != "--minimized" && a != "--setup-browsers") passArgs.Add(a);
                if (passArgs.Count > 0) Engine.Ensure(passArgs.ToArray(), 15000);
                if (Array.IndexOf(args, "--setup-browsers") >= 0) setup.Set();
                else if (Array.IndexOf(args, "--minimized") < 0) show.Set();
                return 0;
            }
            if (Array.IndexOf(args, "--quit") >= 0) return 0;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            var filtered = new List<string>();
            foreach (var a in args) if (a != "--setup-browsers") filtered.Add(a);
            Application.Run(new MainForm(args, show, quit, setup));
            GC.KeepAlive(mutex);
            return 0;
        }
    }
}
