param([string]$BaseUrl = 'http://127.0.0.1:8787')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$headers = @{}
if ($env:COPILOT_API_KEY) { $headers.Authorization = 'Bearer ' + $env:COPILOT_API_KEY }
$status = Invoke-RestMethod -Uri ($BaseUrl + '/status') -Headers $headers
if ($status.state -ne 'ready') { throw ('Browser is not ready: ' + $status.state) }
$token = 'COPILOT_API_' + [guid]::NewGuid().ToString('N')
$request = @{prompt = 'Reply with exactly this string and nothing else: ' + $token; request_id = $token}
$bytes = [System.Text.Encoding]::UTF8.GetBytes(($request | ConvertTo-Json -Compress))
$result = Invoke-RestMethod -Uri ($BaseUrl + '/chat') -Method Post -ContentType 'application/json; charset=utf-8' -Body $bytes -Headers $headers -TimeoutSec 240
if ($result.state -ne 'completed' -or $result.answer.Trim() -ne $token) { throw ($result | ConvertTo-Json -Depth 8) }
$result | ConvertTo-Json -Depth 8
Write-Host 'PASS: HTTP -> Playwright CLI -> Edge -> Copilot -> answer -> HTTP'
