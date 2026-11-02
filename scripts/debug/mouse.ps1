# Windows 版的真实输入助手（给 win-real-input.mjs 用；文件带 UTF-8 BOM，Windows PowerShell 5.1 才不会按 GBK 读中文注释）：从标准输入逐行读命令，每条回一行结果。
# 鼠标用 mouse_event 发（和 SendInput 一样进系统输入流，会经过点击穿透判定和低级鼠标钩子，跟手动操作一样）。
# 坐标 = 物理像素，原点在主屏左上角（Electron 的 DIP 坐标由调用方换算好再传进来）。
#
#   pos                     光标位置 -> x y
#   move x y                移动光标
#   click x y [right]       单击（左键 / 右键）
#   down x y / up x y       按下 / 松开左键
#   drag x y                按住左键移到 (x, y)
#   key escape | key ctrl+alt+p
#   front                   最前面的窗口 -> {"pid":..,"title":..,"process":..}
#   rect <窗口标题>          找这个标题的顶层窗口 -> x y 宽 高（找不到回 error）
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class W {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static void Move(int x, int y) {
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    int nx = (int)Math.Round((x - vx) * 65535.0 / (vw - 1));
    int ny = (int)Math.Round((y - vy) * 65535.0 / (vh - 1));
    mouse_event(0x0001 | 0x8000 | 0x4000, nx, ny, 0, UIntPtr.Zero); // MOVE | ABSOLUTE | VIRTUALDESK
  }
  public static void Button(uint flag) { mouse_event(flag, 0, 0, 0, UIntPtr.Zero); }
  public static void Key(byte vk, bool down) { keybd_event(vk, 0, down ? 0u : 2u, UIntPtr.Zero); }
  public static string Rect(string title) {
    IntPtr h = FindWindow(null, title);
    if (h == IntPtr.Zero) return "error not found";
    RECT r; GetWindowRect(h, out r);
    return r.L + " " + r.T + " " + (r.R - r.L) + " " + (r.B - r.T);
  }
  public static string Front() {
    IntPtr h = GetForegroundWindow();
    uint pid; GetWindowThreadProcessId(h, out pid);
    StringBuilder sb = new StringBuilder(512); GetWindowText(h, sb, 512);
    string name = ""; try { name = Process.GetProcessById((int)pid).ProcessName; } catch {}
    return "{\"pid\":" + pid + ",\"title\":\"" + sb.ToString().Replace("\\", "\\\\").Replace("\"", "\\\"") + "\",\"process\":\"" + name + "\"}";
  }
}
'@
[W]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null # 按物理像素算坐标（每个显示器的缩放都考虑）
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Reply([string]$s) { [Console]::Out.WriteLine($s); [Console]::Out.Flush() }
$keys = @{ 'escape' = @(0x1B); 'ctrl+alt+p' = @(0x11, 0x12, 0x50) }

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $p = $line.Trim() -split '\s+'
  try {
    switch ($p[0]) {
      'pos' { $pt = New-Object W+POINT; [W]::GetCursorPos([ref]$pt) | Out-Null; Reply "$($pt.X) $($pt.Y)" }
      'move' { [W]::Move([int]$p[1], [int]$p[2]); Reply 'ok' }
      'drag' { [W]::Move([int]$p[1], [int]$p[2]); Reply 'ok' }
      'down' { [W]::Move([int]$p[1], [int]$p[2]); [W]::Button(0x0002); Reply 'ok' }
      'up' { [W]::Move([int]$p[1], [int]$p[2]); [W]::Button(0x0004); Reply 'ok' }
      'click' {
        [W]::Move([int]$p[1], [int]$p[2])
        Start-Sleep -Milliseconds 30
        if ($p.Count -gt 3 -and $p[3] -eq 'right') { [W]::Button(0x0008); Start-Sleep -Milliseconds 40; [W]::Button(0x0010) }
        else { [W]::Button(0x0002); Start-Sleep -Milliseconds 40; [W]::Button(0x0004) }
        Reply 'ok'
      }
      'key' {
        $vks = $keys[$p[1]]
        foreach ($k in $vks) { [W]::Key([byte]$k, $true); Start-Sleep -Milliseconds 20 }
        $rev = $vks.Clone()
        [array]::Reverse($rev)
        foreach ($k in $rev) { [W]::Key([byte]$k, $false); Start-Sleep -Milliseconds 20 }
        Reply 'ok'
      }
      'front' { Reply ([W]::Front()) }
      'rect' { Reply ([W]::Rect($line.Trim().Substring(5))) }
      default { Reply ('error unknown command ' + $p[0]) }
    }
  } catch {
    Reply ('error ' + $_.Exception.Message)
  }
}
