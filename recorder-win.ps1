# Windows global hotkey monitor.
#
# Drop-in replacement for the macOS Swift/CGEventTap monitor (recorder.swift).
# Speaks the exact same line protocol on stdout, one token per line:
#   READY | r | s | p | space | q | l
#
# Uses GetAsyncKeyState polling rather than a WH_KEYBOARD_LL hook: no message
# pump, no native module, no admin rights, and it observes keys system-wide
# regardless of which window has focus (same as the CGEventTap did).

param(
    [int]$ParentPid = 0,
    [int]$PollMs = 15
)

$ErrorActionPreference = 'Stop'

Add-Type -Namespace ClickRecorder -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern short GetAsyncKeyState(int vKey);
'@

function Write-Token($text) {
    [Console]::Out.WriteLine($text)
    [Console]::Out.Flush()
}

Write-Token "DEBUG: Launching recorder (Win32 GetAsyncKeyState)..."

# Virtual-key code -> token emitted on stdout.
# Must be a plain hashtable, NOT [ordered]: indexing an OrderedDictionary with
# an integer looks up by *position*, so $KEYS[0x52] would silently return $null.
$KEYS = @{
    0x52 = 'r'      # R
    0x53 = 's'      # S
    0x50 = 'p'      # P
    0x20 = 'space'  # SPACE
    0x51 = 'q'      # Q
    0x4C = 'l'      # L
}

# Modifiers that suppress the hotkey. Ctrl+S / Ctrl+R / Ctrl+P / Ctrl+L are
# save/reload/print/address-bar everywhere on Windows, so firing on those would
# start recordings by accident. Shift is deliberately NOT in this list.
$MODIFIERS = @(0x11, 0x12, 0x5B, 0x5C)  # CTRL, ALT, LWIN, RWIN

$KEY_DOWN = 0x8000

function Test-KeyDown($vKey) {
    return ([ClickRecorder.Native]::GetAsyncKeyState($vKey) -band $KEY_DOWN) -ne 0
}

$wasDown = @{}
foreach ($vk in $KEYS.Keys) { $wasDown[$vk] = $false }

Write-Token "READY"

# Re-check that the Node parent is alive roughly once a second so this process
# never outlives it as an orphan holding the keyboard.
$parentCheckEvery = [Math]::Max(1, [int](1000 / $PollMs))
$tick = 0

while ($true) {
    $modifierHeld = $false
    foreach ($mod in $MODIFIERS) {
        if (Test-KeyDown $mod) { $modifierHeld = $true; break }
    }

    foreach ($vk in @($KEYS.Keys)) {
        $isDown = Test-KeyDown $vk

        # Rising edge only: one token per physical press, not per poll.
        if ($isDown -and -not $wasDown[$vk] -and -not $modifierHeld) {
            $token = $KEYS[$vk]
            if ($token) {
                try {
                    Write-Token $token
                } catch {
                    # stdout pipe closed: the parent is gone.
                    exit 0
                }
            }
        }

        $wasDown[$vk] = $isDown
    }

    $tick++
    if ($ParentPid -gt 0 -and ($tick % $parentCheckEvery) -eq 0) {
        $parent = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
        if ($null -eq $parent) { exit 0 }
    }

    Start-Sleep -Milliseconds $PollMs
}
