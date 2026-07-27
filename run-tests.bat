@echo off
REM =============================================================================
REM run-tests.bat
REM Launches the Tollgate API test suite.
REM
REM Usage:
REM   run-tests.bat                        (tests http://localhost:3000)
REM   run-tests.bat http://localhost:4000  (custom base URL)
REM =============================================================================

setlocal

if "%~1"=="" (
    set BASE_URL=http://localhost:3000
) else (
    set BASE_URL=%~1
)

echo.
echo ============================================================
echo   Tollgate API Test Suite
echo   Target: %BASE_URL%
echo ============================================================

REM -- Check PowerShell is available
where powershell >nul 2>&1
if errorlevel 1 (
    echo.
    echo [ERROR] PowerShell not found. Install it and retry.
    exit /b 1
)

REM -- Quick check: is the server actually up before handing off to PS?
echo.
echo   Checking server is reachable...
powershell -NoProfile -NonInteractive -Command ^
  "try { $r = Invoke-WebRequest '%BASE_URL%/check/bat-probe' -UseBasicParsing -ErrorAction Stop; exit 0 } catch { $code = $_.Exception.Response.StatusCode.value__; if ($code -eq 429) { exit 0 } else { exit 1 } }" >nul 2>&1

if errorlevel 1 (
    echo.
    echo   [ERROR] Cannot reach %BASE_URL%
    echo.
    echo   Before running tests you need:
    echo.
    echo   1. Redis running on port 6379
    echo      Option A - Docker ^(recommended^):
    echo        docker run -d -p 6379:6379 redis:7
    echo.
    echo      Option B - WSL:
    echo        wsl -- redis-server --daemonize yes
    echo.
    echo      Option C - Windows native:
    echo        Download from https://github.com/tporadowski/redis/releases
    echo        Then: redis-server
    echo.
    echo   2. Tollgate server running:
    echo        npm run dev
    echo.
    echo   Then re-run this batch file.
    echo.
    exit /b 1
)

echo   Server is up. Starting tests...

REM -- Run the PowerShell test suite
powershell -ExecutionPolicy Bypass -NoProfile -NonInteractive ^
    -File "%~dp0Test-Tollgate.ps1" ^
    -BaseUrl "%BASE_URL%"

set EXIT_CODE=%ERRORLEVEL%

echo.
if %EXIT_CODE%==0 (
    echo   All tests passed.
) else (
    echo   One or more tests FAILED. See output above.
)
echo.

endlocal
exit /b %EXIT_CODE%
