import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const task = process.argv[2];
const windows = process.platform === 'win32';
if (!['launch', 'chroma'].includes(task) || (process.platform !== 'linux' && !windows)) {
  console.error('Expected launch or chroma on Windows or Linux.');
  process.exit(2);
}
const script = task === 'launch'
  ? path.join(root, windows ? 'start-local-rag.ps1' : 'start-local-rag.sh')
  : path.join(root, 'rag', 'scripts', windows ? 'start-chroma.ps1' : 'start-chroma.sh');
const command = windows ? 'powershell.exe' : 'bash';
const args = windows
  ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...process.argv.slice(3)]
  : [script, ...process.argv.slice(3)];
const child = spawn(command, args, { stdio: 'inherit', windowsHide: false });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
