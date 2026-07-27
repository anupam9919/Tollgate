# =============================================================================
# Test-Tollgate.ps1
# Automated API test suite for the Tollgate rate-limiting service.
#
# Usage:
#   .\Test-Tollgate.ps1
#   .\Test-Tollgate.ps1 -BaseUrl "http://localhost:3000"
# =============================================================================

param(
    [string]$BaseUrl = "http://localhost:3000"
)

$script:Passed = 0
$script:Failed = 0
$script:Total = 0

function Write-Header([string]$Title) {
    Write-Host ""
    Write-Host "  $Title" -ForegroundColor Cyan
    Write-Host ("  " + ("-" * ($Title.Length))) -ForegroundColor DarkGray
}

function Pass([string]$Label) {
    $script:Passed++
    $script:Total++
    Write-Host "  [PASS] $Label" -ForegroundColor Green
}

function Fail([string]$Label, [string]$Detail = "") {
    $script:Failed++
    $script:Total++
    Write-Host "  [FAIL] $Label" -ForegroundColor Red
    if ($Detail) {
        Write-Host "         $Detail" -ForegroundColor DarkRed
    }
}

function Skip([string]$Label) {
    Write-Host "  [SKIP] $Label" -ForegroundColor Yellow
}

function Invoke-Api {
    param(
        [string]$Method,
        [string]$Path,
        [object]$Body = $null
    )

    $uri = "$BaseUrl$Path"
    $wArgs = @{
        Uri             = $uri
        Method          = $Method
        UseBasicParsing = $true
        ErrorAction     = "Stop"
    }

    if ($Body) {
        $wArgs.Body = ($Body | ConvertTo-Json -Compress)
        $wArgs.ContentType = "application/json"
    }

    try {
        $resp = Invoke-WebRequest @wArgs
        return [PSCustomObject]@{
            StatusCode = [int]$resp.StatusCode
            Headers    = $resp.Headers
            Body       = ($resp.Content | ConvertFrom-Json -ErrorAction SilentlyContinue)
            Raw        = $resp.Content
        }
    }
    catch [System.Net.WebException] {
        $inner = $_.Exception.Response
        if ($inner) {
            $stream = $inner.GetResponseStream()
            $reader = [System.IO.StreamReader]::new($stream)
            $raw = $reader.ReadToEnd()
            return [PSCustomObject]@{
                StatusCode = [int]$inner.StatusCode
                Headers    = $inner.Headers
                Body       = ($raw | ConvertFrom-Json -ErrorAction SilentlyContinue)
                Raw        = $raw
            }
        }
        Fail "Network error reaching $uri" $_.Exception.Message
        return $null
    }
}

function Assert-Status([PSCustomObject]$Resp, [int]$Expected, [string]$Label) {
    if ($null -eq $Resp) { return }
    if ($Resp.StatusCode -eq $Expected) {
        Pass $Label
    }
    else {
        Fail $Label "Expected HTTP $Expected, got $($Resp.StatusCode) - body: $($Resp.Raw)"
    }
}

function Assert-BodyField([PSCustomObject]$Resp, [string]$Field, $Expected, [string]$Label) {
    if ($null -eq $Resp) { return }
    $actual = $Resp.Body.$Field
    if ($actual -eq $Expected) {
        Pass $Label
    }
    else {
        Fail $Label "Expected $Field=$Expected, got $actual"
    }
}

function Assert-HeaderPresent([PSCustomObject]$Resp, [string]$Header, [string]$Label) {
    if ($null -eq $Resp) { return }
    $val = $Resp.Headers[$Header]
    if ($val) {
        Pass "$Label (value: $val)"
    }
    else {
        Fail $Label "Header '$Header' missing from response"
    }
}

function Assert-HeaderNumeric([PSCustomObject]$Resp, [string]$Header, [string]$Label) {
    if ($null -eq $Resp) { return }
    $val = $Resp.Headers[$Header]
    $num = 0
    if ($val -and [int]::TryParse($val.ToString(), [ref]$num)) {
        Pass "$Label (value: $num)"
    }
    else {
        Fail $Label "Header '$Header' should be numeric, got: '$val'"
    }
}

function Set-ClientConfig {
    param(
        [string]$ClientId,
        [string]$Algorithm,
        [int]$Rps,
        [int]$Burst,
        [int]$Window
    )
    $body = @{
        algorithm        = $Algorithm
        requestPerSecond = $Rps
        burstSize        = $Burst
        windowSize       = $Window
    }
    return Invoke-Api -Method PUT -Path "/admin/clients/$ClientId" -Body $body
}

$Run = [System.DateTime]::UtcNow.ToString("yyyyMMddHHmmss")

# ---------------------------------------------------------------------------
# 0. Server reachability
# ---------------------------------------------------------------------------

Write-Header "0. Server reachability"

$ping = Invoke-Api -Method GET -Path "/check/ping-$Run"
if ($ping -and ($ping.StatusCode -eq 200 -or $ping.StatusCode -eq 429)) {
    Pass "Server is up at $BaseUrl"
}
else {
    Fail "Server is not responding at $BaseUrl"
    Write-Host ""
    Write-Host "  Start the server first:  npm run dev" -ForegroundColor Yellow
    exit 1
}

# ---------------------------------------------------------------------------
# 1. Admin PUT - valid configs
# ---------------------------------------------------------------------------

Write-Header "1. Admin PUT - valid config (token-bucket)"

$cid = "test-tb-$Run"
$r = Set-ClientConfig -ClientId $cid -Algorithm "token-bucket" -Rps 5 -Burst 10 -Window 60000
Assert-Status    $r 200 "Returns 200 for valid token-bucket config"
Assert-BodyField $r "clientId" $cid "Body contains correct clientId"
Assert-BodyField $r "message" "Client configuration updated successfully" "Body has success message"

Write-Header "1b. Admin PUT - valid config (sliding-window)"

$cidSw = "test-sw-$Run"
$r = Set-ClientConfig -ClientId $cidSw -Algorithm "sliding-window" -Rps 3 -Burst 5 -Window 10000
Assert-Status $r 200 "Returns 200 for valid sliding-window config"

# ---------------------------------------------------------------------------
# 2. Admin PUT - invalid bodies (should 400)
# ---------------------------------------------------------------------------

Write-Header "2. Admin PUT - invalid bodies"

$badCases = @(
    @{ label = "Bad algorithm string"; body = @{ algorithm = "bad-algo"; requestPerSecond = 5; burstSize = 10; windowSize = 60000 } },
    @{ label = "Missing algorithm"; body = @{                           requestPerSecond = 5; burstSize = 10; windowSize = 60000 } },
    @{ label = "requestPerSecond = 0"; body = @{ algorithm = "token-bucket"; requestPerSecond = 0; burstSize = 10; windowSize = 60000 } },
    @{ label = "Negative burstSize"; body = @{ algorithm = "token-bucket"; requestPerSecond = 5; burstSize = -1; windowSize = 60000 } },
    @{ label = "windowSize = 0"; body = @{ algorithm = "token-bucket"; requestPerSecond = 5; burstSize = 10; windowSize = 0 } },
    @{ label = "String rps value"; body = @{ algorithm = "token-bucket"; requestPerSecond = "five"; burstSize = 10; windowSize = 60000 } }
)

foreach ($case in $badCases) {
    $r = Invoke-Api -Method PUT -Path "/admin/clients/invalid-$Run" -Body $case.body
    Assert-Status $r 400 $case.label
}

# ---------------------------------------------------------------------------
# 3. Admin GET
# ---------------------------------------------------------------------------

Write-Header "3. Admin GET - read back stored config"

$r = Invoke-Api -Method GET -Path "/admin/clients/$cid"
Assert-Status $r 200 "GET returns 200 for existing client"
Assert-BodyField $r "clientId" $cid "Body contains clientId"

$cfg = $r.Body.config
if ($cfg -and $cfg.algorithm -eq "token-bucket" -and $cfg.requestPerSecond -eq 5) {
    Pass "Config roundtrips correctly: algorithm=token-bucket rps=5"
}
else {
    Fail "Config did not roundtrip correctly" "Got: $($r.Raw)"
}

Write-Header "3b. Admin GET - unknown client returns 404"

$r = Invoke-Api -Method GET -Path "/admin/clients/does-not-exist-$Run"
Assert-Status $r 404 "Returns 404 for unknown client"

# ---------------------------------------------------------------------------
# 4. Check - default config (no admin config set)
# ---------------------------------------------------------------------------

Write-Header "4. Check - default config, first request allowed"

$cidDefault = "test-default-$Run"
$r = Invoke-Api -Method GET -Path "/check/$cidDefault"

Assert-Status        $r 200 "First request allowed on default config"
Assert-BodyField     $r "allowed" $true "Body: allowed=true"
Assert-HeaderPresent $r "X-RateLimit-Limit"     "Header X-RateLimit-Limit present"
Assert-HeaderPresent $r "X-RateLimit-Remaining" "Header X-RateLimit-Remaining present"
Assert-HeaderPresent $r "X-RateLimit-Reset"     "Header X-RateLimit-Reset present"
Assert-HeaderNumeric $r "X-RateLimit-Limit"     "X-RateLimit-Limit is numeric"
Assert-HeaderNumeric $r "X-RateLimit-Remaining" "X-RateLimit-Remaining is numeric"
Assert-HeaderNumeric $r "X-RateLimit-Reset"     "X-RateLimit-Reset is numeric"

# ---------------------------------------------------------------------------
# 5. Token-bucket - burst exhaustion
# ---------------------------------------------------------------------------

Write-Header "5. Token-bucket - burst=3 exhaustion produces 429"

$cidBurst = "test-burst-$Run"
$null = Set-ClientConfig -ClientId $cidBurst -Algorithm "token-bucket" -Rps 2 -Burst 3 -Window 60000

$allows = 0
$denies = 0
for ($i = 0; $i -lt 6; $i++) {
    $r = Invoke-Api -Method GET -Path "/check/$cidBurst"
    if ($r.StatusCode -eq 200) { $allows++ }
    if ($r.StatusCode -eq 429) { $denies++ }
}

if ($allows -eq 3) {
    Pass "Exactly 3 allows before bucket drains"
}
else {
    Fail "Expected 3 allows, got $allows"
}

if ($denies -ge 1) {
    Pass "At least 1 deny after burst exhausted"
}
else {
    Fail "Expected denies after burst exhausted, got 0"
}

$r429 = Invoke-Api -Method GET -Path "/check/$cidBurst"
if ($r429.StatusCode -eq 429) {
    Assert-BodyField     $r429 "allowed" $false "429 body: allowed=false"
    Assert-HeaderPresent $r429 "X-RateLimit-Remaining" "429 carries X-RateLimit-Remaining"
    Assert-HeaderPresent $r429 "X-RateLimit-Reset"     "429 carries X-RateLimit-Reset"
}

# ---------------------------------------------------------------------------
# 6. Token-bucket - remaining decrements
# ---------------------------------------------------------------------------

Write-Header "6. Token-bucket - X-RateLimit-Remaining decrements"

$cidRemain = "test-remaining-$Run"
$null = Set-ClientConfig -ClientId $cidRemain -Algorithm "token-bucket" -Rps 5 -Burst 5 -Window 60000

$prevRemaining = 999
$monotonic = $true

for ($i = 0; $i -lt 5; $i++) {
    $r = Invoke-Api -Method GET -Path "/check/$cidRemain"
    if ($r.StatusCode -eq 200) {
        $cur = [int]$r.Headers["X-RateLimit-Remaining"]
        if ($cur -ge $prevRemaining) {
            $monotonic = $false
            Fail "Remaining did not decrease on request $($i+1)" "prev=$prevRemaining cur=$cur"
            break
        }
        $prevRemaining = $cur
    }
}
if ($monotonic) {
    Pass "X-RateLimit-Remaining decrements monotonically across 5 requests"
}

# ---------------------------------------------------------------------------
# 7. Sliding window - limit enforced
# ---------------------------------------------------------------------------

Write-Header "7. Sliding window - limit=4 per 30s window"

$cidSw2 = "test-sw2-$Run"
$null = Set-ClientConfig -ClientId $cidSw2 -Algorithm "sliding-window" -Rps 4 -Burst 4 -Window 30000

$swAllows = 0
$swDenies = 0
for ($i = 0; $i -lt 7; $i++) {
    $r = Invoke-Api -Method GET -Path "/check/$cidSw2"
    if ($r.StatusCode -eq 200) { $swAllows++ }
    if ($r.StatusCode -eq 429) { $swDenies++ }
}

if ($swAllows -eq 4) {
    Pass "Sliding window allows exactly 4 requests"
}
else {
    Fail "Expected 4 sliding-window allows, got $swAllows"
}

if ($swDenies -ge 1) {
    Pass "Sliding window denies requests beyond limit"
}
else {
    Fail "Expected denies after limit hit, got 0"
}

# ---------------------------------------------------------------------------
# 8. Algorithm switch
# ---------------------------------------------------------------------------

Write-Header "8. Algorithm switch - config change takes effect immediately"

$cidSwitch = "test-switch-$Run"
$null = Set-ClientConfig -ClientId $cidSwitch -Algorithm "token-bucket" -Rps 1 -Burst 2 -Window 60000

for ($i = 0; $i -lt 4; $i++) {
    $null = Invoke-Api -Method GET -Path "/check/$cidSwitch"
}
$rExhausted = Invoke-Api -Method GET -Path "/check/$cidSwitch"
$bucketDrained = $rExhausted.StatusCode -eq 429

if ($bucketDrained) {
    Pass "Token-bucket correctly exhausted before algorithm switch"

    $null = Set-ClientConfig -ClientId $cidSwitch -Algorithm "sliding-window" -Rps 10 -Burst 10 -Window 60000
    $rAfter = Invoke-Api -Method GET -Path "/check/$cidSwitch"
    if ($rAfter.StatusCode -eq 200) {
        Pass "After switching to sliding-window, request is allowed on fresh key"
    }
    else {
        Fail "Expected 200 after algorithm switch" "Got $($rAfter.StatusCode)"
    }
}
else {
    Skip "Bucket not fully drained - algorithm switch test skipped"
}

# ---------------------------------------------------------------------------
# 9. X-RateLimit-Limit matches configured rps
# ---------------------------------------------------------------------------

Write-Header "9. Headers - X-RateLimit-Limit matches requestPerSecond"

$cidLimit = "test-limit-$Run"
$null = Set-ClientConfig -ClientId $cidLimit -Algorithm "token-bucket" -Rps 7 -Burst 7 -Window 60000
$r = Invoke-Api -Method GET -Path "/check/$cidLimit"
$limitHeader = [int]$r.Headers["X-RateLimit-Limit"]
if ($limitHeader -eq 7) {
    Pass "X-RateLimit-Limit=7 matches configured requestPerSecond"
}
else {
    Fail "X-RateLimit-Limit mismatch" "Expected 7, got $limitHeader"
}

# ---------------------------------------------------------------------------
# 10. Concurrency - parallel hits must not double-spend
# ---------------------------------------------------------------------------

Write-Header "10. Concurrency - 10 parallel requests against burst=5"

$cidConcurrent = "test-concurrent-$Run"
$null = Set-ClientConfig -ClientId $cidConcurrent -Algorithm "token-bucket" -Rps 1 -Burst 5 -Window 60000

$pool = [System.Management.Automation.Runspaces.RunspacePool]::CreateRunspacePool(1, 10)
$pool.Open()
$jobs = @()
$script = {
    param($url)
    try {
        $resp = Invoke-WebRequest -Uri $url -Method GET -UseBasicParsing -ErrorAction Stop
        return [int]$resp.StatusCode
    }
    catch {
        $code = $_.Exception.Response.StatusCode.value__
        if ($code) { return [int]$code } else { return 0 }
    }
}
$url = "$BaseUrl/check/$cidConcurrent"
for ($i = 0; $i -lt 10; $i++) {
    $ps = [System.Management.Automation.PowerShell]::Create()
    $ps.RunspacePool = $pool
    $null = $ps.AddScript($script).AddArgument($url)
    $jobs += @{ ps = $ps; handle = $ps.BeginInvoke() }
}

$parallelAllows = 0
foreach ($job in $jobs) {
    $result = $job.ps.EndInvoke($job.handle)
    if ($result -eq 200) { $parallelAllows++ }
    $job.ps.Dispose()
}
$pool.Close()
$pool.Dispose()

if ($parallelAllows -le 5) {
    Pass "Parallel allows ($parallelAllows) did not exceed burst=5 - no double-spend"
}
else {
    Fail "Double-spend detected" "$parallelAllows allows for burst=5 violates atomicity"
}

# ---------------------------------------------------------------------------
# 11. Token-bucket refill over time
# ---------------------------------------------------------------------------

Write-Header "11. Token-bucket - bucket refills after waiting"

$cidRefill = "test-refill-$Run"
$null = Set-ClientConfig -ClientId $cidRefill -Algorithm "token-bucket" -Rps 5 -Burst 2 -Window 60000

for ($i = 0; $i -lt 4; $i++) {
    $null = Invoke-Api -Method GET -Path "/check/$cidRefill"
}
$rDrained = Invoke-Api -Method GET -Path "/check/$cidRefill"

if ($rDrained.StatusCode -eq 429) {
    Pass "Bucket drained - 429 confirmed before wait"

    Write-Host "         Waiting 300ms for refill at rps=5..." -ForegroundColor DarkGray
    Start-Sleep -Milliseconds 300

    $rRefilled = Invoke-Api -Method GET -Path "/check/$cidRefill"
    if ($rRefilled.StatusCode -eq 200) {
        Pass "Bucket refilled after 300ms - request allowed again"
    }
    else {
        Fail "Bucket did not refill in 300ms" "rps=5 should earn 1.5 tokens in 300ms"
    }
}
else {
    Skip "Bucket not fully drained - refill test skipped"
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

Write-Host ""
$line = "=" * 60
Write-Host "  $line" -ForegroundColor DarkGray

$color = if ($script:Failed -eq 0) { "Green" } else { "Yellow" }
Write-Host "  Results: $($script:Passed) passed  $($script:Failed) failed  $($script:Total) total" -ForegroundColor $color

Write-Host "  $line" -ForegroundColor DarkGray
Write-Host ""

if ($script:Failed -gt 0) { exit 1 } else { exit 0 }