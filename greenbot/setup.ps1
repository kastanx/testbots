<#
    Creates greenbot\.venv and installs the ML stack.

    Order matters: CUDA torch comes from the pytorch index FIRST. Installing
    ultralytics first pulls the CPU build of torch as a dependency and the
    4070 sits idle.

        powershell -ExecutionPolicy Bypass -File .\setup.ps1
#>
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
Push-Location $root

try {
    # --- locate Python 3.11 -------------------------------------------------
    $python = $null
    if (Get-Command py -ErrorAction SilentlyContinue) {
        & py -3.11 --version *> $null
        if ($LASTEXITCODE -eq 0) { $python = @("py", "-3.11") }
    }
    if (-not $python) {
        $candidate = Join-Path $env:LOCALAPPDATA "Programs\Python\Python311\python.exe"
        if (Test-Path $candidate) { $python = @($candidate) }
    }
    if (-not $python) {
        throw "Python 3.11 not found. Install it with: winget install -e --id Python.Python.3.11"
    }
    Write-Host "python: $($python -join ' ')" -ForegroundColor Cyan

    # --- venv ---------------------------------------------------------------
    $venvPy = Join-Path $root ".venv\Scripts\python.exe"
    if (-not (Test-Path $venvPy)) {
        Write-Host "creating .venv ..." -ForegroundColor Cyan
        & $python[0] $python[1..($python.Length - 1)] -m venv .venv
        if ($LASTEXITCODE -ne 0) { throw "venv creation failed" }
    }
    else {
        Write-Host ".venv already exists - reusing it" -ForegroundColor DarkGray
    }

    & $venvPy -m pip install --upgrade pip --quiet
    if ($LASTEXITCODE -ne 0) { throw "pip upgrade failed" }

    # --- CUDA torch, then everything else -----------------------------------
    Write-Host "installing torch (cu124) - this is the big one ..." -ForegroundColor Cyan
    & $venvPy -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124
    if ($LASTEXITCODE -ne 0) { throw "torch install failed" }

    Write-Host "installing ultralytics + service deps ..." -ForegroundColor Cyan
    & $venvPy -m pip install -r (Join-Path $root "server\requirements.txt")
    if ($LASTEXITCODE -ne 0) { throw "requirements install failed" }

    # --- verify -------------------------------------------------------------
    Write-Host "`nverifying ..." -ForegroundColor Cyan
    & $venvPy -c @"
import torch, ultralytics, cv2, numpy, fastapi, uvicorn, yaml
ok = torch.cuda.is_available()
print('torch      ', torch.__version__)
print('ultralytics', ultralytics.__version__)
print('opencv     ', cv2.__version__)
print('numpy      ', numpy.__version__)
print('fastapi    ', fastapi.__version__)
print('CUDA       ', ok, torch.cuda.get_device_name(0) if ok else '(no GPU visible)')
raise SystemExit(0 if ok else 1)
"@
    if ($LASTEXITCODE -ne 0) {
        Write-Host "`nCUDA is NOT available. Training will fall back to the CPU." -ForegroundColor Yellow
        Write-Host "Update the GeForce driver, then re-run this script." -ForegroundColor Yellow
    }
    else {
        Write-Host "`nReady. Activate with: .\.venv\Scripts\Activate.ps1" -ForegroundColor Green
    }
}
finally {
    Pop-Location
}
