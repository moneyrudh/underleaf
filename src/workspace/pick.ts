/**
 * The system's own folder dialog, shown by the server (a web page can't learn a folder's real path).
 * Returns the chosen folder, null when cancelled, or "unsupported" where no dialog is available.
 */
export async function pickFolder(): Promise<string | null | "unsupported"> {
  const prompt = "Open a folder in underleaf";
  let cmd: string[] | null = null;
  if (process.platform === "darwin") {
    cmd = ["osascript", "-e", `POSIX path of (choose folder with prompt "${prompt}")`];
  } else if (process.platform === "win32") {
    const ps = `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = "${prompt}"; if ($d.ShowDialog() -eq "OK") { $d.SelectedPath }`;
    cmd = ["powershell", "-NoProfile", "-Command", ps];
  } else if (Bun.which("zenity")) {
    cmd = ["zenity", "--file-selection", "--directory", `--title=${prompt}`];
  } else if (Bun.which("kdialog")) {
    cmd = ["kdialog", "--getexistingdirectory", ".", "--title", prompt];
  }
  if (!cmd) return "unsupported";
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return out ? out.replace(/\/$/, "") || "/" : null; // cancelling prints nothing
}
