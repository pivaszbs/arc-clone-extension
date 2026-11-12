using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Text.RegularExpressions;

namespace AnimeStudy;

record Catalog(int Version, Series[] Series);
record Series(string Id, string Title, Episode[] Episodes, Dictionary<string, bool>? AutoSkip, string? EndingAction);
record Episode(string Name, string Video, string? Subtitles, Saved? Saved);
record Saved(Dictionary<string, Range>? Themes, Progress? Progress);
record Range(double Start, double End);
record Progress(double Position, bool Finished);
record Cue(double Start, double End, string Text);

static class Library
{
    internal static readonly HttpClient Client = new(new HttpClientHandler { AllowAutoRedirect = false })
        { Timeout = TimeSpan.FromSeconds(8), MaxResponseContentBufferSize = 5_000_000 };

    internal static Uri Address(string input)
    {
        if (!Uri.TryCreate(input.Trim().TrimEnd('/') + "/", UriKind.Absolute, out var uri) ||
            uri.Scheme != Uri.UriSchemeHttp || uri.UserInfo.Length != 0 || uri.Query.Length != 0 ||
            uri.Fragment.Length != 0 || !Regex.IsMatch(uri.AbsolutePath, "^/[a-f0-9]{16}/$") ||
            !IPAddress.TryParse(uri.Host, out var ip) || ip.AddressFamily != AddressFamily.InterNetwork)
            throw new FormatException();
        var octets = ip.GetAddressBytes();
        if (octets[0] != 10 && !(octets[0] == 172 && octets[1] is >= 16 and <= 31) &&
            !(octets[0] == 192 && octets[1] == 168) && !IPAddress.IsLoopback(ip))
            throw new FormatException();
        return uri;
    }

    internal static Uri Asset(Uri address, string path, string kind)
    {
        if (!Regex.IsMatch(path, $@"^(?:\d+/)?\d+/{kind}$")) throw new FormatException();
        return new Uri(address, path);
    }

    internal static async Task<Catalog> Read(Uri address)
    {
        var catalog = await Client.GetFromJsonAsync<Catalog>(new Uri(address, "catalog.json"));
        if (catalog?.Version != 1 || catalog.Series is not { Length: > 0 }) throw new FormatException();
        return catalog;
    }

    internal static List<Cue> Captions(string body)
    {
        var cues = new List<Cue>();
        foreach (Match match in Regex.Matches(body.Replace("\r\n", "\n"),
                     @"(?m)^\s*((?:\d+:)?\d{2}:\d{2}[.,]\d+)\s+-->\s+((?:\d+:)?\d{2}:\d{2}[.,]\d+)[^\n]*\n([\s\S]*?)(?=\n\s*\n|\z)"))
            AddCue(cues, match.Groups[1].Value, match.Groups[2].Value, match.Groups[3].Value);

        var fields = Array.Empty<string>();
        foreach (var line in body.Split('\n'))
        {
            if (line.StartsWith("Format:", StringComparison.OrdinalIgnoreCase))
                fields = line[7..].Split(',').Select(field => field.Trim().ToLowerInvariant()).ToArray();
            if (!line.StartsWith("Dialogue:", StringComparison.OrdinalIgnoreCase) || fields.Length == 0) continue;
            var values = line[9..].Split(',', fields.Length);
            var start = Array.IndexOf(fields, "start");
            var end = Array.IndexOf(fields, "end");
            var text = Array.IndexOf(fields, "text");
            var style = Array.IndexOf(fields, "style");
            if (values.Length != fields.Length || start < 0 || end < 0 || text < 0 ||
                style >= 0 && Regex.IsMatch(values[style], "furi|ruby", RegexOptions.IgnoreCase)) continue;
            AddCue(cues, values[start], values[end], values[text].Replace("\\N", "\n").Replace("\\n", "\n").Replace("\\h", " "));
        }
        return cues.OrderBy(cue => cue.Start).ToList();
    }

    private static void AddCue(List<Cue> cues, string start, string end, string text)
    {
        if (!Time(start, out var from) || !Time(end, out var to) || to <= from) return;
        var caption = WebUtility.HtmlDecode(Regex.Replace(text, @"\{[^}]*\}|<[^>]*>", "")).Trim();
        if (Regex.IsMatch(caption, @"[\u3040-\u30ff\u3400-\u9fff]")) cues.Add(new Cue(from, to, caption));
    }

    private static bool Time(string value, out double seconds)
    {
        var parts = value.Trim().Replace(',', '.').Split(':');
        seconds = 0;
        foreach (var part in parts)
        {
            if (!double.TryParse(part, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out var number))
                return false;
            seconds = seconds * 60 + number;
        }
        return parts.Length is 2 or 3;
    }
}
