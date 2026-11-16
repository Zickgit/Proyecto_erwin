// Levanta Nodo A (3001) y Nodo B (3002) como DOS PROCESOS independientes,
// cada uno con su propio .env y su propio archivo SQLite. Ctrl+C detiene ambos.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodes = [
  { id: 'A', env: 'config/nodeA.env', color: '\x1b[36m' },
  { id: 'B', env: 'config/nodeB.env', color: '\x1b[35m' },
];

const children = nodes.map((n) => {
  const child = spawn(process.execPath,
    ['--disable-warning=ExperimentalWarning', `--env-file=${n.env}`, 'src/server.js'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = `${n.color}[${n.id}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) out.write(prefix + l + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code, sig) => console.log(`${prefix}proceso terminado (code=${code}, signal=${sig}) pid=${child.pid}`));
  console.log(`${prefix}iniciado pid=${child.pid}`);
  return child;
});

const stop = () => { for (const c of children) if (c.exitCode === null) c.kill('SIGTERM'); setTimeout(() => process.exit(0), 2500).unref(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
