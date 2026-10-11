"""Reads the Windows settings that the settings lock (handoff section 4) depends on, so the server
can refuse to record when something has drifted from data/setup.json. Read-only; never writes."""
from __future__ import annotations

import sys


def _reg(path: str, name: str):
    import winreg

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path) as key:
            return winreg.QueryValueEx(key, name)[0]
    except OSError:
        return None


def _display() -> dict:
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    gdi32 = ctypes.windll.gdi32
    shcore = ctypes.windll.shcore

    user32.GetDC.restype = wintypes.HDC
    user32.GetDC.argtypes = [wintypes.HWND]
    user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
    gdi32.GetDeviceCaps.argtypes = [wintypes.HDC, ctypes.c_int]
    user32.SetThreadDpiAwarenessContext.restype = ctypes.c_void_p
    user32.SetThreadDpiAwarenessContext.argtypes = [ctypes.c_void_p]
    user32.MonitorFromPoint.restype = ctypes.c_void_p
    user32.MonitorFromPoint.argtypes = [wintypes.POINT, wintypes.DWORD]
    shcore.GetDpiForMonitor.argtypes = [ctypes.c_void_p, ctypes.c_int,
                                        ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint)]

    out: dict = {}
    hdc = user32.GetDC(None)
    try:
        out["resolution"] = [gdi32.GetDeviceCaps(hdc, 118), gdi32.GetDeviceCaps(hdc, 117)]  # DESKTOPHORZRES/VERTRES
        out["refresh_hz"] = gdi32.GetDeviceCaps(hdc, 116)  # VREFRESH
    finally:
        user32.ReleaseDC(None, hdc)

    # Per-monitor DPI of the primary monitor, queried with a per-monitor-aware thread context.
    prev = user32.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4))
    try:
        hmon = user32.MonitorFromPoint(wintypes.POINT(0, 0), 1)
        dx, dy = ctypes.c_uint(), ctypes.c_uint()
        if shcore.GetDpiForMonitor(hmon, 0, ctypes.byref(dx), ctypes.byref(dy)) == 0:
            out["scaling_percent"] = round(dx.value * 100 / 96)
    finally:
        if prev:
            user32.SetThreadDpiAwarenessContext(ctypes.c_void_p(prev))
    return out


def read() -> dict:
    """Current settings, in the same shape as the matching fields of data/setup.json."""
    if sys.platform != "win32":
        return {}
    mouse = r"Control Panel\Mouse"
    speed = _reg(mouse, "MouseSpeed")
    sens = _reg(mouse, "MouseSensitivity")
    cursor_size = _reg(r"Control Panel\Cursors", "CursorBaseSize")
    out = {
        "pointer_speed": int(sens) if sens is not None else None,
        "enhance_pointer_precision": (str(speed) != "0") if speed is not None else None,
        "cursor_size": int(cursor_size) if cursor_size is not None else 32,
        "arrow_cursor": _reg(r"Control Panel\Cursors", "Arrow") or "",
    }
    try:
        out.update(_display())
    except OSError:
        pass
    return out


def drift(setup: dict, current: dict | None = None) -> list[str]:
    """Human-readable differences between setup.json and the live Windows settings."""
    current = read() if current is None else current
    if not current:
        return []
    checks = [
        ("windows.pointer_speed", setup.get("windows", {}).get("pointer_speed"), current.get("pointer_speed")),
        ("windows.enhance_pointer_precision", setup.get("windows", {}).get("enhance_pointer_precision"),
         current.get("enhance_pointer_precision")),
        ("windows.cursor_size", setup.get("windows", {}).get("cursor_size"), current.get("cursor_size")),
        ("display.resolution", setup.get("display", {}).get("resolution"), current.get("resolution")),
        ("display.refresh_hz", setup.get("display", {}).get("refresh_hz"), current.get("refresh_hz")),
        ("display.scaling_percent", setup.get("display", {}).get("scaling_percent"), current.get("scaling_percent")),
    ]
    problems = []
    for name, want, have in checks:
        if want is None or have is None:
            continue
        differs = list(want) != list(have) if isinstance(want, (list, tuple)) else want != have
        if differs:
            problems.append(f"{name} is {have} in Windows but {want} in setup.json")
    return problems


if __name__ == "__main__":
    import json

    print(json.dumps(read(), indent=2))
