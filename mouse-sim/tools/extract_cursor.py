"""Save the Windows arrow cursor as a PNG with its hotspot, at the size Windows draws it (cursor
scheme, pointer size and display scaling), so the simulator can draw the owner's real cursor.

    python -m tools.extract_cursor [--out models/export]

Renders the cursor on black and on white and derives the alpha channel from the difference.
Read-only towards Windows; writes cursor.png + cursor.json.
"""
from __future__ import annotations

import argparse
import ctypes
import json
import os
import struct
import sys
import zlib
from ctypes import wintypes
from pathlib import Path

from pipeline import paths, winsettings


def _png(path: Path, w: int, h: int, rgba: bytes) -> None:
    raw = b"".join(b"\x00" + rgba[y * w * 4:(y + 1) * w * 4] for y in range(h))

    def chunk(kind, data):
        c = struct.pack(">I", len(data)) + kind + data
        return c + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


class ICONINFO(ctypes.Structure):
    _fields_ = [("fIcon", wintypes.BOOL), ("xHotspot", wintypes.DWORD), ("yHotspot", wintypes.DWORD),
                ("hbmMask", wintypes.HBITMAP), ("hbmColor", wintypes.HBITMAP)]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG), ("biHeight", wintypes.LONG),
                ("biPlanes", wintypes.WORD), ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", wintypes.LONG),
                ("biYPelsPerMeter", wintypes.LONG), ("biClrUsed", wintypes.DWORD), ("biClrImportant", wintypes.DWORD)]


def extract(out_dir: Path) -> dict:
    user32, gdi32 = ctypes.windll.user32, ctypes.windll.gdi32
    user32.SetThreadDpiAwarenessContext.restype = ctypes.c_void_p
    user32.SetThreadDpiAwarenessContext.argtypes = [ctypes.c_void_p]
    user32.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4))
    settings = winsettings.read()
    scale = (settings.get("scaling_percent") or 100) / 100
    size = int(round((settings.get("cursor_size") or 32) * scale))
    src = os.path.expandvars(settings.get("arrow_cursor") or "")
    user32.LoadImageW.restype = wintypes.HANDLE
    user32.LoadImageW.argtypes = [wintypes.HINSTANCE, wintypes.LPCWSTR, wintypes.UINT, ctypes.c_int, ctypes.c_int, wintypes.UINT]
    if src and Path(src).exists():
        hcur = user32.LoadImageW(None, src, 2, size, size, 0x10)  # IMAGE_CURSOR, LR_LOADFROMFILE
    else:
        hcur = user32.LoadImageW(None, ctypes.cast(ctypes.c_void_p(32512), wintypes.LPCWSTR), 2, size, size, 0x8000)
    if not hcur:
        raise OSError("could not load the arrow cursor")
    info = ICONINFO()
    user32.GetIconInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(ICONINFO)]
    user32.GetIconInfo(hcur, ctypes.byref(info))

    user32.GetDC.restype = wintypes.HDC
    user32.GetDC.argtypes = [wintypes.HWND]
    user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
    gdi32.CreateCompatibleDC.restype = wintypes.HDC
    gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
    gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
    gdi32.DeleteDC.argtypes = [wintypes.HDC]
    hdc_screen = user32.GetDC(None)
    hdc = gdi32.CreateCompatibleDC(hdc_screen)
    bmi = BITMAPINFOHEADER(ctypes.sizeof(BITMAPINFOHEADER), size, -size, 1, 32, 0, 0, 0, 0, 0, 0)
    bits = ctypes.c_void_p()
    gdi32.CreateDIBSection.restype = wintypes.HBITMAP
    gdi32.CreateDIBSection.argtypes = [wintypes.HDC, ctypes.c_void_p, wintypes.UINT, ctypes.POINTER(ctypes.c_void_p),
                                       wintypes.HANDLE, wintypes.DWORD]
    hbmp = gdi32.CreateDIBSection(hdc, ctypes.byref(bmi), 0, ctypes.byref(bits), None, 0)
    gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
    gdi32.SelectObject(hdc, hbmp)
    user32.DrawIconEx.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int, wintypes.HANDLE, ctypes.c_int, ctypes.c_int,
                                  wintypes.UINT, wintypes.HBRUSH, wintypes.UINT]
    n = size * size * 4

    def render(fill: int) -> bytes:
        ctypes.memset(bits, fill, n)
        user32.DrawIconEx(hdc, 0, 0, hcur, size, size, 0, None, 3)  # DI_NORMAL
        return ctypes.string_at(bits, n)

    black, white = render(0), render(255)
    rgba = bytearray(n)
    for i in range(0, n, 4):
        b0, g0, r0 = black[i], black[i + 1], black[i + 2]
        b1, g1, r1 = white[i], white[i + 1], white[i + 2]
        a = 255 - max(r1 - r0, g1 - g0, b1 - b0)
        a = min(max(a, 0), 255)
        if a:
            rgba[i:i + 4] = bytes([min(255, r0 * 255 // a), min(255, g0 * 255 // a), min(255, b0 * 255 // a), a])
    gdi32.DeleteObject(hbmp)
    gdi32.DeleteDC(hdc)
    user32.ReleaseDC(None, hdc_screen)
    out_dir.mkdir(parents=True, exist_ok=True)
    _png(out_dir / "cursor.png", size, size, bytes(rgba))
    meta = {"hotspot": [int(info.xHotspot), int(info.yHotspot)], "size": size, "source": src or "system arrow",
            "scaling_percent": round(scale * 100)}
    (out_dir / "cursor.json").write_text(json.dumps(meta, indent=2))
    return meta


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(paths.EXPORT))
    args = ap.parse_args()
    if sys.platform != "win32":
        raise SystemExit("Windows only")
    print(extract(Path(args.out)))


if __name__ == "__main__":
    main()
