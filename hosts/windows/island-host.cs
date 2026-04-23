// island-host.cs — Windows native host for pi-island
// --------------------------------------------------
// C# WPF + WebView2 equivalent of the macOS Swift host (island-host.swift).
// Speaks the same stdin/stdout JSON-line protocol so companion.mjs works
// identically on both platforms.
//
// Protocol (stdin, one JSON object per line):
//   { "type": "html",  "html": "<base64-encoded-document>" }
//   { "type": "eval",  "js": "window.island.upsertRow(...)" }
//   { "type": "close" }
//
// Protocol (stdout, one JSON object per line):
//   { "type": "ready",  "screen": {...} }
//   { "type": "closed" }
//
// argv:
//   --width N --height N --x N --y N
//   --frameless --floating --transparent --click-through --no-dock --hidden
//
// Build:
//   dotnet publish -c Release -r win-x64 --self-contained false

using System;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace PiIsland;

// ── Stdout helper (thread-safe) ────────────────────────────────────────────

static class Stdout
{
    private static readonly object Lock = new();

    public static void Write(JsonObject obj)
    {
        var json = obj.ToJsonString(new JsonSerializerOptions { WriteIndented = false });
        lock (Lock)
        {
            Console.Out.WriteLine(json);
            Console.Out.Flush();
        }
    }
}

// ── Stderr logger ──────────────────────────────────────────────────────────

static class Log
{
    public static void Info(string msg) =>
        Console.Error.WriteLine($"[island-host] {msg}");
}

// ── CLI config ─────────────────────────────────────────────────────────────

class Config
{
    public int Width = 640;
    public int Height = 420;
    public string Title = "Island";
    public bool Frameless;
    public bool Floating;
    public bool Transparent;
    public int? X;
    public int? Y;
    public bool ClickThrough;
    public bool NoDock;
    public bool Hidden;

    public static Config Parse(string[] args)
    {
        var c = new Config();
        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--width":
                    if (++i < args.Length && int.TryParse(args[i], out var w)) c.Width = w;
                    break;
                case "--height":
                    if (++i < args.Length && int.TryParse(args[i], out var h)) c.Height = h;
                    break;
                case "--title":
                    if (++i < args.Length) c.Title = args[i];
                    break;
                case "--x":
                    if (++i < args.Length && int.TryParse(args[i], out var x)) c.X = x;
                    break;
                case "--y":
                    if (++i < args.Length && int.TryParse(args[i], out var y)) c.Y = y;
                    break;
                case "--frameless":    c.Frameless = true; break;
                case "--floating":     c.Floating = true; break;
                case "--transparent":  c.Transparent = true; break;
                case "--click-through": c.ClickThrough = true; break;
                case "--no-dock":      c.NoDock = true; break;
                case "--hidden":       c.Hidden = true; break;
            }
        }
        return c;
    }
}

// ── Main window ────────────────────────────────────────────────────────────

class IslandWindow : Window
{
    // ── Win32 interop ──────────────────────────────────────────────────────

    const int GWL_EXSTYLE = -20;
    const int WS_EX_TRANSPARENT  = 0x00000020;
    const int WS_EX_LAYERED      = 0x00080000;
    const int WS_EX_TOOLWINDOW   = 0x00000080;
    const int WS_EX_NOACTIVATE   = 0x08000000;

    static readonly IntPtr HWND_TOPMOST = new(-1);
    const uint SWP_NOSIZE     = 0x0001;
    const uint SWP_NOMOVE     = 0x0002;
    const uint SWP_NOACTIVATE = 0x0010;

    [DllImport("user32.dll")]
    static extern int GetWindowLong(IntPtr hwnd, int nIndex);

    [DllImport("user32.dll")]
    static extern int SetWindowLong(IntPtr hwnd, int nIndex, int dwNewLong);

    [DllImport("user32.dll")]
    static extern bool SetWindowPos(
        IntPtr hwnd, IntPtr hwndInsertAfter,
        int x, int y, int cx, int cy, uint uFlags);

    // ── Bridge JS ──────────────────────────────────────────────────────────
    // Same API surface as the Swift host's window.islandHost, but uses
    // WebView2's chrome.webview.postMessage instead of webkit messageHandlers.

    const string BridgeJs = """
        window.islandHost = {
            cursorTip: null,
            send: function(data) {
                window.chrome.webview.postMessage(JSON.stringify(data));
            },
            close: function() {
                window.chrome.webview.postMessage(JSON.stringify({__islandHost_close: true}));
            }
        };
        """;

    // ── Instance state ─────────────────────────────────────────────────────

    private readonly Config _config;
    private WebView2? _webView;

    // ── Constructor ────────────────────────────────────────────────────────

    public IslandWindow(Config config)
    {
        _config = config;
        Title = config.Title;
        ResizeMode = ResizeMode.NoResize;

        // Frameless
        if (config.Frameless)
            WindowStyle = WindowStyle.None;

        // Transparent background (must be set before window shows)
        if (config.Transparent)
        {
            AllowsTransparency = true;
            Background = Brushes.Transparent;
        }

        // Always on top
        Topmost = config.Floating;

        // No taskbar icon (Win32 WS_EX_TOOLWINDOW added in OnSourceInitialized
        // for full Alt+Tab removal; this covers the taskbar button)
        ShowInTaskbar = !config.NoDock;

        // Window size — set in DIPs here; position is set via Win32 in
        // OnSourceInitialized to avoid DPI mismatch (companion sends
        // physical pixel coordinates).
        Width = config.Width;
        Height = config.Height;

        // If no explicit position, center on screen.
        if (!config.X.HasValue || !config.Y.HasValue)
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
        else
            WindowStartupLocation = WindowStartupLocation.Manual;

        if (config.Hidden)
            Visibility = Visibility.Hidden;

        Loaded += OnLoaded;
        Closed += OnClosed;
    }

    // ── Win32 extended styles ──────────────────────────────────────────────

    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);

        var hwnd = new WindowInteropHelper(this).Handle;
        var exStyle = GetWindowLong(hwnd, GWL_EXSTYLE);

        // Click-through: mouse events pass to windows below
        if (_config.ClickThrough)
            exStyle |= WS_EX_TRANSPARENT | WS_EX_LAYERED;

        // Tool window: no taskbar entry, no Alt+Tab
        if (_config.NoDock)
            exStyle |= WS_EX_TOOLWINDOW;

        // Don't steal focus on show
        exStyle |= WS_EX_NOACTIVATE;

        SetWindowLong(hwnd, GWL_EXSTYLE, exStyle);

        // Place window using physical pixel coordinates from companion.
        // SetWindowPos works in physical pixels, bypassing WPF DPI scaling.
        if (_config.X.HasValue && _config.Y.HasValue)
        {
            SetWindowPos(hwnd, IntPtr.Zero,
                _config.X.Value, _config.Y.Value,
                _config.Width, _config.Height,
                SWP_NOACTIVATE);
        }

        // Ensure topmost at Win32 level (belt-and-braces with WPF Topmost)
        if (_config.Floating)
        {
            SetWindowPos(hwnd, HWND_TOPMOST,
                0, 0, 0, 0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
    }

    // ── WebView2 setup ─────────────────────────────────────────────────────

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        _webView = new WebView2();

        // Transparent background — must be set BEFORE EnsureCoreWebView2Async.
        _webView.DefaultBackgroundColor = System.Drawing.Color.Transparent;
        Content = _webView;

        try
        {
            // Dedicated user-data folder so pi-island doesn't collide with
            // other WebView2 apps on the same machine.
            var userDataFolder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "pi-island", "webview2");
            var env = await CoreWebView2Environment.CreateAsync(null, userDataFolder);
            await _webView.EnsureCoreWebView2Async(env);
        }
        catch (Exception ex)
        {
            Log.Info($"WebView2 init failed: {ex.Message}");
            Log.Info("Install WebView2 Runtime: https://developer.microsoft.com/en-us/microsoft-edge/webview2/");
            Stdout.Write(new JsonObject { ["type"] = "closed" });
            Environment.Exit(1);
            return;
        }

        // Inject bridge on every page load (same as Swift host's WKUserScript)
        await _webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(BridgeJs);

        // Suppress DevTools, context menu, etc. for a clean capsule look.
        _webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
        _webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
        _webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
        _webView.CoreWebView2.Settings.IsZoomControlEnabled = false;

        // Handle messages from the WebView (window.islandHost.send / .close)
        _webView.CoreWebView2.WebMessageReceived += OnWebMessage;

        // Emit "ready" after every navigation — companion uses the first one
        // to send the island HTML, the second one to start pushing JS evals.
        _webView.CoreWebView2.NavigationCompleted += (_, _) => EmitReady();

        // Load blank page to trigger first "ready"
        _webView.CoreWebView2.NavigateToString("<html><body></body></html>");

        // Start reading commands from stdin
        StartStdinReader();
    }

    // ── WebView message handler ────────────────────────────────────────────

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        try
        {
            var raw = args.TryGetWebMessageAsString();
            if (raw == null) return;

            var msg = JsonNode.Parse(raw);
            if (msg == null) return;

            if (msg["__islandHost_close"]?.GetValue<bool>() == true)
            {
                CloseAndExit();
                return;
            }

            var output = new JsonObject { ["type"] = "message" };
            output["data"] = JsonNode.Parse(raw);
            Stdout.Write(output);
        }
        catch { /* ignore malformed messages */ }
    }

    // ── Stdin reader (background thread) ───────────────────────────────────

    private void StartStdinReader()
    {
        var thread = new Thread(() =>
        {
            try
            {
                string? line;
                while ((line = Console.ReadLine()) != null)
                {
                    var trimmed = line.Trim();
                    if (string.IsNullOrEmpty(trimmed)) continue;

                    try
                    {
                        var json = JsonNode.Parse(trimmed);
                        var type = json?["type"]?.GetValue<string>();
                        if (type == null) continue;

                        // Dispatch to UI thread
                        Dispatcher.Invoke(() => HandleCommand(type, json!));
                    }
                    catch (Exception ex)
                    {
                        Log.Info($"Bad JSON: {trimmed} ({ex.Message})");
                    }
                }
            }
            catch { /* stdin closed or broken pipe */ }

            // stdin EOF — companion died or closed the pipe
            Dispatcher.Invoke(CloseAndExit);
        })
        {
            IsBackground = true,
            Name = "StdinReader"
        };
        thread.Start();
    }

    // ── Command dispatch ───────────────────────────────────────────────────

    private void HandleCommand(string type, JsonNode json)
    {
        switch (type)
        {
            case "html":
            {
                var base64 = json["html"]?.GetValue<string>();
                if (base64 == null) { Log.Info("html: missing payload"); return; }
                try
                {
                    var htmlBytes = Convert.FromBase64String(base64);
                    var html = Encoding.UTF8.GetString(htmlBytes);
                    _webView?.CoreWebView2?.NavigateToString(html);
                }
                catch (Exception ex) { Log.Info($"html: {ex.Message}"); }
                break;
            }

            case "eval":
            {
                var js = json["js"]?.GetValue<string>();
                if (js == null) { Log.Info("eval: missing js"); return; }
                _ = _webView?.CoreWebView2?.ExecuteScriptAsync(js);
                break;
            }

            case "close":
                CloseAndExit();
                break;

            default:
                Log.Info($"Unknown command: {type}");
                break;
        }
    }

    // ── Ready message ──────────────────────────────────────────────────────

    private void EmitReady()
    {
        var ready = new JsonObject { ["type"] = "ready" };
        // Basic screen info — companion uses platform.mjs for geometry;
        // this is here for protocol parity with the Swift host.
        try
        {
            var area = SystemParameters.WorkArea;
            ready["screen"] = new JsonObject
            {
                ["width"]  = (int)SystemParameters.PrimaryScreenWidth,
                ["height"] = (int)SystemParameters.PrimaryScreenHeight,
                ["visibleWidth"]  = (int)area.Width,
                ["visibleHeight"] = (int)area.Height,
            };
        }
        catch { /* best-effort */ }
        Stdout.Write(ready);
    }

    // ── Cleanup ────────────────────────────────────────────────────────────

    private void OnClosed(object? sender, EventArgs e)
    {
        Stdout.Write(new JsonObject { ["type"] = "closed" });
        Environment.Exit(0);
    }

    private void CloseAndExit()
    {
        Stdout.Write(new JsonObject { ["type"] = "closed" });
        Environment.Exit(0);
    }
}

// ── Entry point ────────────────────────────────────────────────────────────

class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        var config = Config.Parse(args);
        var app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
        var window = new IslandWindow(config);

        if (!config.Hidden)
            window.Show();

        app.Run(window);
    }
}
