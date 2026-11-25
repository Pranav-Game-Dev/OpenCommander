Set-Location "C:\Users\Pranav_\Desktop\My Projects\Desktop Commander MCP Server"
if (-not (Test-Path .git)) { git init -b main }
git add -A
git status --short | Select-Object -First 90
git commit -m "OpenCommander v1.0.0: first public release" 2>&1 | Select-Object -Last 3
git remote remove origin 2>$null
git remote add origin https://github.com/Pranav-Game-Dev/OpenCommander.git
git push -u origin main 2>&1
"PUSH EXIT $LASTEXITCODE"
