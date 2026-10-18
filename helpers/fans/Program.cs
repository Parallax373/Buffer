// buffer-fans: reads sensors and sets fan controls through LibreHardwareMonitorLib (MPL-2.0, unmodified).
// Protocol: line-delimited JSON over a named pipe that only the interactive user may open.
//   {"cmd":"hello"} {"cmd":"list"} {"cmd":"read"} {"cmd":"set","items":[["<id>",42.0],...]}
//   {"cmd":"release","ids":["<id>"]} {"cmd":"failsafe","pct":100,"grace":10} {"cmd":"quit"}
// Safety: every control Buffer sets is remembered. If no command arrives for `grace` seconds (the recorder died) they all
// go to the fail-safe speed. `quit` and a normal process exit hand them back with SetDefault(). A hard kill cannot do that,
// which is why Buffer always asks for `quit` first. Keys are LibreHardwareMonitor identifiers, never list positions.
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json.Nodes;
using LibreHardwareMonitor.Hardware;

namespace BufferFans;

static class Program
{
    static readonly object Gate = new();
    static Computer? Pc;
    static readonly Dictionary<string, ISensor> Controls = new();
    static readonly Dictionary<string, ISensor> All = new();
    static readonly HashSet<string> Taken = new();
    static DateTime LastCmd = DateTime.UtcNow;
    static float FailPct = 100;
    static double Grace = 10;
    static bool Failed;
    static volatile bool Quit;

    static int Main(string[] args)
    {
        string pipe = "buffer-fans", sid = "";
        for (int i = 0; i + 1 < args.Length; i += 2)
        {
            if (args[i] == "--pipe") pipe = args[i + 1];
            if (args[i] == "--sid") sid = args[i + 1];
        }
        Pc = new Computer { IsCpuEnabled = true, IsGpuEnabled = true, IsMotherboardEnabled = true, IsControllerEnabled = true };
        try { Pc.Open(); } catch (Exception e) { Console.Error.WriteLine("open: " + e.Message); return 2; }
        Rescan();
        AppDomain.CurrentDomain.ProcessExit += (_, _) => ReleaseAll();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; Quit = true; };
        new Thread(Watchdog) { IsBackground = true, Name = "watchdog" }.Start();

        while (!Quit)
        {
            try
            {
                using var server = Create(pipe, sid);
                var wait = server.WaitForConnectionAsync();
                while (!wait.IsCompleted && !Quit) Thread.Sleep(100);
                if (Quit) break;
                Serve(server);
            }
            catch (Exception e) { Console.Error.WriteLine("pipe: " + e.Message); Thread.Sleep(500); }
        }
        ReleaseAll();
        try { Pc.Close(); } catch { }
        return 0;
    }

    static NamedPipeServerStream Create(string name, string sid)
    {
        var sec = new PipeSecurity();
        sec.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
        var user = sid.Length > 0 ? new SecurityIdentifier(sid) : WindowsIdentity.GetCurrent().User!;
        sec.AddAccessRule(new PipeAccessRule(user, PipeAccessRights.ReadWrite, AccessControlType.Allow));
        sec.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        return NamedPipeServerStreamAcl.Create(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 65536, 65536, sec);
    }

    static void Serve(NamedPipeServerStream s)
    {
        using var r = new StreamReader(s);
        using var w = new StreamWriter(s) { AutoFlush = true };
        while (s.IsConnected && !Quit)
        {
            var line = r.ReadLine();
            if (line == null) break;
            string reply;
            try { reply = Handle(JsonNode.Parse(line)!.AsObject()); }
            catch (Exception e) { reply = new JsonObject { ["ok"] = false, ["error"] = e.Message }.ToJsonString(); }
            w.WriteLine(reply);
        }
    }

    static string Handle(JsonObject q)
    {
        lock (Gate)
        {
            LastCmd = DateTime.UtcNow;
            var cmd = (string)q["cmd"]!;
            var o = new JsonObject { ["ok"] = true };
            switch (cmd)
            {
                case "hello":
                    o["version"] = "0.1.0";
                    o["admin"] = new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);
                    break;
                case "list": Rescan(); o["sensors"] = ListJson(); break;
                case "read":
                    o["values"] = ReadJson();
                    o["taken"] = new JsonArray(Taken.Select(t => (JsonNode)JsonValue.Create(t)!).ToArray());
                    o["failed"] = Failed;
                    break;
                case "set":
                    foreach (var it in q["items"]!.AsArray())
                    {
                        var id = (string)it![0]!;
                        var pct = (float)it[1]!;
                        if (!Controls.TryGetValue(id, out var c)) continue;
                        Taken.Add(id);
                        c.Control!.SetSoftware(Math.Clamp(pct, 0, 100));
                    }
                    Failed = false;
                    break;
                case "release":
                    foreach (var id in q["ids"]!.AsArray()) Release((string)id!);
                    break;
                case "failsafe":
                    FailPct = Math.Clamp((float)(q["pct"] ?? 100)!, 0, 100);
                    Grace = Math.Clamp((double)(q["grace"] ?? 10)!, 3, 120);
                    break;
                case "quit": ReleaseAllLocked(); Quit = true; break;
                default: o["ok"] = false; o["error"] = "unknown command"; break;
            }
            return o.ToJsonString();
        }
    }

    static IEnumerable<IHardware> Walk(IEnumerable<IHardware> hs)
    {
        foreach (var h in hs)
        {
            yield return h;
            foreach (var s in Walk(h.SubHardware)) yield return s;
        }
    }

    static void Rescan()
    {
        Controls.Clear();
        All.Clear();
        // LibreHardwareMonitor creates some sensors (fan speeds, board and CPU temperatures) only on the first Update()
        foreach (var h in Walk(Pc!.Hardware)) h.Update();
        foreach (var h in Walk(Pc!.Hardware))
            foreach (var s in h.Sensors)
                // Power (watts) is read only: the Fans page uses it for how much heat the air picks up in the case
                if (s.SensorType is SensorType.Temperature or SensorType.Fan or SensorType.Control or SensorType.Load or SensorType.Power)
                {
                    All[s.Identifier.ToString()] = s;
                    if (s.SensorType == SensorType.Control && s.Control != null) Controls[s.Identifier.ToString()] = s;
                }
    }

    static JsonArray ListJson()
    {
        var a = new JsonArray();
        foreach (var h in Walk(Pc!.Hardware))
        {
            h.Update();
            foreach (var s in h.Sensors)
            {
                if (!All.ContainsKey(s.Identifier.ToString())) continue;
                a.Add(new JsonObject
                {
                    ["id"] = s.Identifier.ToString(), ["name"] = s.Name, ["hw"] = h.Name, ["hwType"] = h.HardwareType.ToString(),
                    ["type"] = s.SensorType.ToString().ToLowerInvariant(), ["value"] = s.Value, ["control"] = s.Control != null,
                });
            }
        }
        return a;
    }

    static JsonObject ReadJson()
    {
        var o = new JsonObject();
        foreach (var h in Walk(Pc!.Hardware)) h.Update();
        foreach (var (id, s) in All) o[id] = s.Value;
        return o;
    }

    static void Release(string id)
    {
        if (Taken.Remove(id) && Controls.TryGetValue(id, out var c)) { try { c.Control!.SetDefault(); } catch { } }
    }

    static void ReleaseAll() { lock (Gate) ReleaseAllLocked(); }

    static void ReleaseAllLocked() { foreach (var id in Taken.ToArray()) Release(id); }

    static void Watchdog()
    {
        while (!Quit)
        {
            Thread.Sleep(1000);
            lock (Gate)
            {
                if (Taken.Count == 0 || Failed || (DateTime.UtcNow - LastCmd).TotalSeconds < Grace) continue;
                foreach (var id in Taken) { try { Controls[id].Control!.SetSoftware(FailPct); } catch { } }
                Failed = true;
            }
        }
    }
}
