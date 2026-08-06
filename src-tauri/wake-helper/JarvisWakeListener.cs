using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Speech.Recognition;
using System.Text;
using System.Threading;

internal static class JarvisWakeListener
{
    private static readonly string[] WakePhrases =
    {
        "hey jarvis",
        "hi jarvis",
        "jarvis",
        "嗨 jarvis",
        "嘿 jarvis",
        "嗨 贾维斯",
        "嘿 贾维斯",
        "贾维斯",
    };

    private static readonly ManualResetEvent Finished = new ManualResetEvent(false);
    private static readonly object OutputLock = new object();
    private static StreamWriter eventWriter;
    private static int woke;

    public static int Main(string[] args)
    {
        string eventFile = Argument(args, "--event-file");
        string controlFile = Argument(args, "--control-file");
        bool testWake = args.Any(value => value == "--test-wake");
        bool testRelease = args.Any(value => value == "--test-release");
        try
        {
            if (!string.IsNullOrWhiteSpace(eventFile))
            {
                eventWriter = new StreamWriter(eventFile, true, new UTF8Encoding(false));
                eventWriter.AutoFlush = true;
            }
            Emit("authorization", "status", "authorized");
            if (testWake)
            {
                Emit("ready");
                Emit("wake", "phrase", "test");
                return 0;
            }
            if (testRelease)
            {
                Emit("ready", "culture", "test");
                WaitForRelease(controlFile);
                Emit("stopping", "reason", "release");
                Emit("microphoneReleased", "reason", "release");
                return 6;
            }

            RecognizerInfo recognizerInfo = SelectRecognizer();
            if (recognizerInfo == null)
            {
                Emit("error", "message", "No installed Windows speech recognizer was found. Install a Windows speech language pack.");
                return 3;
            }

            bool releaseRequested = false;
            using (var recognizer = new SpeechRecognitionEngine(recognizerInfo.Id))
            {
                LoadWakeGrammar(recognizer, recognizerInfo.Culture);
                recognizer.SpeechRecognized += OnSpeechRecognized;
                recognizer.RecognizeCompleted += delegate { Finished.Set(); };
                Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs eventArgs)
                {
                    eventArgs.Cancel = true;
                    Finished.Set();
                };
                recognizer.SetInputToDefaultAudioDevice();
                Emit("ready", "culture", recognizerInfo.Culture.Name);
                recognizer.RecognizeAsync(RecognizeMode.Multiple);
                while (!Finished.WaitOne(120))
                {
                    if (ReleaseRequested(controlFile))
                    {
                        releaseRequested = true;
                        Emit("stopping", "reason", "release");
                        recognizer.RecognizeAsyncCancel();
                        break;
                    }
                }
                recognizer.RecognizeAsyncCancel();
            }
            // 释放确认只能在识别器（音频设备）真正释放之后发出。
            Emit(
                "microphoneReleased",
                "reason",
                Volatile.Read(ref woke) == 1 ? "wake" : (releaseRequested ? "release" : "stop"));
            return Volatile.Read(ref woke) == 1 ? 0 : (releaseRequested ? 6 : 2);
        }
        catch (UnauthorizedAccessException)
        {
            Emit("authorization", "status", "denied");
            Emit("error", "message", "Windows denied microphone access. Enable desktop microphone access in Privacy & security settings.");
            return 4;
        }
        catch (Exception error)
        {
            Emit("error", "message", error.Message);
            return 5;
        }
        finally
        {
            if (eventWriter != null) eventWriter.Dispose();
        }
    }

    private static void WaitForRelease(string controlFile)
    {
        while (!ReleaseRequested(controlFile)) Thread.Sleep(50);
    }

    private static bool ReleaseRequested(string controlFile)
    {
        if (string.IsNullOrWhiteSpace(controlFile)) return false;
        try
        {
            return File.Exists(controlFile)
                && File.ReadAllText(controlFile).Trim().Equals("release", StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    private static void LoadWakeGrammar(SpeechRecognitionEngine recognizer, CultureInfo culture)
    {
        var choices = new Choices(WakePhrases);
        var builder = new GrammarBuilder(choices) { Culture = culture };
        recognizer.LoadGrammar(new Grammar(builder) { Name = "Jarvis wake phrases" });
    }

    private static RecognizerInfo SelectRecognizer()
    {
        List<RecognizerInfo> installed = SpeechRecognitionEngine.InstalledRecognizers().ToList();
        string requested = Environment.GetEnvironmentVariable("JARVIS_WAKE_CULTURE");
        if (!string.IsNullOrWhiteSpace(requested))
        {
            RecognizerInfo exact = installed.FirstOrDefault(
                item => string.Equals(item.Culture.Name, requested, StringComparison.OrdinalIgnoreCase));
            if (exact != null) return exact;
        }
        string current = CultureInfo.CurrentUICulture.Name;
        return installed.FirstOrDefault(item => string.Equals(item.Culture.Name, current, StringComparison.OrdinalIgnoreCase))
            ?? installed.FirstOrDefault(item => item.Culture.Name.StartsWith("zh", StringComparison.OrdinalIgnoreCase))
            ?? installed.FirstOrDefault(item => item.Culture.Name.StartsWith("en", StringComparison.OrdinalIgnoreCase))
            ?? installed.FirstOrDefault();
    }

    private static void OnSpeechRecognized(object sender, SpeechRecognizedEventArgs eventArgs)
    {
        if (eventArgs.Result == null || eventArgs.Result.Confidence < 0.45f) return;
        string spoken = Normalize(eventArgs.Result.Text);
        if (!WakePhrases.Select(Normalize).Any(phrase => spoken.Contains(phrase))) return;
        if (Interlocked.Exchange(ref woke, 1) != 0) return;
        Emit("wake", "phrase", eventArgs.Result.Text);
        Finished.Set();
    }

    private static string Normalize(string value)
    {
        return (value ?? string.Empty)
            .ToLowerInvariant()
            .Replace(" ", string.Empty)
            .Replace(",", string.Empty)
            .Replace("，", string.Empty)
            .Replace(".", string.Empty)
            .Replace("。", string.Empty)
            .Replace("!", string.Empty)
            .Replace("！", string.Empty);
    }

    private static string Argument(string[] args, string name)
    {
        for (int index = 0; index + 1 < args.Length; index++)
        {
            if (args[index] == name) return args[index + 1];
        }
        return null;
    }

    private static void Emit(string type, string key = null, string value = null)
    {
        var fields = new Dictionary<string, string> { { "type", type } };
        if (key != null) fields[key] = value ?? string.Empty;
        string json = "{" + string.Join(",", fields.Select(field =>
            "\"" + Escape(field.Key) + "\":\"" + Escape(field.Value) + "\"")) + "}";
        lock (OutputLock)
        {
            if (eventWriter != null) eventWriter.WriteLine(json);
            else Console.WriteLine(json);
        }
    }

    private static string Escape(string value)
    {
        return (value ?? string.Empty)
            .Replace("\\", "\\\\")
            .Replace("\"", "\\\"")
            .Replace("\r", "\\r")
            .Replace("\n", "\\n");
    }
}
