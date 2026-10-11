param(
  [ValidateNotNullOrEmpty()]
  [string]$Version = '0.13.0-alpha'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression

function Assert-ChildPath {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Path
  )

  $canonicalRoot = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $canonicalPath = [IO.Path]::GetFullPath($Path)
  if (-not $canonicalPath.StartsWith($canonicalRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Path escapes the expected root: $canonicalPath"
  }
  return $canonicalPath
}

function Assert-NotReparsePoint {
  param([Parameter(Mandatory = $true)][string]$Path)

  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Release path must not be a reparse point: $($item.FullName)"
  }
}

function Get-ReleaseFiles {
  param([Parameter(Mandatory = $true)][string]$Root)

  Assert-NotReparsePoint -Path $Root
  $pending = [Collections.Generic.Queue[IO.DirectoryInfo]]::new()
  $files = [Collections.Generic.List[IO.FileInfo]]::new()
  $pending.Enqueue((Get-Item -LiteralPath $Root -Force))
  while ($pending.Count -gt 0) {
    $directory = $pending.Dequeue()
    foreach ($child in Get-ChildItem -LiteralPath $directory.FullName -Force) {
      if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Release tree contains a reparse point: $($child.FullName)"
      }
      if ($child.PSIsContainer) {
        $pending.Enqueue($child)
      }
      else {
        $files.Add($child)
      }
    }
  }
  return @($files | Sort-Object FullName)
}

function Get-RelativeReleasePath {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$FullName
  )

  $normalizedRoot = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
  return $FullName.Substring($normalizedRoot.Length + 1).Replace([IO.Path]::DirectorySeparatorChar, '/')
}

function Assert-SafeReleaseTree {
  param([Parameter(Mandatory = $true)][string]$Root)

  $forbiddenPathPattern = '(?i)(^|/)(dist|node_modules|src|tests|\.git|profile|browser[-_]?profile|user[-_]?data|login[-_]?state)(/|$)|(?i)(^|/)(cookies?(?:\.[^/]*)?|credentials?(?:\.[^/]*)?|local state|key\.txt|id_rsa(?:\.pub)?|[^/]*(?:private[-_]?key|secret[-_]?key)[^/]*|[^/]+\.(?:pem|pfx|p12|key))$'
  $secretPatterns = @(
    '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
    '\bAKIA[0-9A-Z]{16}\b',
    '(?i)\bgh[pousr]_[A-Za-z0-9]{30,}\b',
    '(?i)\bsk-[A-Za-z0-9_-]{20,}\b',
    '(?i)\bxox[baprs]-[A-Za-z0-9-]{10,}\b'
  )
  $textExtensions = @('.css', '.html', '.js', '.json', '.md', '.txt', '.xml')

  foreach ($file in Get-ReleaseFiles -Root $Root) {
    $relativePath = Get-RelativeReleasePath -Root $Root -FullName $file.FullName
    if ($relativePath -match $forbiddenPathPattern) {
      throw "Forbidden release path: $relativePath"
    }
    if ($textExtensions -contains $file.Extension.ToLowerInvariant()) {
      $source = [IO.File]::ReadAllText($file.FullName)
      foreach ($pattern in $secretPatterns) {
        if ($source -match $pattern) {
          throw "Secret-like content marker found in $relativePath"
        }
      }
    }
  }
}

function Assert-RequiredReleaseFiles {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string[]]$RelativePaths
  )

  foreach ($relativePath in $RelativePaths) {
    if ([IO.Path]::IsPathRooted($relativePath) -or $relativePath.Split('/') -contains '..') {
      throw "Invalid required release path: $relativePath"
    }
    $fullPath = Assert-ChildPath -Root $Root -Path (Join-Path $Root $relativePath.Replace('/', [IO.Path]::DirectorySeparatorChar))
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
      throw "Required release file is missing: $relativePath"
    }
  }
}

function Get-FileHashMap {
  param([Parameter(Mandatory = $true)][string]$Root)

  $result = @{}
  foreach ($file in Get-ReleaseFiles -Root $Root) {
    $relativePath = Get-RelativeReleasePath -Root $Root -FullName $file.FullName
    $result[$relativePath] = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash
  }
  return $result
}

function New-DeterministicZip {
  param(
    [Parameter(Mandatory = $true)][string]$SourceRoot,
    [Parameter(Mandatory = $true)][string]$DestinationPath
  )

  $fixedTimestamp = [DateTimeOffset]::new(2026, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
  $zipStream = [IO.File]::Open($DestinationPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
  try {
    $archive = [IO.Compression.ZipArchive]::new($zipStream, [IO.Compression.ZipArchiveMode]::Create, $false)
    try {
      foreach ($file in Get-ReleaseFiles -Root $SourceRoot) {
        $relativePath = Get-RelativeReleasePath -Root $SourceRoot -FullName $file.FullName
        $entry = $archive.CreateEntry($relativePath, [IO.Compression.CompressionLevel]::Optimal)
        $entry.LastWriteTime = $fixedTimestamp
        $sourceStream = [IO.File]::OpenRead($file.FullName)
        try {
          $entryStream = $entry.Open()
          try {
            $sourceStream.CopyTo($entryStream)
          }
          finally {
            $entryStream.Dispose()
          }
        }
        finally {
          $sourceStream.Dispose()
        }
      }
    }
    finally {
      $archive.Dispose()
    }
  }
  finally {
    $zipStream.Dispose()
  }
}

if ($Version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$') {
  throw "Invalid release version: $Version"
}

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$distRoot = [IO.Path]::GetFullPath((Join-Path $repositoryRoot 'dist'))
$artifactRoot = [IO.Path]::GetFullPath((Join-Path $repositoryRoot 'release-artifacts'))
$zipName = "bili-bill-$Version.zip"
$zipPath = Assert-ChildPath -Root $artifactRoot -Path (Join-Path $artifactRoot $zipName)
$shaPath = Assert-ChildPath -Root $artifactRoot -Path "$zipPath.sha256"

$packageMetadata = Get-Content -LiteralPath (Join-Path $repositoryRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$manifestPath = Join-Path $distRoot 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw 'dist/manifest.json is missing. Run npm run build first.'
}
Assert-NotReparsePoint -Path $distRoot
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$expectedManifestVersion = $Version -replace '-.*$', ''
if ($packageMetadata.version -ne $Version -or $manifest.version_name -ne $Version -or $manifest.version -ne $expectedManifestVersion) {
  throw "Release version mismatch: package=$($packageMetadata.version), manifest=$($manifest.version), version_name=$($manifest.version_name)"
}

$requiredPaths = @(
  'manifest.json',
  'background.js',
  'popup.js',
  'dashboard.js',
  'popup/index.html',
  'dashboard/index.html',
  'content/player-monitor.js',
  'content/sidebar-card.js',
  'content/page-runtime-bridge.js',
  'LICENSE.txt',
  'THIRD_PARTY_NOTICES.txt',
  'third_party_licenses/Apache-2.0.txt',
  'third_party_licenses/BSD-3-Clause-d3.txt',
  'third_party_licenses/MIT-wordcloud2.txt'
)
$requiredPaths += @($manifest.icons.PSObject.Properties.Value)
$requiredPaths += @($manifest.action.default_icon.PSObject.Properties.Value)
$requiredPaths += @($manifest.background.service_worker)
foreach ($contentScript in $manifest.content_scripts) {
  $requiredPaths += @($contentScript.js)
  if ($contentScript.PSObject.Properties.Name -contains 'css') {
    $requiredPaths += @($contentScript.css)
  }
}
foreach ($resourceGroup in $manifest.web_accessible_resources) {
  $requiredPaths += @($resourceGroup.resources)
}
$requiredPaths = @($requiredPaths | Where-Object { $_ } | Sort-Object -Unique)

Assert-SafeReleaseTree -Root $distRoot
Assert-RequiredReleaseFiles -Root $distRoot -RelativePaths $requiredPaths
& node (Join-Path $repositoryRoot 'scripts/verify-release-dist.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Ordinary distribution verification failed; no release ZIP created.' }

New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null
Assert-NotReparsePoint -Path $artifactRoot
$token = [guid]::NewGuid().ToString('N')
$temporaryZipPath = Assert-ChildPath -Root $artifactRoot -Path (Join-Path $artifactRoot ".$zipName.$token.tmp")
$temporaryShaPath = Assert-ChildPath -Root $artifactRoot -Path "$temporaryZipPath.sha256"
$systemTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
$auditRoot = Assert-ChildPath -Root $systemTempRoot -Path (Join-Path $systemTempRoot ("bili-bill-release-audit-$token"))

try {
  New-DeterministicZip -SourceRoot $distRoot -DestinationPath $temporaryZipPath
  $zipHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $temporaryZipPath).Hash.ToLowerInvariant()
  $shaContent = "$zipHash  $zipName`n"
  [IO.File]::WriteAllText($temporaryShaPath, $shaContent, [Text.UTF8Encoding]::new($false))

  New-Item -ItemType Directory -Path $auditRoot | Out-Null
  [IO.Compression.ZipFile]::ExtractToDirectory($temporaryZipPath, $auditRoot)
  $distMap = Get-FileHashMap -Root $distRoot
  $zipMap = Get-FileHashMap -Root $auditRoot
  if ($distMap.Count -ne $zipMap.Count) {
    throw "ZIP file count mismatch: dist=$($distMap.Count), zip=$($zipMap.Count)"
  }
  foreach ($relativePath in $distMap.Keys) {
    if (-not $zipMap.ContainsKey($relativePath) -or $zipMap[$relativePath] -ne $distMap[$relativePath]) {
      throw "ZIP path or hash mismatch: $relativePath"
    }
  }
  Assert-RequiredReleaseFiles -Root $auditRoot -RelativePaths $requiredPaths

  if (Test-Path -LiteralPath $zipPath) {
    $existingHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
    if ($existingHash -ne $zipHash) {
      throw "Refusing to replace a different existing release ZIP: $zipPath"
    }
  }
  if (Test-Path -LiteralPath $shaPath) {
    $existingShaContent = [IO.File]::ReadAllText($shaPath)
    if ($existingShaContent -ne $shaContent) {
      throw "Refusing to replace a different existing checksum: $shaPath"
    }
  }

  if (-not (Test-Path -LiteralPath $zipPath)) {
    [IO.File]::Move($temporaryZipPath, $zipPath)
  }
  if (-not (Test-Path -LiteralPath $shaPath)) {
    [IO.File]::Move($temporaryShaPath, $shaPath)
  }

  [PSCustomObject]@{
    zip = $zipPath
    sha256 = $zipHash
    bytes = (Get-Item -LiteralPath $zipPath).Length
    files = $zipMap.Count
  } | ConvertTo-Json -Compress
}
finally {
  foreach ($temporaryPath in @($temporaryZipPath, $temporaryShaPath)) {
    if ((Test-Path -LiteralPath $temporaryPath) -and (Assert-ChildPath -Root $artifactRoot -Path $temporaryPath)) {
      Remove-Item -LiteralPath $temporaryPath
    }
  }
  if ((Test-Path -LiteralPath $auditRoot) -and (Assert-ChildPath -Root $systemTempRoot -Path $auditRoot)) {
    Get-ReleaseFiles -Root $auditRoot | Out-Null
    Remove-Item -LiteralPath $auditRoot -Recurse -Force
  }
}
