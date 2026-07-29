param(
  [Parameter(Mandatory = $true)]
  [string]$ArchivePath,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'

$archive = Get-Item -LiteralPath $ArchivePath
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

        [ordered]@{
          path = $_.FullName.Replace('\', '/')
          bytes = $_.Length
          sha256 = $entryHash
        }
      }
  )

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
        status = 'local-backup-verified-pending-user-review'
        verifiedOn = '2026-07-29'
        localZipSha256Verified = $true
        localExtractedFolderName = 'Aceserver-Newt完全バックアップ-2026-07-29'
        localExtractedFileCount = 72
        localExtractedBytes = 57115787
        plannedRemoteCopy = [ordered]@{
          status = 'not-created'
          type = 'private-github-release-asset'
          repository = 'acecore-systems/aceserver-wiki'
          tag = 'newt-export-2026-07-29'
          assetName = 'aceserver-newt-assets-2026-07-29.zip'
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
