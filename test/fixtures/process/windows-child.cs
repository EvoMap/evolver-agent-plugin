using System;
using System.Diagnostics;
using System.Text.RegularExpressions;
using System.Threading;

public class StrippedChild {
  public static void Main(string[] args) {
    foreach (string key in Environment.GetEnvironmentVariables().Keys) {
      if (Regex.IsMatch(key, "^(systemroot|windir|comspec)$", RegexOptions.IgnoreCase)) {
        throw new Exception("Unexpected system environment key: " + key);
      }
    }
    if (args.Length == 0) {
      using (Process current = Process.GetCurrentProcess()) {
        Process descendant = Process.Start(new ProcessStartInfo(current.MainModule.FileName, "descendant") {
          UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true
        });
        if (descendant.StandardOutput.ReadLine() != "ready" || descendant.HasExited) {
          throw new Exception("Descendant did not confirm its stripped environment");
        }
        Console.WriteLine("[" + current.Id + "," + descendant.Id + "]");
        Console.Out.Flush();
      }
    } else {
      Console.WriteLine("ready");
      Console.Out.Flush();
    }
    Thread.Sleep(5000);
  }
}
