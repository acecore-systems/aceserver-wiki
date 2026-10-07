param(
  [Parameter(Mandatory = $true)]
  [string]$ArchivePath,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath,

  [Parameter(Mandatory = $true)]
  [string]$OrganizedPath
)

$ErrorActionPreference = 'Stop'

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

$archive = Get-Item -LiteralPath $ArchivePath
$organizedDirectory = Get-Item -LiteralPath $OrganizedPath
$outputFullPath = [IO.Path]::GetFullPath($OutputPath)
$outputDirectory = [IO.Path]::GetDirectoryName($outputFullPath)

if (-not (Test-Path -LiteralPath $outputDirectory -PathType Container)) {
  throw "Output directory does not exist: $outputDirectory"
}

Add-Type -AssemblyName System.IO.Compression.FileSystem

$archiveHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive.FullName).Hash.ToLowerInvariant()
$zip = [IO.Compression.ZipFile]::OpenRead($archive.FullName)
$sha256 = [Security.Cryptography.SHA256]::Create()

try {
  $unsafeEntries = @(
    $zip.Entries | Where-Object {
      [IO.Path]::IsPathRooted($_.FullName) -or
      $_.FullName -match '(^|/|\\)\.\.($|/|\\)'
    }
  )

  if ($unsafeEntries.Count -ne 0) {
    throw "Archive contains unsafe paths: $($unsafeEntries.FullName -join ', ')"
  }

  $fileEntries = @(
    $zip.Entries | Where-Object { -not [string]::IsNullOrEmpty($_.Name) }
  )
  $totalUncompressedBytes = ($fileEntries | Measure-Object -Property Length -Sum).Sum

  $files = @(
    $fileEntries |
      Sort-Object FullName |
      ForEach-Object {
        $stream = $_.Open()
        try {
          $entryHash = [Convert]::ToHexString($sha256.ComputeHash($stream)).ToLowerInvariant()
        } finally {
          $stream.Dispose()
        }

        [pscustomobject][ordered]@{
          path = $_.FullName.Replace('\', '/')
          bytes = $_.Length
          sha256 = $entryHash
        }
      }
  )

  $organizedManifestPath = Join-Path $organizedDirectory.FullName '_manifest.json'
  $organizedMappingPath = Join-Path $organizedDirectory.FullName '_manifest.csv'
  $organizedReadmePath = Join-Path $organizedDirectory.FullName '_README.md'
  if (
    -not (Test-Path -LiteralPath $organizedManifestPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $organizedMappingPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $organizedReadmePath -PathType Leaf)
  ) {
    throw 'The organized copy is missing a required metadata file.'
  }

  $organizedManifest = Get-Content -Raw -LiteralPath $organizedManifestPath |
    ConvertFrom-Json
  $organizedMappingRows = @(Import-Csv -LiteralPath $organizedMappingPath)
  $topLevelFiles = @(
    Get-ChildItem -LiteralPath $organizedDirectory.FullName -File
  )
  $nestedOrganizedFiles = @(
    Get-ChildItem -LiteralPath $organizedDirectory.FullName -Recurse -File |
      Where-Object { $_.DirectoryName -ne $organizedDirectory.FullName }
  )
  if ($nestedOrganizedFiles.Count -ne 0) {
    throw 'The organized copy must not contain nested files.'
  }

  $organizedFilesByName = @{}
  $canonicalNameByHash = @{}
  foreach ($file in $organizedManifest.files) {
    $organizedFilesByName[[string]$file.CanonicalName] = $file
    $canonicalNameByHash[[string]$file.Sha256] =
      [string]$file.CanonicalName
  }

  $metadataFileNames = @('_manifest.json', '_manifest.csv', '_README.md')
  $organizedImageFiles = @(
    $topLevelFiles |
      Where-Object { $_.Name -notin $metadataFileNames }
  )
  if (
    $organizedImageFiles.Count -ne 69 -or
    $organizedFilesByName.Count -ne $organizedImageFiles.Count -or
    $organizedMappingRows.Count -ne $files.Count -or
    $topLevelFiles.Count -ne ($organizedImageFiles.Count + 3)
  ) {
    throw 'The organized copy file or mapping count changed.'
  }

  $organizedActualHashes = @()
  foreach ($file in $organizedImageFiles) {
    if (-not $organizedFilesByName.ContainsKey($file.Name)) {
      throw "Organized image is absent from _manifest.json: $($file.Name)"
    }

    $expected = $organizedFilesByName[$file.Name]
    $actualHash = (
      Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256
    ).Hash.ToLowerInvariant()
    if (
      [long]$expected.Bytes -ne $file.Length -or
      [string]$expected.Sha256 -ne $actualHash
    ) {
      throw "Organized image differs from _manifest.json: $($file.Name)"
    }

    $organizedActualHashes += $actualHash
  }

  $archiveUniqueHashes = @(
    $files.sha256 |
      Sort-Object -Unique
  )
  $organizedUniqueHashes = @(
    $organizedActualHashes |
      Sort-Object -Unique
  )
  if (
    @(
      Compare-Object $archiveUniqueHashes $organizedUniqueHashes
    ).Count -ne 0
  ) {
    throw 'The organized image SHA-256 set differs from the ZIP archive.'
  }

  $archiveFilesByPath = @{}
  foreach ($file in $files) {
    $archiveFilesByPath[[string]$file.path] = $file
  }
  $primaryPathByHash = @{}
  foreach ($hashGroup in $files | Group-Object sha256) {
    $primaryPathByHash[[string]$hashGroup.Name] = [string](
      $hashGroup.Group.path |
        Sort-Object |
        Select-Object -First 1
    )
  }

  $wikiRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
  $articleExportPath = Join-Path $wikiRoot (
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
  foreach (
    $directory in @(
      (Join-Path $wikiRoot 'public\uploads\wiki'),
      (Join-Path $wikiRoot 'migration\newt-draft-assets-2026-07-29')
    )
  ) {
    foreach ($file in Get-ChildItem -LiteralPath $directory -File) {
      $hash = (
        Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256
      ).Hash.ToLowerInvariant()
      if (-not $wikiAssetsByHash.ContainsKey($hash)) {
        $wikiAssetsByHash[$hash] = @()
      }
      $wikiAssetsByHash[$hash] += $file.FullName.Substring(
        $wikiRoot.Length
      ).TrimStart('\').Replace('\', '/')
    }
  }

  $seenMappingPaths = @{}
  foreach ($row in $organizedMappingRows) {
    $originalPath = [string]$row.original_path
    if (
      $seenMappingPaths.ContainsKey($originalPath) -or
      -not $archiveFilesByPath.ContainsKey($originalPath)
    ) {
      throw "Invalid or duplicate mapping path: $originalPath"
    }
    $seenMappingPaths[$originalPath] = $true

    $archiveFile = $archiveFilesByPath[$originalPath]
    $rowSha256 = [string]$archiveFile.sha256
    $segments = @($originalPath.Split('/'))
    $articleRefs = if ($articleRefsByPath.ContainsKey($originalPath)) {
      @($articleRefsByPath[$originalPath])
    } else {
      @()
    }
    $wikiPaths = if ($wikiAssetsByHash.ContainsKey($rowSha256)) {
      @($wikiAssetsByHash[$rowSha256])
    } else {
      @()
    }
    $expectedDuplicateOf = if (
      $originalPath -eq $primaryPathByHash[$rowSha256]
    ) {
      ''
    } else {
      $primaryPathByHash[$rowSha256]
    }
    $expectedSlugs = (
      $articleRefs |
        ForEach-Object { $_.Slug } |
        Sort-Object -Unique
    ) -join '; '
    $expectedTitles = (
      $articleRefs |
        ForEach-Object { $_.Title } |
        Sort-Object -Unique
    ) -join '; '
    $expectedWikiPaths = (
      $wikiPaths |
        Sort-Object -Unique
    ) -join '; '

    $mappingChecks = [ordered]@{
      pathSegments = $segments.Count -eq 2
      sourceUuid = [string]$row.source_uuid -eq $segments[0]
      originalName = [string]$row.original_name -eq $segments[1]
      bytes = [long]$row.bytes -eq [long]$archiveFile.bytes
      sha256 = [string]$row.sha256 -eq $rowSha256
      canonicalName =
        [string]$row.canonical_name -eq $canonicalNameByHash[$rowSha256]
      duplicateOf = [string]$row.duplicate_of -eq [string]$expectedDuplicateOf
      articleSlugs =
        [string]$row.newt_article_slugs -eq [string]$expectedSlugs
      articleTitles =
        [string]$row.newt_article_titles -eq [string]$expectedTitles
      wikiPaths =
        [string]$row.current_wiki_paths -eq [string]$expectedWikiPaths
    }
    $invalidFields = @(
      $mappingChecks.GetEnumerator() |
        Where-Object { -not $_.Value } |
        ForEach-Object Key
    )
    if ($invalidFields.Count -ne 0) {
      throw (
        "Organized mapping row differs from the evidence " +
        "($($invalidFields -join ', ')): $originalPath"
      )
    }
  }

  if ($seenMappingPaths.Count -ne $archiveFilesByPath.Count) {
    throw 'The organized mapping does not cover every ZIP archive path.'
  }

  $organizedBytes = (
    $organizedImageFiles |
      Measure-Object -Property Length -Sum
  ).Sum
  if (
    [long]$organizedManifest.source.fileCount -ne $files.Count -or
    [long]$organizedManifest.source.bytes -ne $totalUncompressedBytes -or
    [long]$organizedManifest.organized.fileCount -ne
      $organizedImageFiles.Count -or
    [long]$organizedManifest.organized.bytes -ne $organizedBytes -or
    [long]$organizedManifest.organized.duplicateFileCount -ne
      ($files.Count - $organizedImageFiles.Count)
  ) {
    throw 'The organized copy summary differs from the archive inventory.'
  }

  $organizedManifestHash = (
    Get-FileHash -LiteralPath $organizedManifestPath -Algorithm SHA256
  ).Hash.ToLowerInvariant()
  $organizedMappingHash = (
    Get-FileHash -LiteralPath $organizedMappingPath -Algorithm SHA256
  ).Hash.ToLowerInvariant()

  $manifest = [ordered]@{
    schemaVersion = 1
    observedOn = '2026-07-29'
    source = [ordered]@{
      service = 'Newt'
      spaceUid = 'aceserver'
      captureMethod = 'Newt space asset bulk download'
    }
    archive = [ordered]@{
      originalFileName = $archive.Name
      retainedFileName = 'aceserver-newt-assets-2026-07-29.zip'
      bytes = $archive.Length
      sha256 = $archiveHash
      entryCount = $zip.Entries.Count
      fileCount = $files.Count
      directoryCount = $zip.Entries.Count - $files.Count
      totalUncompressedBytes = $totalUncompressedBytes
      unsafeEntryCount = 0
      retention = [ordered]@{
        status = 'local-backup-verified-and-organized'
        verifiedOn = '2026-07-29'
        localZipSha256Verified = $true
        localExtractedFolderName = 'Aceserver-Newt完全バックアップ-2026-07-29'
        localExtractedFileCount = 72
        localExtractedBytes = 57115787
        organizedCopy = [ordered]@{
          status = 'created-and-verified'
          createdOn = [string]$organizedManifest.createdOn
          localFolderName = $organizedDirectory.Name
          layout = [string]$organizedManifest.organized.layout
          sourceFileCount = [long]$organizedManifest.source.fileCount
          fileCount = $organizedImageFiles.Count
          duplicateFileCount =
            [long]$organizedManifest.organized.duplicateFileCount
          bytes = [long]$organizedBytes
          manifestFileName = '_manifest.json'
          manifestSha256 = $organizedManifestHash
          mappingFileName = '_manifest.csv'
          mappingSha256 = $organizedMappingHash
        }
        remoteCopy = [ordered]@{
          status = 'not-planned'
          decisionOn = '2026-07-30'
          policy = 'local-curation-before-selective-wiki-import'
        }
      }
    }
    files = $files
  }

  $json = ($manifest | ConvertTo-Json -Depth 8).Replace("`r`n", "`n")
  [IO.File]::WriteAllText($outputFullPath, $json + "`n", [Text.UTF8Encoding]::new($false))
} finally {
  $sha256.Dispose()
  $zip.Dispose()
}

Write-Host "Inventoried $($files.Count) Newt asset files into $outputFullPath"
