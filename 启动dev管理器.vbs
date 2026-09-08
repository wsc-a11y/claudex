' claudex dev manager launcher (double-click this, no console window)
' Hidden-window start: 0 = hidden. The manager GUI appears on its own;
' nothing here stays open, so there is no console window to kill it by.
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = base & "\scripts\dev-manager\dev-manager.ps1"
CreateObject("WScript.Shell").Run "powershell -NoProfile -ExecutionPolicy Bypass -File """ & ps1 & """ -Command gui", 0, False
