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
