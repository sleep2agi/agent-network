export function formatSecretAssignment(platform: string, name: string, value: string): string {
  if (platform === "win32") {
    return `$env:${name}='${value.replace(/'/g, "''")}'`;
  }
  return `export ${name}='${value.replace(/'/g, `'\\''`)}'`;
}

export function secretPersistenceHeading(platform: string): string {
  return platform === "win32"
    ? "For cross-machine / cross-shell portability, add these assignments to your PowerShell $PROFILE or secrets manager:"
    : "For cross-machine / cross-shell portability, also append to ~/.bashrc / ~/.zshrc or your secrets manager:";
}

export function secretShellAction(platform: string): "set" | "export" {
  return platform === "win32" ? "set" : "export";
}

// #516 — the CLI must never print a secret value. Instead of
// `export NAME='<the key>'`, tell the user how to load NAME from the private
// per-node .env file the value was written to (mode 600, gitignored).
export function formatSecretLoadCommand(platform: string, name: string, dotenvPath: string): string {
  if (platform === "win32") {
    const p = dotenvPath.replace(/'/g, "''");
    return `$env:${name}=((Get-Content '${p}' | Where-Object { $_ -like '${name}=*' } | Select-Object -First 1) -replace '^${name}=','')`;
  }
  const p = `'${dotenvPath.replace(/'/g, `'\\''`)}'`;
  return `export ${name}="$(sed -n 's/^${name}=//p' ${p} | head -n 1)"`;
}
