$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$workflowPath = Join-Path $PSScriptRoot '..\workflows\windows-launch-smoke.yml'
$workflow = Get-Content -LiteralPath $workflowPath -Raw
$match = [regex]::Match($workflow, '(?m)^      - name: Use local NVMe for ARM64 build\r?\n(?<step>(?:^        .*\r?\n|^\r?\n)+)')
if (-not $match.Success) { throw 'NVMe setup step not found.' }
$step = $match.Groups['step'].Value
$run = $step.Substring($step.IndexOf("        run: |") + "        run: |".Length).TrimStart("`r", "`n")
$setup = [scriptblock]::Create(($run -replace '(?m)^          ', ''))

function Assert-True($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

Assert-True ($step.Contains("if: inputs.use_local_nvme && inputs.source == 'build' && matrix.runner == 'windows-11-arm'")) 'Pilot gating changed.'
Assert-True ($workflow.IndexOf($match.Value) -lt $workflow.IndexOf('      - name: Checkout code')) 'Setup must precede checkout.'
Assert-True ([regex]::IsMatch($workflow, 'use_local_nvme:\r?\n        description: .*\r?\n        type: boolean\r?\n        default: false')) 'Pilot must be opt-in.'

$parseErrors = $null
$null = [Management.Automation.Language.Parser]::ParseInput($setup.ToString(), [ref]$null, [ref]$parseErrors)
Assert-True ($parseErrors.Count -eq 0) "PowerShell parse errors: $parseErrors"

function New-TestDisk([int]$Number = 1, [long]$Size = 100) {
    [pscustomobject]@{
        Number = $Number; Size = $Size; PartitionStyle = 'RAW'; IsBoot = $false
        IsSystem = $false; BusType = 'NVMe'; FriendlyName = 'Local NVMe'
        IsOffline = $false; IsReadOnly = $false
    }
}

function Get-Disk { $script:disks }
function Get-Volume {
    param($DriveLetter)
    Assert-True ($DriveLetter -eq 'D') 'Unexpected volume inspection.'
    [pscustomobject]@{ DriveLetter = 'D'; FileSystemType = 'ReFS'; FileSystemLabel = 'DevDrive' }
}
function Test-Path { param($LiteralPath) $script:driveTaken }
function Get-Item { param($LiteralPath, [switch]$Force) $script:workspace }
function Get-ChildItem { param($LiteralPath, [switch]$Force) $script:files }
function Set-Location { param($LiteralPath) $script:operations.Add("cd:$LiteralPath") }
function Write-Warning { param($Message) $script:warnings.Add($Message) }
function Set-Disk {
    param([Parameter(ValueFromPipeline)]$InputObject, [bool]$IsOffline, [bool]$IsReadOnly)
    process {
        $script:operations.Add("set:$($InputObject.Number):$($PSBoundParameters.Keys -join ',')")
    }
}
function Initialize-Disk {
    param([Parameter(ValueFromPipeline)]$InputObject, $PartitionStyle, [switch]$PassThru)
    process {
        Assert-True ($PartitionStyle -eq 'GPT' -and $PassThru) 'Unexpected initialization options.'
        $script:operations.Add("initialize:$($InputObject.Number)")
        $InputObject
    }
}
function New-Partition {
    param([Parameter(ValueFromPipeline)]$InputObject, $DriveLetter, [switch]$UseMaximumSize)
    process {
        Assert-True ($DriveLetter -eq 'D' -and $UseMaximumSize) 'Unexpected partition options.'
        $script:operations.Add('partition')
        $InputObject
    }
}
function Format-Volume {
    param([Parameter(ValueFromPipeline)]$InputObject, [switch]$DevDrive, $FileSystem, $NewFileSystemLabel, [bool]$Confirm, [switch]$Force)
    process {
        Assert-True ($DevDrive -and $FileSystem -eq 'ReFS' -and $NewFileSystemLabel -eq 'DevDrive' -and -not $Confirm -and $Force) 'Expected a ReFS Dev Drive.'
        $script:operations.Add('format')
        if ($script:failFormat) { throw 'Simulated disk failure' }
    }
}
function New-Item {
    param($ItemType, [switch]$Force, [string[]]$Path, $Target)
    $script:operations.Add("new:$ItemType")
    if ($ItemType -eq 'Junction') {
        Assert-True ($Path.Count -eq 1 -and $Path[0] -eq $env:GITHUB_WORKSPACE -and $Target -eq 'D:\workspace') 'Unexpected junction.'
    } else {
        Assert-True (($Path -join ',') -eq 'D:\workspace,D:\tmp,D:\nuget\packages,D:\nuget\http-cache') 'Missing local storage directories.'
    }
}
function Add-Content {
    param($LiteralPath, $Encoding, [string[]]$Value)
    Assert-True ($LiteralPath -eq $env:GITHUB_ENV -and $Encoding -eq 'utf8') 'Unexpected environment file.'
    $script:operations.Add('environment')
    $script:environment.AddRange($Value)
}

function Invoke-Scenario([string]$Name, [scriptblock]$Arrange, [scriptblock]$Verify, [string]$ExpectedError = '') {
    $script:disks = @(New-TestDisk)
    $script:driveTaken = $false
    $script:files = @()
    $script:failFormat = $false
    $script:failDelete = $false
    $script:operations = [Collections.Generic.List[string]]::new()
    $script:warnings = [Collections.Generic.List[string]]::new()
    $script:environment = [Collections.Generic.List[string]]::new()
    $script:workspace = [pscustomobject]@{
        FullName = 'C:\runner\work\repo\repo'; PSIsContainer = $true
        Attributes = [IO.FileAttributes]::Directory
    }
    $script:workspace | Add-Member -MemberType ScriptMethod -Name Delete -Value {
        $script:operations.Add('delete-empty-workspace')
        if ($script:failDelete) { throw 'Simulated non-empty directory race' }
    }
    $env:GITHUB_ACTIONS = 'true'
    $env:RUNNER_ENVIRONMENT = 'github-hosted'
    $env:RUNNER_OS = 'Windows'
    $env:RUNNER_ARCH = 'ARM64'
    $env:GITHUB_WORKSPACE = $script:workspace.FullName
    $env:RUNNER_TEMP = $PSScriptRoot
    $env:GITHUB_ENV = 'C:\runner\temp\environment'
    & $Arrange
    $failure = ''
    try { & $setup | Out-Null } catch { $failure = $_.Exception.Message }
    if ($ExpectedError) {
        Assert-True ($failure.Contains($ExpectedError)) "$Name expected '$ExpectedError', received '$failure'."
    } else {
        Assert-True (-not $failure) "$Name unexpectedly failed: $failure"
    }
    & $Verify
    "PASS: $Name"
}

$savedEnvironment = @{}
foreach ($name in @('GITHUB_ACTIONS', 'RUNNER_ENVIRONMENT', 'RUNNER_OS', 'RUNNER_ARCH', 'GITHUB_WORKSPACE', 'RUNNER_TEMP', 'GITHUB_ENV')) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name)
}
$savedDirectory = [Environment]::CurrentDirectory
try {
    foreach ($guard in @(
        @{ Name = 'GITHUB_ACTIONS'; Value = 'false' }
        @{ Name = 'RUNNER_ENVIRONMENT'; Value = 'self-hosted' }
        @{ Name = 'RUNNER_OS'; Value = 'Linux' }
        @{ Name = 'RUNNER_ARCH'; Value = 'X64' }
    )) {
        Invoke-Scenario "Reject $($guard.Name)" {
            [Environment]::SetEnvironmentVariable($guard.Name, $guard.Value)
        } {
            Assert-True ($script:operations.Count -eq 0) 'Guard allowed mutation.'
        } 'restricted to GitHub-hosted Windows ARM64'
    }
    Invoke-Scenario 'No local disk' { $script:disks = @() } {
        Assert-True ($script:operations.Count -eq 0 -and $script:warnings.Count -eq 1) 'Missing disk must warn without mutation.'
    }
    Invoke-Scenario 'Occupied D:' { $script:driveTaken = $true } {
        Assert-True ($script:operations.Count -eq 0 -and $script:warnings.Count -eq 1) 'Occupied drive must warn without mutation.'
    }
    foreach ($property in @('IsBoot', 'IsSystem', 'PartitionStyle', 'BusType', 'FriendlyName')) {
        Invoke-Scenario "Reject disk with unsafe $property" {
            $script:disks[0].$property = switch ($property) {
                'PartitionStyle' { 'GPT' }
                'BusType' { 'SCSI' }
                'FriendlyName' { 'Unknown disk' }
                default { $true }
            }
        } {
            Assert-True ($script:operations.Count -eq 0 -and $script:warnings.Count -eq 1) 'Unsafe disk was used.'
        }
    }
    Invoke-Scenario 'Non-empty workspace including hidden files' { $script:files = @('.git') } {
        Assert-True ($script:operations.Count -eq 0) 'Non-empty workspace allowed mutation.'
    } 'requires an empty'
    Invoke-Scenario 'Redirected workspace' { $script:workspace.Attributes = [IO.FileAttributes]::ReparsePoint } {
        Assert-True ($script:operations.Count -eq 0) 'Redirected workspace allowed mutation.'
    } 'requires an empty'
    Invoke-Scenario 'Format failure is explicit' { $script:failFormat = $true } {
        Assert-True ($script:environment.Count -eq 0 -and -not $script:operations.Contains('delete-empty-workspace')) 'Failed setup published success or deleted workspace.'
    } 'Simulated disk failure'
    Invoke-Scenario 'Files arriving after preflight abort deletion' { $script:failDelete = $true } {
        Assert-True ($script:environment.Count -eq 0 -and -not $script:operations.Contains('new:Junction')) 'Failed deletion published success.'
    } 'Simulated non-empty directory race'
    Invoke-Scenario 'Successful setup selects largest eligible disk' {
        $script:disks = @(New-TestDisk 1 100; New-TestDisk 2 200)
        $script:disks[1].IsOffline = $true
        $script:disks[1].IsReadOnly = $true
    } {
        $expected = 'initialize:2,partition,format,new:Directory,cd:' + $env:RUNNER_TEMP + ',delete-empty-workspace,new:Junction,environment'
        Assert-True (($script:operations | Where-Object { $_ -notlike 'set:*' }) -join ',' -eq $expected) 'Setup order changed.'
        Assert-True (@($script:operations | Where-Object { $_ -like 'set:*' }).Count -eq 2) 'Offline/read-only flags not cleared.'
        Assert-True (($script:environment -join ',') -eq 'TEMP=D:\tmp,TMP=D:\tmp,NUGET_PACKAGES=D:\nuget\packages,NUGET_HTTP_CACHE_PATH=D:\nuget\http-cache,SMOKE_STORAGE=local-nvme-dev-drive') 'Environment relocation incomplete.'
        Assert-True ($script:warnings.Count -eq 0) 'Successful setup warned.'
    }
} finally {
    foreach ($name in $savedEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name])
    }
    [Environment]::CurrentDirectory = $savedDirectory
}
