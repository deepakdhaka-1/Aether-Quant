# Copy this file over download_logos.ps1, then run it in PowerShell.
# The destination key is prompted at runtime and is not stored in this file.

$ErrorActionPreference = 'Stop'

$SourceProjectUrl = 'https://xbyoaxsrotjljcxztavd.supabase.co'
$SourceBucket = 'asset-icons'
$DestinationProjectUrl = 'https://slkrvhpvflfweoetxfki.supabase.co'
$DestinationBucket = 'asset-icons'
$DestinationBucketIsPublic = $true

$secureKey = Read-Host 'Paste the DESTINATION Supabase secret/service_role key, then press Enter' -AsSecureString
$keyPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try {
    $destinationKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPtr)
}
finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPtr)
}
if ([string]::IsNullOrWhiteSpace($destinationKey)) { throw 'The destination key was empty.' }

$headers = @{ apikey = $destinationKey }
# Legacy service_role keys are JWTs; new sb_secret keys are not.
if (-not $destinationKey.StartsWith('sb_secret_')) {
    $headers['Authorization'] = 'Bearer ' + $destinationKey
}

$sourceBase = $SourceProjectUrl.TrimEnd('/') + '/storage/v1/object/public/' + $SourceBucket
$storageApi = $DestinationProjectUrl.TrimEnd('/') + '/storage/v1'
$tempDir = Join-Path ([IO.Path]::GetTempPath()) ('logo-migration-' + [guid]::NewGuid().ToString())
$failed = New-Object 'System.Collections.Generic.List[string]'

try {
    Write-Host 'Fetching source index.json...'
    $index = Invoke-RestMethod -Uri ($sourceBase + '/index.json') -Method Get
    $entries = @($index.PSObject.Properties)
    if ($entries.Count -eq 0) { throw 'No logo entries were found in index.json.' }
    Write-Host ('Found ' + $entries.Count + ' files.')

    # Try to create the bucket. If it already exists, confirm that it is accessible.
    $bucketBody = @{ id = $DestinationBucket; name = $DestinationBucket; public = $DestinationBucketIsPublic } | ConvertTo-Json -Compress
    try {
        Invoke-RestMethod -Uri ($storageApi + '/bucket') -Method Post -Headers $headers -ContentType 'application/json' -Body $bucketBody | Out-Null
        Write-Host ('Created bucket: ' + $DestinationBucket)
    }
    catch {
        try {
            Invoke-RestMethod -Uri ($storageApi + '/bucket/' + [Uri]::EscapeDataString($DestinationBucket)) -Method Get -Headers $headers | Out-Null
            Write-Host ('Bucket already exists: ' + $DestinationBucket)
        }
        catch {
            throw ('Could not create or access the destination bucket. Check the project URL and key. ' + $_.Exception.Message)
        }
    }

    New-Item -ItemType Directory -Path $tempDir | Out-Null
    $total = $entries.Count
    $number = 0

    foreach ($entry in $entries) {
        $number++
        $symbol = [string]$entry.Name
        $extension = [string]$entry.Value
        $filename = $symbol + '.' + $extension

        if ($symbol -match '[/\\]' -or $symbol -match '\.\.' -or $extension -notmatch '^[A-Za-z0-9]+$') {
            $failed.Add($filename)
            Write-Host ('[' + $number + '/' + $total + '] Skipped unsafe filename: ' + $filename)
            continue
        }

        $encodedFilename = [Uri]::EscapeDataString($filename)
        $localFile = Join-Path $tempDir $filename
        $downloadUrl = $sourceBase + '/' + $encodedFilename
        $uploadUrl = $storageApi + '/object/' + [Uri]::EscapeDataString($DestinationBucket) + '/' + $encodedFilename

        try {
            Invoke-WebRequest -Uri $downloadUrl -OutFile $localFile -ErrorAction Stop | Out-Null
            $uploadHeaders = @{}
            foreach ($headerName in $headers.Keys) { $uploadHeaders[$headerName] = $headers[$headerName] }
            $uploadHeaders['x-upsert'] = 'true'

            $contentType = 'application/octet-stream'
            switch ($extension.ToLowerInvariant()) {
                'png' { $contentType = 'image/png' }
                'jpg' { $contentType = 'image/jpeg' }
                'jpeg' { $contentType = 'image/jpeg' }
                'svg' { $contentType = 'image/svg+xml' }
                'webp' { $contentType = 'image/webp' }
                'gif' { $contentType = 'image/gif' }
                'ico' { $contentType = 'image/x-icon' }
            }

            Invoke-WebRequest -Uri $uploadUrl -Method Post -Headers $uploadHeaders -ContentType $contentType -InFile $localFile -ErrorAction Stop | Out-Null
            Write-Host ('[' + $number + '/' + $total + '] Uploaded ' + $filename)
        }
        catch {
            $failed.Add($filename)
            Write-Host ('[' + $number + '/' + $total + '] FAILED ' + $filename + ': ' + $_.Exception.Message)
        }
        finally {
            Remove-Item -LiteralPath $localFile -Force -ErrorAction SilentlyContinue
        }
    }

    Write-Host ''
    Write-Host ('Finished. Migrated ' + ($total - $failed.Count) + ' of ' + $total + ' files.')
    if ($failed.Count -gt 0) { Write-Host ('Failed files: ' + ($failed -join ', ')) }
}
finally {
    if (Test-Path -LiteralPath $tempDir) { Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue }
    $destinationKey = $null
    $headers = $null
}
