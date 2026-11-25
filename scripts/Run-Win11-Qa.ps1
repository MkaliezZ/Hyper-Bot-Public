param([string]$CleanImage,[switch]$Rehearsal)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$os=Get-CimInstance Win32_OperatingSystem
if(!$Rehearsal -and ($os.ProductType -ne 1 -or [int]$os.BuildNumber -lt 22000 -or $os.Caption -notmatch 'Windows 11\b')){
  throw 'The runner requires a Windows 11 client.'
}
if(!$Rehearsal -and [string]::IsNullOrWhiteSpace($CleanImage)){
  throw 'Supply the verified Windows 11 environment identifier with -CleanImage.'
}
$source=$PSScriptRoot
$target=Join-Path $env:LOCALAPPDATA 'HyperBotTargetQa'
New-Item -Type Directory -Path $target -ErrorAction Stop | Out-Null
$log=Join-Path $target 'Runner.log'
Start-Transcript -Path $log | Out-Null
$code=1
try {
  $manifest=Get-Content -LiteralPath (Join-Path $source 'Payload.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach($file in $manifest.files){
    $origin=Join-Path $source $file.name
    $hash=(Get-FileHash -Algorithm SHA256 -LiteralPath $origin).Hash.ToLowerInvariant()
    if($hash -ne $file.sha256){throw ('Invalid test bundle: '+$file.name)}
    Copy-Item -LiteralPath $origin -Destination $target
  }
  Set-Location -LiteralPath $target
  $tar=Join-Path $env:SystemRoot 'System32/tar.exe'
  foreach($file in @($manifest.candidate,$manifest.tool,'Runtimes.tgz')){
    & $tar -xf $file -C $target
    if($LASTEXITCODE -ne 0){throw ('Failed to extract '+$file)}
  }
  $plan=Get-Content -LiteralPath (Join-Path $manifest.toolFolder '验收清单.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $runtimes=Join-Path $target 'runtimes'
  $venv=Join-Path $target 'venv'
  & (Join-Path $runtimes 'python/python.exe') -I -m venv --without-pip --copies $venv
  if($LASTEXITCODE -ne 0){throw 'Python environment preparation failed.'}
  & robocopy.exe (Join-Path $runtimes 'site-packages') (Join-Path $venv 'Lib/site-packages') /E /XJ /R:1 /W:1 /NJH /NJS /NODD /NDL /NFL /NP
  if($LASTEXITCODE -ge 8){throw 'Python packages could not be restored.'}
  $env:PATH=(Join-Path $runtimes 'git-bin')+';'+(Join-Path $env:SystemRoot 'System32')
  $env:HYPER_BOT_WORKBENCH_ROOT=Join-Path $runtimes 'self-media-workbench'
  $env:HYPER_BOT_HERMES_ROOT=Join-Path $runtimes 'hermes-agent'
  $env:HYPER_BOT_WORKBENCH_PYTHON=Join-Path $venv 'Scripts/python.exe'
  $env:HYPER_BOT_HERMES_PYTHON=$env:HYPER_BOT_WORKBENCH_PYTHON
  $git=Join-Path $runtimes 'git-bin/git.exe'
  & $git -C $env:HYPER_BOT_HERMES_ROOT config --local core.autocrlf true
  if($LASTEXITCODE -ne 0){throw 'Hermes ACP checkout line ending setup failed.'}
  # Restore Git's stat cache for the extracted checkout before the app verifies it.
  & $git -C $env:HYPER_BOT_HERMES_ROOT update-index --refresh
  if($LASTEXITCODE -ne 0){throw 'Hermes ACP checkout did not refresh cleanly.'}
  & $git -C $env:HYPER_BOT_WORKBENCH_ROOT update-index --refresh
  if($LASTEXITCODE -ne 0){throw 'Self Media Workbench checkout did not refresh cleanly.'}
  foreach($name in @('DEEPSEEK_API_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY','SELF_MEDIA_STATE_DIR','SELF_MEDIA_DATA_DIR')){
    [Environment]::SetEnvironmentVariable($name,$null,'Process')
  }
  $node=Join-Path $plan.candidate.folder 'resources/node/node.exe'
  $script=Join-Path $manifest.toolFolder 'scripts/test-windows-target.mjs'
  $arguments=@('--candidate',$plan.candidate.name,'--previous',$plan.previous.name,'--out','Evidence','--integrations')
  if($Rehearsal){$arguments+='--rehearsal'}
  else{$arguments+=@('--clean-image',$CleanImage)}
  & $node $script @arguments
  $code=$LASTEXITCODE
} catch {
  Write-Output $_.Exception.Message
} finally {
  [IO.File]::WriteAllText((Join-Path $target 'ExitCode.txt'),[string]$code)
  Stop-Transcript | Out-Null
}
exit $code
