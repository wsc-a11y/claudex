# dev-manager.ps1 — claudex 管理器(Windows 专属)
# 管理正式版服务(单进程跑 5179,同端口托管 UI 与 API)。启动时智能判断:
# 源码新于 web/dist 才走 `pnpm serve`(打包+启动),产物已最新则直接
# `pnpm start` 秒开。历史上一度管 `pnpm dev`(5173/5174/5179 三端口 +
# 两个 Vite);日常使用者不写码,正式版更省内存、启动快,且手机
# (frpc → 5179)与本地看到的是同一份打包产物。
# 用法:
#   dev-manager.ps1                 # GUI(默认):窗口 + 托盘
#   dev-manager.ps1 -Command status # CLI:输出状态(ASCII)
#   dev-manager.ps1 -Command start|stop|restart
#
# 作用域约定(重要):GUI 控件/状态一律 $script: 前缀。PowerShell 的 .NET
# 事件回调(Timer Tick、按钮 Click、托盘菜单)触发时在脚本级作用域执行,
# 拿不到函数局部变量——控件存脚本级是唯一的可靠做法。
param(
  [ValidateSet('gui', 'status', 'start', 'stop', 'restart')]
  [string]$Command = 'gui'
)

$ErrorActionPreference = 'Stop'

# 项目根 = scripts/dev-manager 上溯两级
$RootDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Ports = 5179   # 正式版只监听这一个端口
$script:RootPid = $null
# 日志一律进 ~/.claudex/logs/(与 server.log 同处),不污染 %TEMP%
$script:LogDir  = Join-Path $HOME '.claudex\logs'
# pnpm serve 的输出(含打包阶段)重定向到这里,启动失败时排查用
$script:ServeLog = Join-Path $script:LogDir 'serve.log'
# dev-manager 自身的退出审计日志(见 Write-ExitLog)
$script:ManagerLog = Join-Path $script:LogDir 'dev-manager.log'

# ---------- 核心:状态与启停(CLI 与 GUI 共用) ----------

function Get-ClaudexStatus {
  $listening = @{}
  foreach ($p in $Ports) {
    $hit = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
    $listening[$p] = [bool]$hit
  }
  $pids = @(
    Get-NetTCPConnection -LocalPort $Ports -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique
  )
  return [pscustomobject]@{
    Ports   = $listening
    Running = ($pids.Count -gt 0)
    Pids    = $pids
  }
}

function Start-ClaudexDev {
  $st = Get-ClaudexStatus
  if ($st.Running) {
    Write-Host 'OCCUPIED: port 5179 already in use; run stop first'
    return $false
  }
  # 智能启动:产物比源码新(没改过代码)→ 跳过打包直接启动,秒开;
  # 源码有更新 → pnpm serve 先打包再启动(build 失败不会起 server,
  # 日志能看出中断原因)。打包失败会 exit 非 0,cmd 退出、端口保持空,
  # 上层 WatchStartup 超时后提示去看 ServeLog。
  # 日志目录必须存在,否则 cmd 的重定向会失败、命令根本不执行。
  New-Item -ItemType Directory -Path $script:LogDir -Force | Out-Null
  $needsBuild = Test-NeedsBuild
  $cmd = if ($needsBuild) {
    "pnpm serve > `"$script:ServeLog`" 2>&1"
  } else {
    "pnpm start > `"$script:ServeLog`" 2>&1"
  }
  $p = Start-Process -FilePath $env:ComSpec -ArgumentList '/c', $cmd `
    -WorkingDirectory $RootDir -WindowStyle Hidden -PassThru
  $script:RootPid = $p.Id
  Write-Host ("STARTED rootPid={0} build={1} log={2}" -f $p.Id, $needsBuild, $script:ServeLog)
  return $true
}

# 是否需要重新打包:web/ 与 shared/ 下(排除 node_modules 和 web/dist)
# 最新源码文件的修改时间,若晚于 web/dist 里最新产物 → 需要 build。
# 前端 bundle 同时吞 web/src 与 shared/src,两个目录都得纳入比较。
function Test-NeedsBuild {
  $webDir = Join-Path $RootDir 'web'
  $distDir = Join-Path $webDir 'dist'
  $newest = $null
  foreach ($d in @($webDir, (Join-Path $RootDir 'shared'))) {
    $hit = Get-ChildItem $d -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object {
        $_.FullName -notlike (Join-Path $d 'node_modules*') -and
        $_.FullName -notlike "$distDir*" -and
        $_.Extension -ne '.tsbuildinfo'   # tsc -b 增量缓存,非构建输入
      } |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($hit -and (-not $newest -or $hit.LastWriteTime -gt $newest.LastWriteTime)) {
      $newest = $hit
    }
  }
  $distNewest = Get-ChildItem $distDir -Recurse -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $distNewest) { return $true }  # 从未打包过
  if ($newest -and $newest.LastWriteTime -gt $distNewest.LastWriteTime) { return $true }
  return $false
}

function Stop-ClaudexDev {
  $killed = @()
  if ($script:RootPid) {
    if (Get-Process -Id $script:RootPid -ErrorAction SilentlyContinue) {
      # 经 cmd 包装执行:stderr 在 cmd 层吞掉,避免 $ErrorActionPreference='Stop'
      # 下 native 错误输出(进程已死/端口表滞后导致的"找不到进程"噪音)
      & $env:ComSpec /c "taskkill /PID $script:RootPid /T /F >NUL 2>&1"
      $killed += $script:RootPid
    }
    $script:RootPid = $null
  }
  Start-Sleep -Milliseconds 500  # 等 Windows 端口表跟上进程终止,避免兜底补刀扑空
  $st = Get-ClaudexStatus
  foreach ($procId in $st.Pids) {
    if (Get-Process -Id $procId -ErrorAction SilentlyContinue) {
      & $env:ComSpec /c "taskkill /PID $procId /T /F >NUL 2>&1"
      $killed += $procId
    }
  }
  if ($killed.Count -gt 0) { Write-Host ("KILLED {0}" -f ($killed -join ',')) }
  else { Write-Host 'NOTHING to stop' }
  return $killed.Count -gt 0
}

function Restart-ClaudexDev {
  Stop-ClaudexDev | Out-Null
  # 等端口全部释放(最多 15 秒)
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline) {
    if (-not (Get-ClaudexStatus).Running) { break }
    Start-Sleep -Milliseconds 500
  }
  if ((Get-ClaudexStatus).Running) {
    Write-Host 'FAILED: ports not freed within 15s'
    return $false
  }
  return Start-ClaudexDev
}

function Invoke-CliStatus {
  $st = Get-ClaudexStatus
  $parts = foreach ($p in $Ports) { "$p=$($st.Ports[$p])" }
  Write-Host ("running={0} pids=[{1}] {2}" -f $st.Running, ($st.Pids -join ','), ($parts -join ' '))
}

# ---------- GUI:窗口 + 托盘 ----------

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# GUI 状态(脚本级,事件回调可读)
$script:Form = $null
$script:StateLabel = $null
$script:PortsLabel = $null
$script:BtnStart = $null
$script:BtnStop = $null
$script:BtnRe = $null
$script:StatusTimer = $null
$script:Tray = $null
$script:IconRunning = $null
$script:IconStopped = $null
$script:LastRunning = $null
$script:TrayHintShown = $false
$script:ReallyQuit = $false
$script:Mutex = $null

function New-TrayIcon {
  param([bool]$running)
  $bmp = New-Object System.Drawing.Bitmap 16, 16
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $brush = New-Object System.Drawing.SolidBrush (
    $(if ($running) { [System.Drawing.Color]::ForestGreen } else { [System.Drawing.Color]::Gray }))
  $g.FillEllipse($brush, 3, 3, 10, 10)
  $hIcon = $bmp.GetHicon()
  $icon = [System.Drawing.Icon]::FromHandle($hIcon)
  $brush.Dispose(); $g.Dispose(); $bmp.Dispose()
  return $icon
}

function Update-TrayState {
  param($st)
  if ($script:LastRunning -eq $st.Running) { return }
  $script:LastRunning = $st.Running
  if ($st.Running) {
    $script:Tray.Icon = $script:IconRunning
    $script:Tray.Text = 'claudex 管理器 — 服务运行中'
  } else {
    $script:Tray.Icon = $script:IconStopped
    $script:Tray.Text = 'claudex 管理器 — 服务已停止'
  }
}

function Show-TrayHint {
  if ($script:TrayHintShown) { return }
  $script:TrayHintShown = $true
  $script:Tray.ShowBalloonTip(2500, 'claudex 管理器', '已最小化到托盘:右键图标操作,双击图标恢复窗口。', [System.Windows.Forms.ToolTipIcon]::Info)
}

function Start-WatchStartup {
  # 启动探测:正式版启动含打包,耗时通常 10~30 秒,不能 5 秒就判失败。
  # 每 4 秒轮询一次(计数器放 $s2.Tag),端口一监听即成功;约 2 分钟仍无
  # 监听 = 启动失败,提示去看 ServeLog(build 报错会写在那里)。
  # 注意:回调里不能引用局部 $t(事件在脚本级作用域执行,$t 会是 $null,
  # 曾因此崩出 NullReferenceException)——改用 sender 参数 $s2(即 Timer 自身)
  $t = New-Object System.Windows.Forms.Timer
  $t.Interval = 4000
  $t.Add_Tick({
    param($s2, $e2)
    $s2.Tag = [int]$s2.Tag + 1
    if ((Get-ClaudexStatus).Running) { $s2.Stop(); return }
    if ([int]$s2.Tag -ge 30) {
      $s2.Stop()
      $msg = "启动失败:5179 未监听。`n请查看日志:$script:ServeLog"
      if ($script:Tray) {
        $script:Tray.ShowBalloonTip(8000, 'claudex 管理器', $msg,
          [System.Windows.Forms.ToolTipIcon]::Warning)
      } else {
        [System.Windows.Forms.MessageBox]::Show($msg, 'claudex 管理器', 'OK', 'Warning') | Out-Null
      }
    }
  })
  $t.Tag = 0
  $t.Start()
}

function Update-StatusUI {
  $st = Get-ClaudexStatus
  $portsText = (($Ports | ForEach-Object { "{0}: {1}" -f $_, $(if ($st.Ports[$_]) { '运行中' } else { '已停止' }) }) -join '   ')
  $script:PortsLabel.Text = $portsText
  if ($st.Running) {
    $script:StateLabel.Text = '状态:● 运行中'
    $script:StateLabel.ForeColor = [System.Drawing.Color]::ForestGreen
  } else {
    $script:StateLabel.Text = '状态:○ 已停止'
    $script:StateLabel.ForeColor = [System.Drawing.Color]::Gray
  }
  $script:BtnStart.Enabled = -not $st.Running
  $script:BtnStop.Enabled  = $st.Running
  $script:BtnRe.Enabled    = $st.Running
  Update-TrayState $st
}

function New-Btn {
  param([string]$text, [int]$x, [int]$y, [int]$w)
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text
  $b.Location = New-Object System.Drawing.Point($x, $y)
  $b.Size = New-Object System.Drawing.Size($w, 30)
  return $b
}

function Write-ExitLog {
  param([string]$msg)
  Add-Content -Path $script:ManagerLog -Value $msg
}

function Exit-Manager {
  Write-ExitLog ("[exit {0}] entered" -f (Get-Date -Format 'HH:mm:ss'))
  $st = Get-ClaudexStatus
  Write-ExitLog ("  running={0} rootPid={1}" -f $st.Running, $script:RootPid)
  if ($st.Running) {
    $r = [System.Windows.Forms.MessageBox]::Show(
      '服务正在运行,退出将同时停止服务。继续?',
      'claudex 管理器', 'YesNo', 'Question', 'Button2')
    Write-ExitLog ("  msgbox={0}" -f $r)
    if ($r -ne 'Yes') {
      Write-ExitLog '  chose no -> stay open'
      return
    }
    Write-ExitLog '  chose yes -> stop dev'
    Stop-ClaudexDev | Out-Null
    $after = Get-ClaudexStatus
    Write-ExitLog ("  after-stop running={0}" -f $after.Running)
  } else {
    Write-ExitLog '  not running -> quit directly'
  }
  $script:ReallyQuit = $true
  if ($script:StatusTimer) { $script:StatusTimer.Stop() }
  if ($script:Tray) { $script:Tray.Visible = $false }
  Write-ExitLog '  closing form'
  $script:Form.Close()
}

function Invoke-Gui {
  # 双开互斥:第二个实例直接提示退出
  $script:Mutex = New-Object System.Threading.Mutex($false, 'claudex-dev-manager-single')
  if (-not $script:Mutex.WaitOne(0)) {
    [System.Windows.Forms.MessageBox]::Show('管理器已在运行。', 'claudex 管理器', 'OK', 'Information') | Out-Null
    return
  }

  $script:Form = New-Object System.Windows.Forms.Form
  $script:Form.Text = 'claudex 管理器'
  $script:Form.FormBorderStyle = 'FixedSingle'
  $script:Form.MaximizeBox = $false
  $script:Form.Size = New-Object System.Drawing.Size(460, 210)
  $script:Form.StartPosition = 'CenterScreen'
  $script:Form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)

  # 状态区
  $script:StateLabel = New-Object System.Windows.Forms.Label
  $script:StateLabel.Text = '检查中…'
  $script:StateLabel.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10, [System.Drawing.FontStyle]::Bold)
  $script:StateLabel.AutoSize = $true
  $script:StateLabel.Location = New-Object System.Drawing.Point(16, 16)
  $script:Form.Controls.Add($script:StateLabel)

  $script:PortsLabel = New-Object System.Windows.Forms.Label
  $script:PortsLabel.Text = ''
  $script:PortsLabel.AutoSize = $true
  $script:PortsLabel.Location = New-Object System.Drawing.Point(16, 44)
  $script:Form.Controls.Add($script:PortsLabel)

  # 按钮(两行:操作 / 链接)。正式版两个页面都在 5179 上,靠路径区分。
  $script:BtnStart = New-Btn '启动服务' 16 80 88
  $script:BtnStop  = New-Btn '停止服务' 110 80 88
  $script:BtnRe    = New-Btn '重启服务' 204 80 88
  $btnMain  = New-Btn '打开主站' 298 80 120
  $btnFiles = New-Btn '打开文件站' 16 120 120
  $btnHide  = New-Btn '缩到托盘' 142 120 90
  $btnExit  = New-Btn '退出' 238 120 90
  foreach ($b in @($script:BtnStart, $script:BtnStop, $script:BtnRe, $btnMain, $btnFiles, $btnHide, $btnExit)) {
    $script:Form.Controls.Add($b)
  }

  $script:BtnStart.Add_Click({
    if ((Get-ClaudexStatus).Running) { return }
    Start-ClaudexDev | Out-Null
    Update-StatusUI
    Start-WatchStartup
  })
  $script:BtnStop.Add_Click({
    Stop-ClaudexDev | Out-Null
    Update-StatusUI
  })
  $script:BtnRe.Add_Click({
    if (-not (Get-ClaudexStatus).Running) { return }
    $script:BtnRe.Enabled = $false
    Restart-ClaudexDev | Out-Null
    Update-StatusUI
    Start-WatchStartup
  })
  $btnMain.Add_Click({ [System.Diagnostics.Process]::Start('http://localhost:5179/') | Out-Null })
  $btnFiles.Add_Click({ [System.Diagnostics.Process]::Start('http://localhost:5179/files.html') | Out-Null })
  $btnHide.Add_Click({ $script:Form.Hide() | Out-Null; Show-TrayHint })
  $btnExit.Add_Click({ Exit-Manager })

  # 托盘
  $script:IconRunning = New-TrayIcon $true
  $script:IconStopped = New-TrayIcon $false
  $script:Tray = New-Object System.Windows.Forms.NotifyIcon
  $script:Tray.Icon = $script:IconStopped
  $script:Tray.Text = 'claudex 管理器'
  $script:Tray.Visible = $true

  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  foreach ($item in @(
      @{ T = '启动服务';   A = { $script:BtnStart.PerformClick() } },
      @{ T = '停止服务';   A = { $script:BtnStop.PerformClick() } },
      @{ T = '重启服务';   A = { $script:BtnRe.PerformClick() } },
      @{ T = '打开主站';   A = { $btnMain.PerformClick() } },
      @{ T = '打开文件站'; A = { $btnFiles.PerformClick() } }
    )) {
    $mi = New-Object System.Windows.Forms.ToolStripMenuItem($item.T)
    # .GetNewClosure() 必须:foreach 的 $item 是引用,不加则所有菜单项
    # 事件触发时读到循环结束后的最后一个 $item(PowerShell 闭包坑)
    $mi.Add_Click(({ param($s2, $e2) & $item.A }.GetNewClosure()))
    [void]$menu.Items.Add($mi)
  }
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  $miExit = New-Object System.Windows.Forms.ToolStripMenuItem('退出')
  $miExit.Add_Click({ Exit-Manager })
  [void]$menu.Items.Add($miExit)
  $script:Tray.ContextMenuStrip = $menu
  $script:Tray.Add_DoubleClick({
    $script:Form.Show() | Out-Null
    $script:Form.WindowState = 'Normal'
    $script:Form.Activate()
  })

  # 状态轮询 2s
  $script:StatusTimer = New-Object System.Windows.Forms.Timer
  $script:StatusTimer.Interval = 2000
  $script:StatusTimer.Add_Tick({ Update-StatusUI })
  $script:StatusTimer.Start()

  Update-StatusUI
  $script:Form.Add_Shown({ $script:Form.Activate() })
  $script:Form.Add_FormClosing({
    param($s, $e)
    Write-ExitLog ("[closing {0}] reallyQuit={1}" -f (Get-Date -Format 'HH:mm:ss'), $script:ReallyQuit)
    if (-not $script:ReallyQuit) {
      $e.Cancel = $true
      $script:Form.Hide() | Out-Null
      Show-TrayHint
    }
  })
  [System.Windows.Forms.Application]::Run($script:Form)
}

# ---------- 命令路由(放文件末尾:函数必须先定义) ----------
switch ($Command) {
  'status'  { Invoke-CliStatus }
  'start'   { Start-ClaudexDev }
  'stop'    { Stop-ClaudexDev }
  'restart' { Restart-ClaudexDev }
  'gui'     { Invoke-Gui }
  default   { Write-Host "Command '$Command' not implemented yet." }
}
