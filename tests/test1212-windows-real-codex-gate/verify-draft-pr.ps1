$ErrorActionPreference = "Stop"
if ($env:EXPECTED_SHA -notmatch '^[0-9a-f]{40}$') { throw "source_sha must be a full lowercase SHA" }
if ($env:DRAFT_PR -notmatch '^[1-9][0-9]*$') { throw "draft_pr_number must be numeric" }
$actual = (git rev-parse HEAD).Trim()
if ($actual -ne $env:EXPECTED_SHA) { throw "checkout/source SHA mismatch" }
$repo = $env:GITHUB_REPOSITORY
if (-not $repo -or -not $env:GH_TOKEN) { throw "GitHub identity inputs unavailable; refusing run" }
$headers = @{ Authorization = "Bearer $env:GH_TOKEN"; Accept = "application/vnd.github+json" }
$pr = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$repo/pulls/$env:DRAFT_PR"
if ($pr.draft -ne $true) { throw "PR is not Draft; protected qualification is Draft-only" }
if ($pr.head.sha -ne $actual) { throw "Draft PR head does not equal checked-out source SHA" }

