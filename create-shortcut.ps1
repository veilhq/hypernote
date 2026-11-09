# Creates the Hypernote desktop shortcut and stamps its AppUserModelID so a
# pinned taskbar icon matches the running window's identity (the app itself
# sets the same ID via SetCurrentProcessExplicitAppUserModelID at startup).
$ws = New-Object -ComObject WScript.Shell
$desktop = [System.Environment]::GetFolderPath("Desktop")
$lnk = "$desktop\Hypernote.lnk"
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = (Get-Command pythonw).Source
$sc.Arguments = "C:\Users\JoshWooten\Documents\REPOS\PORTAL\.hyperspace\.hypernote\hypernote.py"
$sc.WorkingDirectory = "C:\Users\JoshWooten\Documents\REPOS\PORTAL\.hyperspace\.hypernote"
$sc.IconLocation = "C:\Users\JoshWooten\Documents\REPOS\PORTAL\.hyperspace\.hypernote\assets\hypernote.ico,0"
$sc.Save()
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($sc) | Out-Null
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($ws) | Out-Null
[GC]::Collect(); [GC]::WaitForPendingFinalizers()
Start-Sleep -Milliseconds 300
Write-Host "Shortcut created at: $lnk"

# Stamp System.AppUserModel.ID onto the shortcut via the Windows Property System
# (WScript.Shell can't set this; pywin32's propsys can). The ID must match the
# app's SetCurrentProcessExplicitAppUserModelID("Hyper.Hypernote") call so the
# pinned icon and the live window group as one taskbar entry.
$py = @"
import sys
from win32com.propsys import propsys, pscon
from win32com.shell import shellcon
lnk = r'$lnk'
store = propsys.SHGetPropertyStoreFromParsingName(lnk, None, shellcon.GPS_READWRITE, propsys.IID_IPropertyStore)
store.SetValue(pscon.PKEY_AppUserModel_ID, propsys.PROPVARIANTType('Hyper.Hypernote'))
store.Commit()
print('AppUserModelID set: Hyper.Hypernote')
"@
try {
    $py | python -
} catch {
    Write-Host "Note: could not set AppUserModelID (pywin32 missing?) - process-level ID still applies at runtime."
}
