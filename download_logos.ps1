# Download all asset logos from Supabase Storage (public bucket: asset-icons)
# Uses the anon key for authenticated list, but downloads via public URL.

$BASE = "https://xbyoaxsrotjljcxztavd.supabase.co/storage/v1/object/public/asset-icons"
$OUT  = "C:\Users\deepa\Aether-Quant\asset-icons"

# Fetch index.json (public)
Write-Host "Fetching index.json..."
$index = Invoke-RestMethod -Uri "$BASE/index.json" -Method Get

$total = ($index.PSObject.Properties | Measure-Object).Count
$done  = 0
$failed = @()

Write-Host "Found $total logos to download."

foreach ($prop in $index.PSObject.Properties) {
    $symbol = $prop.Name
    $ext    = $prop.Value
    $filename = "$symbol.$ext"
    $url   = "$BASE/$filename"
    $dest  = Join-Path $OUT $filename
    $done++

    try {
        Invoke-WebRequest -Uri $url -OutFile $dest -ErrorAction Stop
        Write-Host "[$done/$total] $filename"
    } catch {
        Write-Host "[$done/$total] FAILED: $filename - $($_.Exception.Message)" -ForegroundColor Red
        $failed += $filename
    }
}

Write-Host "`nDone! Downloaded $($total - $failed.Count)/$total logos to $OUT"
if ($failed.Count -gt 0) {
    Write-Host "Failed: $($failed -join ', ')" -ForegroundColor Yellow
}
