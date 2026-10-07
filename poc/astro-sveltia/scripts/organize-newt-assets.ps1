param(
  [Parameter(Mandatory = $true)]
  [string]$SourcePath,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath,

  [string]$WikiRoot = (Join-Path $PSScriptRoot '..')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-NormalizedPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  return [IO.Path]::GetFullPath($Path).TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
  )
}

function Get-StorageAssetPaths {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Text
  )

  $pattern =
    'https://storage\.googleapis\.com/p_631ae0ff4b26e8e308048763/([^"''<>\s)]+)'

  return @(
    [regex]::Matches($Text, $pattern, 'IgnoreCase') |
      ForEach-Object {
        [Uri]::UnescapeDataString($_.Groups[1].Value).Replace('\', '/')
      }
  )
}

$sourceFullPath = (Resolve-Path -LiteralPath $SourcePath).Path.TrimEnd('\')
$outputFullPath = Get-NormalizedPath -Path $OutputPath
$outputParent = [IO.Path]::GetDirectoryName($outputFullPath)
$wikiFullPath = (Resolve-Path -LiteralPath $WikiRoot).Path.TrimEnd('\')

if (-not (Test-Path -LiteralPath $sourceFullPath -PathType Container)) {
  throw "Source directory does not exist: $sourceFullPath"
}

if (-not (Test-Path -LiteralPath $outputParent -PathType Container)) {
  throw "Output parent directory does not exist: $outputParent"
}

if (Test-Path -LiteralPath $outputFullPath) {
  throw "Output path already exists. Refusing to overwrite it: $outputFullPath"
}

$comparison = [StringComparison]::OrdinalIgnoreCase
if (
  $outputFullPath.Equals($sourceFullPath, $comparison) -or
  $outputFullPath.StartsWith(
    $sourceFullPath + [IO.Path]::DirectorySeparatorChar,
    $comparison
  )
) {
  throw 'Output must be outside the verified source backup directory.'
}

$sourceFiles = @(
  Get-ChildItem -LiteralPath $sourceFullPath -Recurse -File |
    Sort-Object FullName |
    ForEach-Object {
      $relativePath = $_.FullName.Substring(
        $sourceFullPath.Length
      ).TrimStart('\').Replace('\', '/')
      $segments = @($relativePath.Split('/'))
      $sourceUuid = [guid]::Empty

      if (
        $segments.Count -ne 2 -or
        -not [guid]::TryParse($segments[0], [ref]$sourceUuid)
      ) {
        throw "Unexpected Newt asset path: $relativePath"
      }

      [pscustomobject][ordered]@{
        SourceUuid = $segments[0]
        OriginalPath = $relativePath
        OriginalName = $_.Name
        FullPath = $_.FullName
        Bytes = $_.Length
        Sha256 = (
          Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256
        ).Hash.ToLowerInvariant()
      }
    }
)

if ($sourceFiles.Count -ne 72) {
  throw "Expected 72 Newt files, found $($sourceFiles.Count)."
}

$assetManifestPath = Join-Path $wikiFullPath (
  'migration\newt-full-assets-2026-07-29-manifest.json'
)
$assetManifest = Get-Content -Raw -LiteralPath $assetManifestPath |
  ConvertFrom-Json
$expectedFilesByPath = @{}
foreach ($file in $assetManifest.files) {
  $expectedFilesByPath[[string]$file.path] = $file
}

if ($expectedFilesByPath.Count -ne $sourceFiles.Count) {
  throw 'The source backup file count differs from the committed asset manifest.'
}

foreach ($sourceFile in $sourceFiles) {
  if (-not $expectedFilesByPath.ContainsKey($sourceFile.OriginalPath)) {
    throw "Source file is absent from the committed manifest: $($sourceFile.OriginalPath)"
  }

  $expectedFile = $expectedFilesByPath[$sourceFile.OriginalPath]
  if (
    [long]$expectedFile.bytes -ne $sourceFile.Bytes -or
    [string]$expectedFile.sha256 -ne $sourceFile.Sha256
  ) {
    throw "Source file differs from the committed manifest: $($sourceFile.OriginalPath)"
  }
}

$canonicalNameByHash = @{}
$nameGroups = @(
  $sourceFiles |
    Group-Object { $_.OriginalName.ToLowerInvariant() }
)

foreach ($nameGroup in $nameGroups) {
  $hashGroups = @($nameGroup.Group | Group-Object Sha256)
  foreach ($hashGroup in $hashGroups) {
    $first = $hashGroup.Group | Sort-Object OriginalPath | Select-Object -First 1
    $canonicalName = $first.OriginalName

    if ($hashGroups.Count -gt 1) {
      $stem = [IO.Path]::GetFileNameWithoutExtension($first.OriginalName)
      $extension = [IO.Path]::GetExtension($first.OriginalName)
      $canonicalName = "$stem--$($first.Sha256.Substring(0, 8))$extension"
    }

    $canonicalNameByHash[$first.Sha256] = $canonicalName
  }
}

$articleExportPath = Join-Path $wikiFullPath (
  'migration\newt-full-export-2026-07-29\article.json'
)
$articleExport = Get-Content -Raw -LiteralPath $articleExportPath |
  ConvertFrom-Json
$articleRefsByPath = @{}

foreach ($article in $articleExport.items) {
  $texts = @([string]$article.body)
  $metaProperty = $article.PSObject.Properties['meta']
  $ogImageProperty = if ($metaProperty -and $metaProperty.Value) {
    $metaProperty.Value.PSObject.Properties['ogImage']
  } else {
    $null
  }
  $ogImageSourceProperty = if (
    $ogImageProperty -and
    $ogImageProperty.Value -and
    $ogImageProperty.Value -isnot [string]
  ) {
    $ogImageProperty.Value.PSObject.Properties['src']
  } else {
    $null
  }

  if ($ogImageSourceProperty -and $ogImageSourceProperty.Value) {
    $texts += [string]$ogImageSourceProperty.Value
  }

  foreach ($text in $texts) {
    if ([string]::IsNullOrWhiteSpace($text)) {
      continue
    }

    foreach ($assetPath in Get-StorageAssetPaths -Text $text) {
      if (-not $articleRefsByPath.ContainsKey($assetPath)) {
        $articleRefsByPath[$assetPath] = @()
      }

      $articleRefsByPath[$assetPath] += [pscustomobject]@{
        Slug = [string]$article.slug
        Title = [string]$article.title
      }
    }
  }
}

$wikiAssetsByHash = @{}
$wikiAssetDirectories = @(
  (Join-Path $wikiFullPath 'public\uploads\wiki'),
  (Join-Path $wikiFullPath 'migration\newt-draft-assets-2026-07-29')
)

foreach ($directory in $wikiAssetDirectories) {
  foreach ($file in Get-ChildItem -LiteralPath $directory -File) {
    $hash = (
      Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256
    ).Hash.ToLowerInvariant()
    if (-not $wikiAssetsByHash.ContainsKey($hash)) {
      $wikiAssetsByHash[$hash] = @()
    }

    $wikiAssetsByHash[$hash] += $file.FullName.Substring(
      $wikiFullPath.Length
    ).TrimStart('\').Replace('\', '/')
  }
}

$primaryPathByHash = @{}
$uniqueFiles = @(
  $sourceFiles |
    Group-Object Sha256 |
    ForEach-Object {
      $primary = $_.Group | Sort-Object OriginalPath | Select-Object -First 1
      $primaryPathByHash[$primary.Sha256] = $primary.OriginalPath
      [pscustomobject][ordered]@{
        CanonicalName = $canonicalNameByHash[$primary.Sha256]
        SourcePath = $primary.FullPath
        Bytes = $primary.Bytes
        Sha256 = $primary.Sha256
        DuplicateCount = $_.Count
      }
    } |
    Sort-Object CanonicalName
)

$manifestRows = @(
  $sourceFiles |
    ForEach-Object {
      $articleRefs = if ($articleRefsByPath.ContainsKey($_.OriginalPath)) {
        @($articleRefsByPath[$_.OriginalPath])
      } else {
        @()
      }
      $wikiPaths = if ($wikiAssetsByHash.ContainsKey($_.Sha256)) {
        @($wikiAssetsByHash[$_.Sha256])
      } else {
        @()
      }
      $primaryPath = $primaryPathByHash[$_.Sha256]

      [pscustomobject][ordered]@{
        source_uuid = $_.SourceUuid
        original_path = $_.OriginalPath
        original_name = $_.OriginalName
        canonical_name = $canonicalNameByHash[$_.Sha256]
        bytes = $_.Bytes
        sha256 = $_.Sha256
        duplicate_of = if ($_.OriginalPath -eq $primaryPath) {
          ''
        } else {
          $primaryPath
        }
        newt_article_slugs = (
          $articleRefs |
            ForEach-Object { $_.Slug } |
            Sort-Object -Unique
        ) -join '; '
        newt_article_titles = (
          $articleRefs |
            ForEach-Object { $_.Title } |
            Sort-Object -Unique
        ) -join '; '
        current_wiki_paths = (
          $wikiPaths |
            Sort-Object -Unique
        ) -join '; '
      }
    } |
    Sort-Object original_path
)

$articleReferencedHashes = @(
  $sourceFiles |
    Where-Object { $articleRefsByPath.ContainsKey($_.OriginalPath) } |
    Select-Object -ExpandProperty Sha256 -Unique
)
$preservedArticleHashes = @(
  $articleReferencedHashes |
    Where-Object { $wikiAssetsByHash.ContainsKey($_) }
)
$uniqueBytes = (
  $uniqueFiles |
    Measure-Object -Property Bytes -Sum
).Sum
$duplicateFileCount = $sourceFiles.Count - $uniqueFiles.Count

if ($articleReferencedHashes.Count -ne $preservedArticleHashes.Count) {
  throw 'A Newt-managed article image is not preserved in the current Wiki.'
}

$stagingPath = "$outputFullPath.__staging__$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $stagingPath | Out-Null

try {
  foreach ($file in $uniqueFiles) {
    Copy-Item -LiteralPath $file.SourcePath -Destination (
      Join-Path $stagingPath $file.CanonicalName
    )
  }

  $manifestRows |
    Export-Csv -LiteralPath (Join-Path $stagingPath '_manifest.csv') `
      -NoTypeInformation `
      -Encoding utf8BOM

  $jsonManifest = [ordered]@{
    schemaVersion = 1
    createdOn = (Get-Date).ToString('yyyy-MM-dd')
    source = [ordered]@{
      folderName = [IO.Path]::GetFileName($sourceFullPath)
      fileCount = $sourceFiles.Count
      bytes = (
        $sourceFiles |
          Measure-Object -Property Bytes -Sum
      ).Sum
    }
    organized = [ordered]@{
      folderName = [IO.Path]::GetFileName($outputFullPath)
      layout = 'flat-deduplicated-by-sha256'
      fileCount = $uniqueFiles.Count
      bytes = $uniqueBytes
      duplicateFileCount = $duplicateFileCount
      articleReferencedUniqueFileCount = $articleReferencedHashes.Count
      articleReferencedPreservedInWikiCount = $preservedArticleHashes.Count
      unreferencedUniqueFileCount =
        $uniqueFiles.Count - $articleReferencedHashes.Count
    }
    files = @(
      $uniqueFiles |
        Select-Object CanonicalName, Bytes, Sha256, DuplicateCount
    )
  }
  $json = ($jsonManifest | ConvertTo-Json -Depth 8).Replace("`r`n", "`n")
  [IO.File]::WriteAllText(
    (Join-Path $stagingPath '_manifest.json'),
    $json + "`n",
    [Text.UTF8Encoding]::new($false)
  )

  $readme = @"
# Aceserver Newt画像整理

検証済みの完全バックアップは変更せず、画像を確認・選別しやすいように
内容が同一の重複だけをまとめて、このフォルダの直下へコピーしています。

- 元画像: $($sourceFiles.Count)ファイル
- 整理後: $($uniqueFiles.Count)ファイル
- 完全重複: $duplicateFileCount ファイル分
- 整理後容量: $uniqueBytes bytes
- Newt記事から参照されていた固有画像: $($articleReferencedHashes.Count)ファイル
- 現Wikiの公開assetまたは下書きarchiveで保全済み: $($preservedArticleHashes.Count)ファイル
- Newt記事から参照されていない整理対象: $($uniqueFiles.Count - $articleReferencedHashes.Count)ファイル

`_manifest.csv`には、元UUIDパス、直下ファイル名、SHA-256、Newt記事、
現Wikiでの保全先を記録しています。`_manifest.json`は整理後画像の検証用です。

未参照画像を新Wikiへ一括公開はしません。使用する場合は、画像の内容・現行性・
権利を記事単位で確認し、Web向けファイル名へ変更してMarkdown参照と同時に
通常のレビュー手順で反映してください。
"@.Replace("`r`n", "`n")
  [IO.File]::WriteAllText(
    (Join-Path $stagingPath '_README.md'),
    $readme,
    [Text.UTF8Encoding]::new($false)
  )

  foreach ($file in $uniqueFiles) {
    $targetPath = Join-Path $stagingPath $file.CanonicalName
    $targetHash = (
      Get-FileHash -LiteralPath $targetPath -Algorithm SHA256
    ).Hash.ToLowerInvariant()
    if ($targetHash -ne $file.Sha256) {
      throw "Copied file hash mismatch: $($file.CanonicalName)"
    }
  }

  [IO.Directory]::Move($stagingPath, $outputFullPath)
} catch {
  throw "$($_.Exception.Message) Staging directory retained at: $stagingPath"
}

Write-Host (
  "Organized $($sourceFiles.Count) Newt files into " +
  "$($uniqueFiles.Count) flat unique images at $outputFullPath"
)
