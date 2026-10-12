#!/usr/bin/env pwsh
# send-ctrlc.ps1 —— 给指定 pid 所在的**控制台**发 Ctrl+C（= 真·优雅退出路径，区别于 TerminateProcess 硬杀）。
# T18 用它构造"宿主正常退出"。实现：AttachConsole(pid) → 忽略自己的 Ctrl+C → GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0) → FreeConsole。
param([Parameter(Mandatory=$true)][int]$TargetPid)
$src = @'
using System;
using System.Runtime.InteropServices;
public static class Ct {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GenerateConsoleCtrlEvent(uint ev, uint grp);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleCtrlHandler(IntPtr h, bool add);
  public static int Send(uint pid) {
    FreeConsole();                                     // ★ 必须先脱离自己的控制台，否则 AttachConsole 必失败
    SetConsoleCtrlHandler(IntPtr.Zero, true);          // 自己别被 Ctrl+C 带走
    if (!AttachConsole(pid)) { return -Marshal.GetLastWin32Error(); }
    bool ok = GenerateConsoleCtrlEvent(0 /*CTRL_C_EVENT*/, 0);
    int err = Marshal.GetLastWin32Error();
    FreeConsole();
    return ok ? 0 : err;
  }
}
'@
try { Add-Type -TypeDefinition $src -ErrorAction Stop } catch { if (-not ('Ct' -as [type])) { throw } }
$rc = [Ct]::Send([uint32]$TargetPid)
if ($rc -eq 0) { Write-Host "  Ctrl+C 已投递到 pid=$TargetPid 的控制台" } else { Write-Host "  ⚠️ Ctrl+C 投递失败（AttachConsole/GenerateConsoleCtrlEvent 返回 $rc）—— 该路径不可用，改用别的方式" }
exit $rc
