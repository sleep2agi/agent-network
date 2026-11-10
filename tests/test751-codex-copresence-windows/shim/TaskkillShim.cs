// #1337 —— 纯测试夹具：`taskkill.exe` 包装器（**只在具名测试模式**下改变行为）。
//
//   mode = "delegate"          ：完全委托真实 taskkill（默认；等价于没装夹具）
//   mode = "delegate-nonzero"  ：**先真正终止**（委托真实 taskkill 并等它跑完），再**故意**返回非零
//                                ⇒ 场景 A：终止已完成、精确身份都已退出，但包装器报非零。
//   mode = "nonzero-noop"      ：**不终止**任何进程，直接返回非零
//                                ⇒ 场景 B：匹配身份仍然存活。
//
// 每次调用写调用日志（`ANET_TEST1337_TK_LOG`）以证明命中；不做全局替换、不对无关 PID 发 kill。
using System;
using System.Diagnostics;
using System.IO;
using System.Text;

internal static class TaskkillShim
{

    /// <summary>Windows 命令行引号（.NET Framework 无 ProcessStartInfo.ArgumentList）。</summary>
    private static string QuoteArgument(string a)
    {
        if (a.Length > 0 && a.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return a;
        var sb = new System.Text.StringBuilder("\"");
        int backslashes = 0;
        foreach (char c in a)
        {
            if (c == '\\') { backslashes++; sb.Append(c); }
            else if (c == '"') { sb.Append('\\', backslashes * 2 + 1); sb.Append('"'); backslashes = 0; }
            else { backslashes = 0; sb.Append(c); }
        }
        sb.Append('\\', backslashes * 2);
        sb.Append('"');
        return sb.ToString();
    }

    private static int Main(string[] args)
    {
        string log = Environment.GetEnvironmentVariable("ANET_TEST1337_TK_LOG");
        string mode = Environment.GetEnvironmentVariable("ANET_TEST1337_TK_MODE") ?? "delegate";
        string real = Environment.GetEnvironmentVariable("ANET_TEST1337_REAL_TASKKILL");

        try
        {
            if (!string.IsNullOrEmpty(log))
                File.AppendAllText(log, mode + "\t" + string.Join(" ", args) + Environment.NewLine);
        }
        catch { }

        if (mode == "nonzero-noop")
        {
            Console.Error.Write("ERROR: test1337 fixture refused termination of the managed tree" + Environment.NewLine);
            return 128;
        }

        if (string.IsNullOrEmpty(real) || !File.Exists(real))
        {
            Console.Error.Write("test1337: real taskkill not found (ANET_TEST1337_REAL_TASKKILL)" + Environment.NewLine);
            return 127;
        }

        var psi = new ProcessStartInfo(real) { UseShellExecute = false, Arguments = string.Join(" ", Array.ConvertAll(args, QuoteArgument)) };
        int realExit;
        using (var p = Process.Start(psi))
        {
            p.WaitForExit();
            realExit = p.ExitCode;
        }

        // 场景 A：真实终止已完成，但包装器仍然返回非零。
        return mode == "delegate-nonzero" ? 128 : realExit;
    }
}
