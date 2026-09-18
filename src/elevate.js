// Running one program elevated (a UAC prompt) and waiting for it to finish.
//
// Needed for exactly one job so far: ReShade's 32-bit Vulkan layer. A 32-bit DirectX 9 game swapped
// from dgVoodoo2 to DXVK (Assassin's Creed II, 2026-09-18) presents through Vulkan, so the game-folder
// ReShade dxgi.dll the DLSS5 Feeder rides on is never loaded again -- ReShade has to be the Vulkan
// layer instead, and ReShade's setup registers that under HKLM and C:\ProgramData\ReShade, both
// admin-only. The setup relaunches itself elevated when it is not, but that relaunch drops
// --headless and does not wait (setup/MainWindow.xaml.cs RestartWithElevatedPrivileges, v6.8.0), so
// the only way to get a headless run with an exit code is to start it elevated in the first place.
//
// PowerShell's Start-Process -Verb RunAs -Wait -PassThru is what does that from a non-elevated
// process and hands the child's exit code back. A declined UAC prompt makes Start-Process throw
// ("The operation was canceled by the user"), which is reported as `cancelled`, not as a failure of
// the program itself.
'use strict';

const ERROR_CANCELLED = 1223;

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// Start-Process joins -ArgumentList with spaces and passes it on as one command line, so an argument
// with a space in it (a game path under "D:\Games\Assassins Creed II") needs its own double quotes.
// Windows paths cannot contain a double quote, so wrapping is enough.
function argForStartProcess(a) {
  const s = String(a);
  return psQuote(/[\s]/.test(s) ? `"${s}"` : s);
}

function elevatedScript(file, args = []) {
  const list = args.length ? ` -ArgumentList @(${args.map(argForStartProcess).join(',')})` : '';
  return [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    `  $p = Start-Process -FilePath ${psQuote(file)}${list} -Verb RunAs -Wait -PassThru -WindowStyle Hidden`,
    '  exit $p.ExitCode',
    '} catch {',
    "  [Console]::Out.WriteLine('ELEVATION-FAILED: ' + $_.Exception.Message)",
    `  exit ${ERROR_CANCELLED}`,
    '}',
  ].join('\n');
}

// { ok, code, cancelled, output }. execFileAsync is main.js's promisified execFile, injected so the
// tests can stand in for PowerShell.
async function runElevated(file, args, { execFileAsync, timeoutMs = 5 * 60 * 1000 } = {}) {
  if (!execFileAsync) throw new Error('runElevated needs execFileAsync');
  const script = elevatedScript(file, args);
  try {
    const { stdout } = await execFileAsync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: timeoutMs });
    return { ok: true, code: 0, cancelled: false, output: String(stdout || '').trim() };
  } catch (error) {
    const output = `${error && error.stdout ? error.stdout : ''}${error && error.stderr ? error.stderr : ''}`.trim();
    const code = error && typeof error.code === 'number' ? error.code : null;
    const cancelled = /ELEVATION-FAILED/.test(output) && /cancel+ed by the user/i.test(output);
    return { ok: false, code, cancelled, output: output || String(error && error.message ? error.message : error) };
  }
}

// A PowerShell command run elevated, passed as -EncodedCommand so no path in it needs a second
// round of quoting through Start-Process.
async function runElevatedPowerShell(command, opts) {
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  return runElevated('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], opts);
}

module.exports = { runElevated, runElevatedPowerShell, elevatedScript, psQuote, ERROR_CANCELLED };
