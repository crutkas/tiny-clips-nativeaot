$ErrorActionPreference = 'Stop'

$workflowPath = Join-Path $PSScriptRoot '..\workflows\windows-store-publish.yml'
$workflow = Get-Content -LiteralPath $workflowPath -Raw
$match = [regex]::Match($workflow, '(?ms)^      - name: Prepare Internal Testing flight\r?\n.*?^        run: \|\r?\n(?<run>.*?)(?=^      - name:)')
if (-not $match.Success) { throw 'Internal Testing preparation step not found.' }
$prepare = [scriptblock]::Create(($match.Groups['run'].Value -replace '(?m)^          ', ''))

function Assert-True($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Invoke-RestMethod {
    param($Method, $Uri, $Headers, $ContentType, $Body)
    $script:requests.Add("$Method $Uri")
    if ($Uri -like 'https://login.microsoftonline.com/*') {
        return @{ access_token = 'mock-token' }
    }
    if ($Method -eq 'Get' -and $Uri -eq $script:applicationUri) { return @{ id = 'APP123' } }
    if ($Method -eq 'Get' -and $Uri -like "$script:applicationUri/listflights?*") {
        $script:listCalls++
        if ($script:listStatus -and $script:listCalls -eq $script:errorPage) {
            $response = [Net.Http.HttpResponseMessage]::new([Net.HttpStatusCode]$script:listStatus)
            throw [Microsoft.PowerShell.Commands.HttpResponseException]::new('Simulated API error', $response)
        }
        if ($script:errorPage -gt 1 -and $script:listCalls -eq 1) {
            return @{ value = @(@{ flightId = 'other-flight'; friendlyName = 'Other' }); '@nextLink' = 'next' }
        }
        return @{ value = $script:flights }
    }
    if ($Method -eq 'Post' -and $Uri -eq "$script:applicationUri/flights") {
        $created = $Body | ConvertFrom-Json
        Assert-True ($created.friendlyName -ceq 'Internal Testing') 'Unexpected flight name.'
        Assert-True (($created.groupIds -join ',') -eq 'group-1,group-2') 'Tester groups changed.'
        return $script:flight
    }
    if ($Method -eq 'Get' -and $Uri -eq "$script:applicationUri/flights/flight-1") {
        return $script:flight
    }
    if ($Method -eq 'Get' -and $Uri -eq "$script:applicationUri/flights/flight-1/submissions/submission-1") {
        return $script:submission
    }
    if ($Method -eq 'Delete' -and $Uri -eq "$script:applicationUri/flights/flight-1/submissions/submission-1") {
        return
    }
    throw "Unexpected request: $Method $Uri"
}

function Invoke-Scenario([string]$Name, [scriptblock]$Arrange, [scriptblock]$Verify, [string]$ExpectedError = '') {
    $script:applicationUri = 'https://manage.devcenter.microsoft.com/v1.0/my/applications/APP123'
    $script:requests = [Collections.Generic.List[string]]::new()
    $script:listStatus = 0
    $script:listCalls = 0
    $script:errorPage = 1
    $script:flight = @{ flightId = 'flight-1'; friendlyName = 'Internal Testing' }
    $script:flights = @($script:flight)
    $script:submission = @{ id = 'submission-1'; status = 'PendingCommit'; fileUploadUrl = 'https://example.invalid/upload' }
    $env:FLIGHT_GROUP_IDS = 'group-1, group-2'
    $env:REPLACE_FLIGHT_DRAFT = 'false'
    Clear-Content -LiteralPath $env:GITHUB_OUTPUT
    & $Arrange
    $failure = ''
    try { & $prepare | Out-Null } catch { $failure = $_.Exception.Message }
    if ($ExpectedError) {
        Assert-True ($failure.Contains($ExpectedError)) "$Name expected '$ExpectedError', received '$failure'."
        Assert-True (-not (Get-Content -LiteralPath $env:GITHUB_OUTPUT)) 'Failed preparation emitted a flight ID.'
    } else {
        Assert-True (-not $failure) "$Name unexpectedly failed: $failure"
        Assert-True ((Get-Content -LiteralPath $env:GITHUB_OUTPUT) -ceq 'flight_id=flight-1') 'Missing flight output.'
    }
    & $Verify
    "PASS: $Name"
}

$savedEnvironment = @{}
foreach ($name in @('STORE_PRODUCT_ID', 'PARTNER_CENTER_TENANT_ID', 'PARTNER_CENTER_CLIENT_ID', 'PARTNER_CENTER_CLIENT_SECRET', 'FLIGHT_GROUP_IDS', 'REPLACE_FLIGHT_DRAFT', 'GITHUB_OUTPUT')) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name)
}
$outputFile = New-TemporaryFile
try {
    $env:STORE_PRODUCT_ID = 'APP123'
    $env:PARTNER_CENTER_TENANT_ID = '11111111-1111-1111-1111-111111111111'
    $env:PARTNER_CENTER_CLIENT_ID = '22222222-2222-2222-2222-222222222222'
    $env:PARTNER_CENTER_CLIENT_SECRET = 'mock-secret'
    $env:GITHUB_OUTPUT = $outputFile.FullName

    Invoke-Scenario 'First-page 404 creates the flight' { $script:listStatus = 404 } {
        Assert-True ($script:requests.Contains("Post $script:applicationUri/flights")) 'Flight was not created.'
        Assert-True ($script:listCalls -eq 1) 'Empty flight list was paginated.'
    }
    Invoke-Scenario 'Empty successful list creates the flight' { $script:flights = @() } {
        Assert-True ($script:requests.Contains("Post $script:applicationUri/flights")) 'Flight was not created.'
    }
    foreach ($status in @(401, 403, 409, 500)) {
        Invoke-Scenario "First-page $status fails without mutation" { $script:listStatus = $status } {
            Assert-True (@($script:requests | Where-Object { $_ -match '^(Post|Delete) https://manage' }).Count -eq 0) 'List failure allowed mutation.'
        } 'could not list package flights'
    }
    Invoke-Scenario 'Later-page 404 fails without mutation' {
        $script:listStatus = 404
        $script:errorPage = 2
    } {
        Assert-True ($script:listCalls -eq 2) 'Second page was not requested.'
        Assert-True (@($script:requests | Where-Object { $_ -match '^(Post|Delete) https://manage' }).Count -eq 0) 'Partial list allowed mutation.'
    } 'could not list package flights'
    Invoke-Scenario 'Existing flight is preserved' {} {
        Assert-True (@($script:requests | Where-Object { $_ -match '^(Post|Delete) https://manage' }).Count -eq 0) 'Existing flight was mutated.'
    }
    Invoke-Scenario 'Pending API draft without flightId is reusable' {
        $script:flight.pendingFlightSubmission = @{ id = 'submission-1' }
    } {
        Assert-True (@($script:requests | Where-Object { $_ -like 'Delete *' }).Count -eq 0) 'API draft was deleted.'
    }
    Invoke-Scenario 'Mismatched submission ID fails without deletion' {
        $script:flight.pendingFlightSubmission = @{ id = 'submission-1' }
        $script:submission.id = 'wrong-id'
    } {
        Assert-True (@($script:requests | Where-Object { $_ -like 'Delete *' }).Count -eq 0) 'Mismatched submission was deleted.'
    } 'unexpected flight submission'
    Invoke-Scenario 'Portal draft is preserved without explicit approval' {
        $script:flight.pendingFlightSubmission = @{ id = 'submission-1' }
        $script:submission.Remove('fileUploadUrl')
    } {
        Assert-True (@($script:requests | Where-Object { $_ -like 'Delete *' }).Count -eq 0) 'Unapproved draft was deleted.'
    } 'portal-created draft'
    Invoke-Scenario 'Explicitly approved portal draft can be deleted without flightId' {
        $script:flight.pendingFlightSubmission = @{ id = 'submission-1' }
        $script:submission.Remove('fileUploadUrl')
        $env:REPLACE_FLIGHT_DRAFT = 'true'
    } {
        Assert-True (@($script:requests | Where-Object { $_ -like 'Delete *' }).Count -eq 1) 'Expected exactly one draft deletion.'
    }
    Invoke-Scenario 'Non-editable submission cannot be deleted even with approval' {
        $script:flight.pendingFlightSubmission = @{ id = 'submission-1' }
        $script:submission.status = 'PreProcessing'
        $script:submission.Remove('fileUploadUrl')
        $env:REPLACE_FLIGHT_DRAFT = 'true'
    } {
        Assert-True (@($script:requests | Where-Object { $_ -like 'Delete *' }).Count -eq 0) 'Non-editable submission was deleted.'
    } 'not an editable draft'
} finally {
    Remove-Item -LiteralPath $outputFile.FullName
    foreach ($name in $savedEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name])
    }
}
