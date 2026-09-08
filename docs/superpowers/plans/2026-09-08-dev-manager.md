# dev 管理器(Windows 托盘工具)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做一个 Windows 专属的 claudex dev 管理器:双击入口出现窗口,可一键启停 `pnpm dev`(停止时可靠杀整棵进程树),窗口可缩为系统托盘,托盘右键菜单同功能。

**Architecture:** 单个 PowerShell 5.1 + .NET WinForms 脚本承载全部逻辑(窗口 + NotifyIcon 托盘 + 状态轮询),一个 `.cmd` 入口负责双击拉起。状态判定基于端口实际监听(Get-NetTCPConnection),不信任自启子进程;停止 = 记录 PID 树杀 + 按端口反查兜底。脚本同时支持 `-Command status/start/stop/restart` 的 CLI 模式(输出 ASCII,便于脚本化验证),GUI 是默认模式。

**Tech Stack:** PowerShell 5.1 + .NET Framework WinForms(System.Windows.Forms / System.Drawing),`taskkill /T /F`,零第三方依赖。

**Spec:** docs/superpowers/specs/2026-09-08-dev-manager-design.md(已批准)

## Global Constraints

- 仅 Windows;本目录 **d:\claudex 不是 git 仓库**——所有任务以「验证通过」为完成标准,无 commit 步骤;变更由用户手动同步 Mac(本工具建议不同步)。
- 交付文件只有两个:`d:\claudex\启动dev管理器.cmd`(入口,内容纯 ASCII)与 `d:\claudex\scripts\dev-manager\dev-manager.ps1`。
- **`.ps1` 含中文 UI 文案,必须 UTF-8 with BOM**。PowerShell 5.1 对无 BOM 的 UTF-8 中文一律乱码。每个改动过 `.ps1` 的任务,验证前先跑 BOM 归一命令(见 Task 1 Step 1 的写法,后续任务复用同一命令)。
- dev 工作目录固定 = `$RootDir`(由 `$PSScriptRoot` 上溯两级推导,写死 `d:\claudex` 之外再加推导,防止脚本被挪位后失效)。
- 端口约定:`5179` 后端 / `5173` 主站 / `5174` 文件站,常量数组 `$Ports = 5173, 5174, 5179`。
- 启动命令固定为 `cmd /c pnpm dev > NUL 2>&1`(`$env:ComSpec`),输出按用户决定丢弃;树根为 cmd.exe,其 PID 记录为 `$script:RootPid`。
- 函数/命令命名:`Get-ClaudexStatus`、`Start-ClaudexDev`、`Stop-ClaudexDev`、`Restart-ClaudexDev`、`Exit-Manager`。CLI 输出保持 ASCII(机器可读),中文只用于 GUI。
- GUI 事件处理器全部通过 `$form.add_X({ param($s,$e) ... })` 挂接;UI 线程上的阻塞操作(MessageBox)不放进 Timer Tick。
- 不碰 frpc、不碰生产服务、不改 claudex 任何现有代码。

---

### Task 1: ps1 骨架 + 状态探测(CLI status)

**Files:**
- Create: `d:\claudex\scripts\dev-manager\dev-manager.ps1`

**Interfaces:**
- Produces: `Get-ClaudexStatus` → `[pscustomobject]@{ Ports = @{5173=$bool;5174=$bool;5179=$bool}; Running=[bool]; Pids=@(int[]) }`;CLI 路由 `-Command status`。

- [ ] **Step 1: 建目录并写骨架文件**

```bash
mkdir -p /d/claudex/scripts/dev-manager
```

写入 `dev-manager.ps1`(PowerShell 5.1 语法,勿用 PS7 专属特性):

```powershell
# dev-manager.ps1 — claudex dev 管理器(Windows 专属)
# 用法:
#   dev-manager.ps1                 # GUI(默认):窗口 + 托盘
#   dev-manager.ps1 -Command status # CLI:输出状态(ASCII)
#   dev-manager.ps1 -Command start|stop|restart
param(
  [ValidateSet('gui', 'status', 'start', 'stop', 'restart')]
  [string]$Command = 'gui'
)

$ErrorActionPreference = 'Stop'

# 项目根 = scripts/dev-manager 上溯两级
$RootDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Ports = 5173, 5174, 5179
$script:RootPid = $null

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

function Invoke-CliStatus {
  $st = Get-ClaudexStatus
  $parts = foreach ($p in $Ports) { "$p=$($st.Ports[$p])" }
  Write-Host ("running={0} pids=[{1}] {2}" -f $st.Running, ($st.Pids -join ','), ($parts -join ' '))
}

switch ($Command) {
  'status' { Invoke-CliStatus }
  'gui'    { Write-Host 'GUI not implemented yet (Task 4).' }
  default  { Write-Host "Command '$Command' not implemented yet." }
}
```

- [ ] **Step 2: BOM 归一(ps1 必须 UTF-8 BOM)**

```bash
powershell -NoProfile -Command "$p='d:\claudex\scripts\dev-manager\dev-manager.ps1'; $c=[IO.File]::ReadAllText($p); [IO.File]::WriteAllText($p, $c, (New-Object Text.UTF8Encoding $true))"
```

验证头三字节:
```bash
head -c 3 /d/claudex/scripts/dev-manager/dev-manager.ps1 | od -An -tx1
```
期望:`ef bb bf`

- [ ] **Step 3: 运行 status 验证**

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File 'd:\claudex\scripts\dev-manager\dev-manager.ps1' -Command status
```

期望:输出 `running=true/false pids=[...] 5173=... 5174=... 5179=...`,与 `netstat -ano | grep LISTENING | grep -E ':(5173|5174|5179) '` 的实测一致(当前环境可能有残留 dev 在跑,如实显示 true 即正确;`Get-NetTCPConnection` 无命中时 Running=false、Pids 空、不报错)。

**任务完成标准:** status 输出与 netstat 实测一致。

---

### Task 2: 启停核心(CLI start / stop / restart)

**Files:**
- Modify: `d:\claudex\scripts\dev-manager\dev-manager.ps1`(在 `Invoke-CliStatus` 后插入三个函数,并在 `switch` 中接上 start/stop/restart 分支)

**Interfaces:**
- Produces: `Start-ClaudexDev` → 启动失败(端口被占)时 `Write-Host "OCCUPIED"` 并返回 `$false`,成功返回 `$true`;`Stop-ClaudexDev` → 杀了任何进程返回 `$true`,无进程返回 `$false`;`Restart-ClaudexDev` → `$true/$false`(最终状态)。
- Consumes: `Get-ClaudexStatus`、`$RootDir`、`$script:RootPid`。

- [ ] **Step 1: 追加启动/停止/重启函数**

在 `Invoke-CliStatus` 函数之后插入:

```powershell
function Start-ClaudexDev {
  $st = Get-ClaudexStatus
  if ($st.Running) {
    Write-Host 'OCCUPIED: port 5173/5174/5179 already in use; run stop first'
    return $false
  }
  $p = Start-Process -FilePath $env:ComSpec -ArgumentList '/c', 'pnpm dev > NUL 2>&1' `
    -WorkingDirectory $RootDir -WindowStyle Hidden -PassThru
  $script:RootPid = $p.Id
  Write-Host ("STARTED rootPid={0}" -f $p.Id)
  return $true
}

function Stop-ClaudexDev {
  $killed = @()
  if ($script:RootPid) {
    if (Get-Process -Id $script:RootPid -ErrorAction SilentlyContinue) {
      & taskkill /PID $script:RootPid /T /F 2>$null | Out-Null
      $killed += $script:RootPid
    }
    $script:RootPid = $null
  }
  $st = Get-ClaudexStatus
  foreach ($pid in $st.Pids) {
    if (Get-Process -Id $pid -ErrorAction SilentlyContinue) {
      & taskkill /PID $pid /T /F 2>$null | Out-Null
      $killed += $pid
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
```

`switch` 补分支:

```powershell
  'start'   { Start-ClaudexDev }
  'stop'    { Stop-ClaudexDev }
  'restart' { Restart-ClaudexDev }
```

- [ ] **Step 2: BOM 归一 + 语法检查**

先跑 Task 1 Step 2 的 BOM 命令;然后语法检查(PS 无独立 lint,靠解析):

```bash
powershell -NoProfile -Command "$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('d:\claudex\scripts\dev-manager\dev-manager.ps1',[ref]$null,[ref]$e); if($e){$e|%{$_.Message}; exit 1}else{'PARSE OK'}"
```

期望:`PARSE OK`

- [ ] **Step 3: 清理残留 + 端到端启停验证**

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File 'd:\claudex\scripts\dev-manager\dev-manager.ps1' -Command stop
powershell -NoProfile -ExecutionPolicy Bypass -File 'd:\claudex\scripts\dev-manager\dev-manager.ps1' -Command start
sleep 8
netstat -ano | grep LISTENING | grep -E ':(5173|5174|5179) '
```

期望:stop 先清掉可能存在的残留(输出 KILLED … 或 NOTHING);start 输出 STARTED rootPid=…;8 秒后三个端口都在监听(server 冷启动可能需要更久,若 5179 未起再等 5 秒)。

- [ ] **Step 4: 验证停止全树杀净**

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File 'd:\claudex\scripts\dev-manager\dev-manager.ps1' -Command stop
sleep 2
netstat -ano | grep LISTENING | grep -E ':(5173|5174|5179) ' || echo 'PORTS ALL FREE'
tasklist | grep -E 'node|vite' | grep -i claudex || true
```

期望:`PORTS ALL FREE`;且 `tasklist` 中无残留 node(对照法:记录 start 前后 node 进程数,stop 后应与 start 前持平)。用 wmic 验证无 node 的命令行含 claudex 或 dev.mjs:
```bash
wmic process where "name='node.exe'" get ProcessId,CommandLine 2>/dev/null | grep -iE 'claudex|vite|dev\.mjs|src/index\.ts' || echo 'NO CLAUDEX NODE LEFT'
```
期望:`NO CLAUDEX NODE LEFT`

- [ ] **Step 5: 验证 restart**

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File 'd:\claudex\scripts\dev-manager\dev-manager.ps1' -Command restart
sleep 8
netstat -ano | grep LISTENING | grep -E ':(5173|5174|5179) '
```

期望:三端口重新全活。验证完执行一次 stop 清场,保持环境干净。

**任务完成标准:** start 三端口活、stop 全树无残留、restart 能重活;全流程 CLI 输出与预期一致。

---

### Task 3: 最小窗口壳 + 双击入口(.cmd)+ BOM 中文验证

**Files:**
- Create: `d:\claudex\启动dev管理器.cmd`
- Modify: `d:\claudex\scripts\dev-manager\dev-manager.ps1`(把 `'gui'` 分支从 Write-Host 换成 `Invoke-Gui` 调用;在文件末尾加最小 GUI 壳)

**Interfaces:**
- Produces: `Invoke-Gui` 函数(GUI 主入口,Task 4/5 往里填);`启动dev管理器.cmd`(双击 = `-Command gui`)。

- [ ] **Step 1: 写入口 .cmd(内容必须纯 ASCII)**

`d:\claudex\启动dev管理器.cmd`:

```bat
@echo off
rem claudex dev manager launcher (double-click this)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev-manager\dev-manager.ps1" -Command gui
```

- [ ] **Step 2: ps1 加最小 GUI 壳(验证中文 + BOM + cmd 链路)**

在文件末尾替换 `switch` 的 gui 分支为调用,并追加:

```powershell
  'gui'    { Invoke-Gui }
```

```powershell
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Invoke-Gui {
  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'claudex dev 管理器(骨架)'
  $form.Size = New-Object System.Drawing.Size(420, 160)
  $form.StartPosition = 'CenterScreen'

  $label = New-Object System.Windows.Forms.Label
  $label.Text = '中文渲染测试:启动 dev / 停止 dev / 托盘'
  $label.AutoSize = $true
  $label.Location = New-Object System.Drawing.Point(16, 20)
  $form.Controls.Add($label)

  $form.Add_Shown({ $form.Activate() })
  [System.Windows.Forms.Application]::Run($form)
}
```

- [ ] **Step 3: BOM 归一 + 解析检查**(复用 Task 2 Step 2 的两条命令,期望同上)

- [ ] **Step 4: 验证双击入口**

双击 `d:\claudex\启动dev管理器.cmd`,期望:弹出窗口,标题「claudex dev 管理器(骨架)」,**中文无乱码**(若乱码 = BOM 丢了,重跑 BOM 归一后重试)。关闭窗口,脚本退出,无残留 PowerShell。

**任务完成标准:** 双击 cmd → 中文正确的窗口;进程结束后系统无残留。

---

### Task 4: 完整主窗口(状态行 + 按钮 + 轮询 + 双开互斥)

**Files:**
- Modify: `d:\claudex\scripts\dev-manager\dev-manager.ps1`(重写 `Invoke-Gui`;新增 `$script:ReallyQuit` 标志;`-Command` 的 CLI 分支不受影响)

**Interfaces:**
- Consumes: `Get-ClaudexStatus` / `Start-ClaudexDev` / `Stop-ClaudexDev` / `Restart-ClaudexDev` / `$script:RootPid` / `$Ports`
- Produces: GUI 全局状态 `$script:ReallyQuit`(Task 5 退出流程用);按钮事件处理器名字(`On-Start`、`On-Stop`、`On-Restart`、`On-OpenMain`、`On-OpenFiles`、`On-HideToTray`、`On-Exit`——Task 5 托盘菜单复用同一批)。

- [ ] **Step 1: 重写 Invoke-Gui 为完整窗口**

替换 `Invoke-Gui` 函数整体(保留 Task 3 的 Add-Type 行于文件顶部):

```powershell
$script:ReallyQuit = $false
$script:StatusTimer = $null
$script:Tray = $null          # Task 5 赋值
$script:TrayHintShown = $false

function Invoke-Gui {
  # 双开互斥:第二个实例直接提示退出
  $script:Mutex = New-Object System.Threading.Mutex($false, 'claudex-dev-manager-single')
  if (-not $script:Mutex.WaitOne(0)) {
    [System.Windows.Forms.MessageBox]::Show('dev 管理器已在运行。', 'claudex dev 管理器', 'OK', 'Information') | Out-Null
    return
  }

  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'claudex dev 管理器'
  $form.FormBorderStyle = 'FixedSingle'
  $form.MaximizeBox = $false
  $form.Size = New-Object System.Drawing.Size(460, 200)
  $form.StartPosition = 'CenterScreen'
  $form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)

  # 状态区
  $stateLabel = New-Object System.Windows.Forms.Label
  $stateLabel.Text = '检查中…'
  $stateLabel.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10, [System.Drawing.FontStyle]::Bold)
  $stateLabel.AutoSize = $true
  $stateLabel.Location = New-Object System.Drawing.Point(16, 16)
  $form.Controls.Add($stateLabel)

  $portsLabel = New-Object System.Windows.Forms.Label
  $portsLabel.Text = ''
  $portsLabel.AutoSize = $true
  $portsLabel.Location = New-Object System.Drawing.Point(16, 44)
  $form.Controls.Add($portsLabel)

  # 按钮行(两行:操作 / 链接)
  function New-Btn([string]$text, [int]$x, [int]$y, [int]$w) {
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $text; $b.Location = New-Object System.Drawing.Point($x, $y)
    $b.Size = New-Object System.Drawing.Size($w, 30)
    return $b
  }
  $btnStart = New-Btn '启动 dev' 16 80 88
  $btnStop  = New-Btn '停止 dev' 110 80 88
  $btnRe    = New-Btn '重启 dev' 204 80 88
  $btnMain  = New-Btn '打开主站' 298 80 120
  $btnFiles = New-Btn '打开文件站' 16 120 120
  $btnHide  = New-Btn '缩到托盘' 142 120 90
  $btnExit  = New-Btn '退出' 238 120 90
  foreach ($b in @($btnStart,$btnStop,$btnRe,$btnMain,$btnFiles,$btnHide,$btnExit)) {
    $form.Controls.Add($b)
  }

  function Update-StatusUI {
    $st = Get-ClaudexStatus
    $portsText = (($Ports | ForEach-Object { "{0}: {1}" -f $_, $(if ($st.Ports[$_]) { '运行中' } else { '已停止' }) }) -join '   ')
    $portsLabel.Text = $portsText
    if ($st.Running) {
      $stateLabel.Text = '状态:● 运行中'
      $stateLabel.ForeColor = [System.Drawing.Color]::ForestGreen
    } else {
      $stateLabel.Text = '状态:○ 已停止'
      $stateLabel.ForeColor = [System.Drawing.Color]::Gray
    }
    $btnStart.Enabled = -not $st.Running
    $btnStop.Enabled  = $st.Running
    $btnRe.Enabled    = $st.Running
    Update-TrayState $st   # Task 5 之前为空实现占位(见 Step 3)
  }

  $btnStart.Add_Click({
    if ((Get-ClaudexStatus).Running) { return }
    Start-ClaudexDev | Out-Null
    Update-StatusUI
    Start-WatchStartup
  })
  $btnStop.Add_Click({
    Stop-ClaudexDev | Out-Null
    Update-StatusUI
  })
  $btnRe.Add_Click({
    if (-not (Get-ClaudexStatus).Running) { return }
    $btnRe.Enabled = $false
    Restart-ClaudexDev | Out-Null
    Update-StatusUI
    Start-WatchStartup
  })
  $btnMain.Add_Click({ [System.Diagnostics.Process]::Start('http://localhost:5173') | Out-Null })
  $btnFiles.Add_Click({ [System.Diagnostics.Process]::Start('http://localhost:5174') | Out-Null })
  $btnHide.Add_Click({ $form.Hide() | Out-Null; Show-TrayHint })
  $btnExit.Add_Click({ Exit-Manager })

  # 状态轮询 2s
  $script:StatusTimer = New-Object System.Windows.Forms.Timer
  $script:StatusTimer.Interval = 2000
  $script:StatusTimer.Add_Tick({ Update-StatusUI })
  $script:StatusTimer.Start()

  Update-StatusUI
  $form.Add_Shown({ $form.Activate() })
  $form.Add_FormClosing({
    param($s, $e)
    if (-not $script:ReallyQuit) { $e.Cancel = $true; $form.Hide() | Out-Null; Show-TrayHint }
  })
  [System.Windows.Forms.Application]::Run($form)
}
```

- [ ] **Step 2: 追加空实现占位函数(本任务即可运行)**

在 `Invoke-Gui` 后追加(本任务保持空体,Tick 引用不报错;Task 5 填真):

```powershell
function Update-TrayState { param($st) }        # 占位:Task 5 实现
function Show-TrayHint { }                       # 占位:Task 5 实现
function Start-WatchStartup { }                  # 占位:Task 6 实现
function Exit-Manager {                          # Task 5 补退出确认;当前直接退
  $script:ReallyQuit = $true
  if ($script:StatusTimer) { $script:StatusTimer.Stop() }
  if ($form) { $form.Close() }                   # $form 在 Invoke-Gui 作用域内可访问
}
```

注意:`$form` 是 `Invoke-Gui` 的局部变量,而 `Update-StatusUI` 等嵌套函数定义在其内(脚本级函数如 `Exit-Manager` 定义在 `Invoke-Gui` 外则访问不到 `$form`)——**因此 `Exit-Manager` 必须定义在 `Invoke-Gui` 函数体内**。把 Step 1 代码中 `$btnExit.Add_Click({ Exit-Manager })` 与 Step 2 的 `function Exit-Manager` 一起放进 `Invoke-Gui` 内部(即 Step 2 追加的占位函数中,`Exit-Manager` 与 `Update-StatusUI` 同级、都在 `Invoke-Gui` 内;`Update-TrayState`/`Show-TrayHint`/`Start-WatchStartup` 无窗体依赖,可放脚本级)。

- [ ] **Step 3: BOM 归一 + 解析检查**(复用 Task 2 Step 2 两条命令)

- [ ] **Step 4: 手动验证窗口**

双击入口,逐项核对:
1. 窗口标题「claudex dev 管理器」,中文不乱码。
2. 初始状态反映实况(当前已 stop 清场 → 「○ 已停止」,三端口「已停止」,启动按钮亮、停止/重启灰)。
3. 点「启动 dev」→ 2 秒内状态转「● 运行中」,三端口逐一亮起(server 冷启动可能晚几秒),启动/停止按钮互斥切换。
4. 点「停止 dev」→ 转「○ 已停止」;wmic 确认无 node 残留(命令见 Task 2 Step 4)。
5. 点「重启 dev」→ 停止后自动再起,最终全活;再点「停止」清场。
6. 「打开主站/打开文件站」→ 默认浏览器开对应端口。
7. 「缩到托盘」→ 窗口消失(本任务托盘未实现,窗口暂时不可恢复——**验证完此项后请点「退出」关掉,不要点 ✕**);✕ 按钮当前行为=隐藏+无托盘,等同不可恢复,同样只能「退出」结束。这是 Task 5 前的已知临时状态。
8. 窗口开着时再双击一次入口 → 弹「dev 管理器已在运行」,第二个窗口不出现。

**任务完成标准:** 窗口状态/按钮/启停全部正确;双开互斥生效。

---

### Task 5: 托盘(图标 + 菜单 + 缩托盘 + 退出确认)

**Files:**
- Modify: `d:\claudex\scripts\dev-manager\dev-manager.ps1`

**Interfaces:**
- Consumes: `$script:Tray`、`$script:TrayHintShown`、`$script:ReallyQuit`、`Update-TrayState $st`、`Show-TrayHint`、`Exit-Manager`、`$form`(Invoke-Gui 内)。

- [ ] **Step 1: 图标绘制 + 托盘创建**

在 `Invoke-Gui` 内、`$form` 创建后插入托盘初始化;并实现脚本级 `New-TrayIcons`/`Update-TrayState`/`Show-TrayHint`:

```powershell
function New-TrayIcon([bool]$running) {
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
```

Invoke-Gui 内(按钮事件之后):

```powershell
  $script:IconRunning = New-TrayIcon $true
  $script:IconStopped = New-TrayIcon $false
  $script:LastRunning = $null

  $script:Tray = New-Object System.Windows.Forms.NotifyIcon
  $script:Tray.Icon = $script:IconStopped
  $script:Tray.Text = 'claudex dev 管理器'
  $script:Tray.Visible = $true

  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  foreach ($item in @(
      @{ T = '启动 dev';    A = { $btnStart.PerformClick() } },
      @{ T = '停止 dev';    A = { $btnStop.PerformClick() } },
      @{ T = '重启 dev';    A = { $btnRe.PerformClick() } },
      @{ T = '打开主站';    A = { $btnMain.PerformClick() } },
      @{ T = '打开文件站';  A = { $btnFiles.PerformClick() } }
    )) {
    $mi = New-Object System.Windows.Forms.ToolStripMenuItem($item.T)
    # .GetNewClosure() 必须:foreach 的 $item 是引用,不加则所有菜单项
    # 事件触发时读到循环结束后的最后一个 $item(PowerShell 闭包坑)
    $mi.Add_Click(({ param($s2, $e2) & $item.A }.GetNewClosure()))
    [void]$menu.Items.Add($mi)
  }
  [void]$menu.Items.Add(New-Object System.Windows.Forms.ToolStripSeparator)
  $miExit = New-Object System.Windows.Forms.ToolStripMenuItem('退出')
  $miExit.Add_Click({ Exit-Manager })
  [void]$menu.Items.Add($miExit)
  $script:Tray.ContextMenuStrip = $menu
  $script:Tray.Add_DoubleClick({ $form.Show() | Out-Null; $form.WindowState = 'Normal'; $form.Activate() })
```

脚本级(Invoke-Gui 外)实现:

```powershell
function Update-TrayState {
  param($st)
  if ($script:LastRunning -eq $st.Running) { return }
  $script:LastRunning = $st.Running
  if ($st.Running) {
    $script:Tray.Icon = $script:IconRunning
    $script:Tray.Text = 'claudex dev 管理器 — 运行中'
  } else {
    $script:Tray.Icon = $script:IconStopped
    $script:Tray.Text = 'claudex dev 管理器 — 已停止'
  }
}

function Show-TrayHint {
  if ($script:TrayHintShown) { return }
  $script:TrayHintShown = $true
  $script:Tray.ShowBalloonTip(2500, 'claudex dev 管理器', '已最小化到托盘:右键图标操作,双击图标恢复窗口。', [System.Windows.Forms.ToolTipIcon]::Info)
}
```

把 `Update-TrayState` 从 Task 4 的占位(在 Invoke-Gui 内)移到脚本级,并删掉占位空体。

- [ ] **Step 2: 补全 Exit-Manager(退出确认)**

`Invoke-Gui` 内,替换 Task 4 的 `Exit-Manager`:

```powershell
function Exit-Manager {
  $st = Get-ClaudexStatus
  if ($st.Running) {
    $r = [System.Windows.Forms.MessageBox]::Show(
      'dev 正在运行,退出将同时停止 dev。继续?',
      'claudex dev 管理器', 'YesNo', 'Question', 'Button2')
    if ($r -ne 'Yes') { return }
    Stop-ClaudexDev | Out-Null
  }
  $script:ReallyQuit = $true
  if ($script:StatusTimer) { $script:StatusTimer.Stop() }
  if ($script:Tray) { $script:Tray.Visible = $false }
  $form.Close()
}
```

- [ ] **Step 3: BOM 归一 + 解析检查**(复用 Task 2 Step 2 两条命令)

- [ ] **Step 4: 手动验证托盘**

1. 双击入口 → 窗口 + 托盘图标(灰)出现。
2. 点「缩到托盘」/点窗口 ✕ → 窗口消失、托盘图标仍在;托盘气泡提示出现一次。
3. 左键双击托盘图标 → 窗口恢复。
4. 托盘右键 → 菜单项齐全;「启动 dev」→ 图标变绿,Tooltip 变「运行中」;等 8 秒三端口活。
5. 托盘右键「停止 dev」→ 图标变灰;wmic 确认无残留(命令见 Task 2 Step 4)。
6. 托盘「打开主站/打开文件站」→ 浏览器打开。
7. 托盘「退出」(dev 未跑)→ 直接退出,托盘图标消失,无残留 PowerShell。
8. 再启动一遍 dev,托盘「退出」→ 弹确认框 → 选「否」→ 不退出;再选「是」→ dev 全停 + 管理器退出,系统零残留(验证 wmic 与 tasklist)。

**任务完成标准:** 托盘生命周期完整:缩入/唤回/状态变色/菜单操作/退出即清场。

---

### Task 6: 启动失败检测 + 端到端验收

**Files:**
- Modify: `d:\claudex\scripts\dev-manager\dev-manager.ps1`

**Interfaces:**
- Consumes: `Start-WatchStartup`(Task 4 占位,本任务实装)、`Get-ClaudexStatus`、`$script:Tray`。

- [ ] **Step 1: 实现启动后 5 秒探测**

脚本级替换 Task 4 占位:

```powershell
function Start-WatchStartup {
  $t = New-Object System.Windows.Forms.Timer
  $t.Interval = 5000
  $t.Add_Tick({
    $t.Stop()
    if (-not (Get-ClaudexStatus).Running) {
      if ($script:Tray) {
        $script:Tray.ShowBalloonTip(4000, 'claudex dev 管理器',
          '启动失败:三个端口都未监听。请手动在终端运行 pnpm dev 查看报错。',
          [System.Windows.Forms.ToolTipIcon]::Warning)
      } else {
        [System.Windows.Forms.MessageBox]::Show(
          '启动失败:三个端口都未监听。请手动在终端运行 pnpm dev 查看报错。',
          'claudex dev 管理器', 'OK', 'Warning') | Out-Null
      }
    }
  })
  $t.Start()
}
```

- [ ] **Step 2: BOM 归一 + 解析检查**(复用 Task 2 Step 2 两条命令)

- [ ] **Step 3: 端到端验收(对照设计文档验证清单 9 项)**

顺序执行(双击入口操作 GUI 部分,CLI 部分用 -Command):
1. 双击入口 → 窗口出现、中文无乱码。
2. 「启动 dev」→ 状态转绿、三端口活、浏览器可达(手动开 5173/5174)。
3. 任务管理器核对进程树:cmd(树根)→ pnpm → server + 双 vite。
4. 「停止 dev」→ 树全消(任务管理器 + wmic 双确认)。
5. 「重启 dev」→ 停止后自动再起,全活;停掉。
6. ✕ → 缩托盘 → 双击托盘唤回。
7. 启动 dev 后托盘「退出」→ 确认框 → 是 → dev 停 + 管理器退 + 零残留。
8. 残留模拟:手动在终端跑 `pnpm dev`,直接关终端留孤儿 → 管理器显示「运行中」→ 点「停止」→ 残留被清(验证兜底反查路径)。
9. 二次双击 → 提示已在运行。

**任务完成标准:** 设计文档验证清单 1–9 全过。

---

### Task 7: 收尾文档

**Files:**
- Modify: `d:\claudex\docs\superpowers\specs\2026-09-08-dev-manager-design.md`(附注区改为已验证)

- [ ] **Step 1: 更新设计文档状态**

把文档头部 `状态:已获用户批准` 更新为:

```markdown
状态:已实现并通过端到端验收(2026-09-08)
```

- [ ] **Step 2: 给用户交付说明**

整理一段中文说明(回复用户,不写文件):入口文件路径、双击用法、按钮/托盘操作、退出语义、CLI 三命令(status/start/stop/restart)及适用场景、不同步 Mac 的建议。

**任务完成标准:** 文档状态更新;交付说明讲清用法。
