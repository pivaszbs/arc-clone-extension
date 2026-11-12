using System.Text.Json;
using Tizen.Multimedia;
using Tizen.NUI;
using Tizen.NUI.BaseComponents;
using Path = System.IO.Path;
using Size = Tizen.NUI.Size;

namespace AnimeStudy;

sealed class TvApp : NUIApplication
{
    private static readonly Color Background = new("#101012");
    private static readonly Color Accent = new("#ff9669");
    private Window window = null!;
    private TextLabel title = null!;
    private TextLabel status = null!;
    private TextLabel help = null!;
    private TextLabel caption = null!;
    private TextField addressInput = null!;
    private View backdrop = null!;
    private View browser = null!;
    private readonly List<TextLabel> rows = new();
    private Tizen.NUI.Timer timer = null!;
    private Uri? address;
    private Catalog? catalog;
    private Series? series;
    private Player? player;
    private Episode? playing;
    private int episodeIndex;
    private int selected;
    private bool busy;
    private bool seeking;
    private bool connecting;
    private string addressFile = "";
    private string progressFile = "";
    private Dictionary<string, Progress> progress = new();
    private List<Cue> cues = new();
    private Cue? currentCue;
    private Cue? captured;
    private double replayUntil;
    private int studyFrequency;
    private double lastTime;
    private double lastSavedAt;
    private double duration;
    private string? activeSkip;
    private double countdown;
    private readonly HashSet<string> dismissed = new();
    private DateTime controlsUntil;
    private static readonly string[] SkipParts = { "recap", "op", "ed" };
    private static readonly string[] Frequencies = { "Off", "Occasionally", "Often", "Every phrase" };
    private static readonly double[] Chances = { 0, .15, .4, 1 };

    private TvApp() : base("", WindowMode.Transparent) {}

    public static void Main(string[] args) => new TvApp().Run(args);

    protected override void OnCreate()
    {
        base.OnCreate();
        window = GetDefaultWindow();
        window.BackgroundColor = Color.Transparent;
        var data = Tizen.Applications.Application.Current.DirectoryInfo.Data;
        addressFile = Path.Combine(data, "address");
        progressFile = Path.Combine(data, "progress.json");
        try { progress = JsonSerializer.Deserialize<Dictionary<string, Progress>>(File.ReadAllText(progressFile)) ?? new(); }
        catch (IOException) {} catch (JsonException) {}

        var width = window.Size.Width;
        var height = window.Size.Height;
        var margin = width * .05f;
        var content = width - 2 * margin;
        var line = height * .069f;
        backdrop = new View { Size = new Size(width, height), BackgroundColor = Background };
        window.Add(backdrop);
        browser = new View { Size = new Size(width, height) };
        window.Add(browser);
        title = Label(browser, margin, height * .07f, content, line, 33);
        status = Label(window, margin, height * .15f, content, line, 24);
        help = Label(window, margin, height * .91f, content, line, 20);
        caption = Label(window, margin, height * .72f, content, height * .15f, 31);
        caption.HorizontalAlignment = HorizontalAlignment.Center;
        caption.MultiLine = true;
        caption.BackgroundColor = new Color(.06f, .06f, .07f, .8f);
        caption.Hide();
        addressInput = new TextField {
            Position = new Position(margin, height * .25f),
            Size = new Size(content, line),
            BackgroundColor = new Color("#24242a"),
            TextColor = Color.White,
            PointSize = 23,
            PlaceholderText = "http://192.168.1.10:46158/…"
        };
        browser.Add(addressInput);
        for (var i = 0; i < 7; i++)
            rows.Add(Label(browser, margin, height * .25f + i * line, content, line, 23));
        window.KeyEvent += (_, args) => {
            if (args.Key.State == Key.StateType.Down) _ = HandleKey(args.Key.KeyPressedName);
        };
        timer = new Tizen.NUI.Timer(200);
        timer.Tick += (_, _) => { TickPlayback(); return true; };
        timer.Start();
        try { addressInput.Text = File.ReadAllText(addressFile); } catch (IOException) {}
        ShowAddress();
        if (!string.IsNullOrWhiteSpace(addressInput.Text)) _ = Connect();
    }

    private static TextLabel Label(object parent, float x, float y, float width, float height, float size)
    {
        var label = new TextLabel {
            Position = new Position(x, y), Size = new Size(width, height), PointSize = size,
            TextColor = Color.White, VerticalAlignment = VerticalAlignment.Center
        };
        if (parent is View view) view.Add(label);
        else ((Window)parent).Add(label);
        return label;
    }

    private void ShowAddress()
    {
        connecting = true;
        title.Text = "Anime Study";
        status.Text = "Enter the address printed by npm run tv:serve on your Mac.";
        help.Text = "OK  Connect     Back  Return to library";
        addressInput.Show();
        FocusManager.Instance.SetCurrentFocusView(addressInput);
        foreach (var row in rows) row.Hide();
    }

    private async Task Connect()
    {
        if (busy) return;
        busy = true;
        status.Text = "Connecting to your Mac…";
        try
        {
            var nextAddress = Library.Address(addressInput.Text);
            var nextCatalog = await Library.Read(nextAddress);
            address = nextAddress;
            catalog = nextCatalog;
            try { File.WriteAllText(addressFile, nextAddress.ToString()); } catch (IOException) {}
            series = null;
            selected = 0;
            RenderLibrary();
        }
        catch (FormatException) { status.Text = "Enter the full local address printed on your Mac."; }
        catch (Exception) { status.Text = "Could not connect. Check the address and that the Mac companion is running."; }
        finally { busy = false; }
    }

    private void RenderLibrary()
    {
        connecting = false;
        FocusManager.Instance.ClearFocus();
        addressInput.Hide();
        title.Text = series?.Title ?? "Anime Study";
        var names = series?.Episodes.Select(EpisodeLabel).ToArray() ?? catalog!.Series.Select(item => item.Title).ToArray();
        status.Text = series is null ? $"{names.Length} series" : $"{names.Length} episodes";
        help.Text = series is null ? "↑ ↓  Browse     OK  Open     Back  Change address" : "↑ ↓  Browse     OK  Play     Back  Series";
        var first = selected / rows.Count * rows.Count;
        for (var i = 0; i < rows.Count; i++)
        {
            var number = first + i;
            if (number >= names.Length) { rows[i].Hide(); continue; }
            rows[i].Text = names[number];
            rows[i].TextColor = number == selected ? Accent : Color.White;
            rows[i].Show();
        }
    }

    private string EpisodeLabel(Episode episode)
    {
        var saved = WatchPosition(episode);
        var suffix = saved.Finished ? "   Watched" : saved.Position > 0 ? $"   Resume at {Clock(saved.Position)}" : "";
        return Path.GetFileNameWithoutExtension(episode.Name) + suffix;
    }

    private string ProgressKey(Episode episode) => series!.Id + "/" + episode.Name;
    private Progress WatchPosition(Episode episode) =>
        progress.GetValueOrDefault(ProgressKey(episode)) ?? episode.Saved?.Progress ?? new Progress(0, false);

    private void SaveProgress(bool finished = false)
    {
        if (player is null || playing is null || player.State is not (PlayerState.Playing or PlayerState.Paused or PlayerState.Ready)) return;
        progress[ProgressKey(playing)] = new Progress(finished ? 0 : player.GetPlayPosition() / 1000d, finished);
        try { File.WriteAllText(progressFile, JsonSerializer.Serialize(progress)); } catch (IOException) {}
    }

    private async Task OpenEpisode(int index)
    {
        if (busy || series is null || address is null || index < 0 || index >= series.Episodes.Length) return;
        busy = true;
        ClosePlayer();
        episodeIndex = selected = index;
        playing = series.Episodes[index];
        browser.Hide();
        backdrop.Hide();
        status.Text = "Loading episode…";
        help.Text = "";
        cues = new();
        currentCue = captured = null;
        replayUntil = countdown = lastTime = lastSavedAt = 0;
        activeSkip = null;
        dismissed.Clear();
        try
        {
            if (playing.Subtitles is { } subtitle)
            {
                try { cues = Library.Captions(await Library.Client.GetStringAsync(Library.Asset(address, subtitle, "subtitles"))); }
                catch (HttpRequestException) {} catch (TaskCanceledException) {}
            }
            var source = Library.Asset(address, playing.Video, "video");
            var nextPlayer = new Player { Display = new Display(window) };
            player = nextPlayer;
            nextPlayer.SetSource(new MediaUriSource(source.AbsoluteUri));
            nextPlayer.PlaybackCompleted += (_, _) => {
                if (player != nextPlayer) return;
                SaveProgress(true);
                if (episodeIndex + 1 < series.Episodes.Length) _ = OpenEpisode(episodeIndex + 1);
                else LeavePlayer();
            };
            nextPlayer.ErrorOccurred += (_, _) => {
                if (player == nextPlayer) status.Text = "Playback failed. Check the Mac companion and video format.";
            };
            using var preparation = new CancellationTokenSource(TimeSpan.FromSeconds(12));
            await nextPlayer.PrepareAsync(preparation.Token);
            duration = nextPlayer.StreamInfo.GetDuration() / 1000d;
            var saved = WatchPosition(playing);
            if (!saved.Finished && saved.Position > 0 && saved.Position < duration - 1)
                await nextPlayer.SetPlayPositionAsync((int)(saved.Position * 1000), true);
            nextPlayer.Start();
            ShowControls();
        }
        catch (Exception)
        {
            LeavePlayer();
            status.Text = "Could not play this episode. Check the Mac companion and video format.";
        }
        finally { busy = false; }
    }

    private void ClosePlayer()
    {
        player?.Dispose();
        player = null;
        playing = null;
        caption.Hide();
    }

    private void LeavePlayer()
    {
        ClosePlayer();
        browser.Show();
        backdrop.Show();
        RenderLibrary();
    }

    private void ShowControls() => controlsUntil = DateTime.UtcNow.AddSeconds(8);

    private static string Clock(double seconds) => TimeSpan.FromSeconds(Math.Max(0, seconds)).ToString(@"m\:ss");

    private void TickPlayback()
    {
        if (busy || seeking || player is null || playing is null ||
            player.State is not (PlayerState.Playing or PlayerState.Paused)) return;
        var now = player.GetPlayPosition() / 1000d;
        var advancing = player.State == PlayerState.Playing;
        var delta = now - lastTime;
        var previousCue = currentCue;
        currentCue = cues.LastOrDefault(cue => cue.Start <= now && now < cue.End);
        if (replayUntil > 0 && now >= replayUntil)
        {
            replayUntil = 0;
            player.Pause();
            advancing = false;
        }
        if (captured is null && advancing && delta is > 0 and < 1.5 &&
            previousCue is not null && previousCue.End > lastTime && previousCue.End <= now &&
            Random.Shared.NextDouble() < Chances[studyFrequency])
        {
            captured = previousCue;
            player.Pause();
            advancing = false;
        }
        var visibleCue = replayUntil > 0 ? currentCue : captured ?? currentCue;
        if (visibleCue is null) caption.Hide();
        else { caption.Text = visibleCue.Text; caption.Show(); }

        var ranges = playing.Saved?.Themes;
        var nextSkip = captured is null && ranges is not null ? SkipParts.FirstOrDefault(part =>
            ranges.TryGetValue(part, out var range) && range.Start <= now && now < range.End &&
            range.End <= duration + .5 && !dismissed.Contains(part)) : null;
        if (activeSkip != nextSkip) countdown = 0;
        activeSkip = nextSkip;
        var auto = activeSkip is not null && series?.AutoSkip?.GetValueOrDefault(activeSkip, true) != false;
        if (auto && advancing && delta is > 0 and < 1.5) countdown += delta;
        else if (activeSkip is null) countdown = 0;
        if (auto && countdown >= 5) _ = Skip(true);
        lastTime = now;
        if (advancing && Math.Abs(now - lastSavedAt) >= 5) { SaveProgress(); lastSavedAt = now; }

        var controls = DateTime.UtcNow <= controlsUntil || !advancing;
        status.Text = activeSkip is not null
            ? $"{SkipLabel(activeSkip)} · Up to skip · Down to keep watching" + (auto ? $" · {Math.Max(1, Math.Ceiling(5 - countdown))} s" : "")
            : controls ? $"{Path.GetFileNameWithoutExtension(playing.Name)} · {Clock(now)}" : "";
        help.Text = captured is not null
            ? "↑  Replay line     OK  Continue"
            : controls ? $"OK  Play / pause     ← →  Seek     ↑  Study line     ↓  Study pause: {Frequencies[studyFrequency]}     Back  Episodes" : "";
    }

    private static string SkipLabel(string part) => part == "op" ? "Skip opening" : part == "ed" ? "Skip ending" : "Skip recap";

    private async Task Seek(double seconds)
    {
        if (player is null || seeking) return;
        seeking = true;
        try { await player.SetPlayPositionAsync((int)(Math.Clamp(seconds, 0, duration) * 1000), true); }
        catch (Exception) { status.Text = "Could not seek to that position."; }
        finally { seeking = false; countdown = 0; }
    }

    private async Task Skip(bool automatic)
    {
        var part = activeSkip;
        var ranges = playing?.Saved?.Themes;
        if (part is null || ranges is null || !ranges.TryGetValue(part, out var range)) return;
        dismissed.Add(part);
        activeSkip = null;
        countdown = 0;
        if (automatic && part == "ed" && series is not null && episodeIndex + 1 < series.Episodes.Length &&
            (series.EndingAction == "next" || (series.EndingAction is null or "auto") && duration - range.End <= 20))
        {
            SaveProgress(true);
            await OpenEpisode(episodeIndex + 1);
        }
        else await Seek(range.End);
    }

    private async Task HandleKey(string key)
    {
        if (busy) return;
        var back = key is "Escape" or "Back" or "XF86Back";
        var enter = key is "Return" or "Enter" or "KP_Enter";
        if (player is not null)
        {
            ShowControls();
            if (back) { SaveProgress(); LeavePlayer(); }
            else if (captured is not null && enter)
            {
                captured = null;
                replayUntil = 0;
                if (player.State == PlayerState.Paused) player.Start();
            }
            else if (captured is not null && key == "Up")
            {
                replayUntil = captured.End;
                await Seek(captured.Start);
                if (player?.State == PlayerState.Paused) player.Start();
            }
            else if (enter || key is "XF86AudioPlay" or "XF86AudioPause")
            {
                if (player.State == PlayerState.Playing) player.Pause();
                else if (player.State == PlayerState.Paused) player.Start();
            }
            else if (key == "Up")
            {
                if (activeSkip is not null) await Skip(false);
                else if (currentCue is not null)
                {
                    captured = currentCue;
                    if (player.State == PlayerState.Playing) player.Pause();
                }
            }
            else if (key == "Down")
            {
                if (activeSkip is { } skip) dismissed.Add(skip);
                else studyFrequency = (studyFrequency + 1) % Frequencies.Length;
            }
            else if (key is "Left" or "Right")
                await Seek(player.GetPlayPosition() / 1000d + (key == "Left" ? -10 : 10));
            return;
        }
        if (connecting)
        {
            if (enter) await Connect();
            else if (back && catalog is not null) RenderLibrary();
            return;
        }
        if (back)
        {
            if (series is null) ShowAddress();
            else { series = null; selected = 0; RenderLibrary(); }
        }
        else if (key is "Up" or "Down")
        {
            var count = series?.Episodes.Length ?? catalog!.Series.Length;
            selected = Math.Clamp(selected + (key == "Up" ? -1 : 1), 0, count - 1);
            RenderLibrary();
        }
        else if (enter)
        {
            if (series is null) { series = catalog!.Series[selected]; selected = 0; RenderLibrary(); }
            else await OpenEpisode(selected);
        }
    }

    protected override void OnTerminate()
    {
        SaveProgress();
        ClosePlayer();
        timer?.Dispose();
        base.OnTerminate();
    }
}
