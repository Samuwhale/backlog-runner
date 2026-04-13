import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { EOL } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import type { CommandResult, CommandRunOptions, CommandRunner } from './types.js';

const DEFAULT_COMMAND_TIMEOUT_MS = 20 * 60 * 1000;

function collect(
  stream: NodeJS.ReadableStream | null,
  onLine?: (line: string) => void | Promise<void>,
): Promise<string> {
  if (!stream) return Promise.resolve('');

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const decoder = new StringDecoder('utf8');
    let pending = Promise.resolve();
    let lineBuffer = '';

    const emitLine = (line: string): void => {
      if (!onLine) return;
      pending = pending.then(() => onLine(line));
      pending.catch(reject);
    };

    const drainText = (text: string): void => {
      lineBuffer += text;
      while (true) {
        const newlineIndex = lineBuffer.indexOf('\n');
        if (newlineIndex === -1) break;
        const line = lineBuffer.slice(0, newlineIndex).replace(/\r$/, '');
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
        emitLine(line);
      }
    };

    stream.on('data', chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      chunks.push(buffer);
      drainText(decoder.write(buffer));
    });
    stream.on('end', () => {
      const remainder = decoder.end();
      if (remainder) {
        drainText(remainder);
      }
      if (lineBuffer.length > 0) {
        emitLine(lineBuffer.replace(/\r$/, ''));
        lineBuffer = '';
      }
      pending.then(() => resolve(Buffer.concat(chunks).toString('utf8')), reject);
    });
    stream.on('error', reject);
  });
}

async function spawnAndCollect(
  command: string,
  args: string[],
  options: CommandRunOptions & { shell?: boolean } = {},
): Promise<CommandResult> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    shell: options.shell ?? false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (options.input !== undefined) {
    child.stdin.write(options.input);
  }
  child.stdin.end();

  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
  }, timeoutMs);
  timeout.unref();

  const stdoutPromise = collect(child.stdout, options.onStdoutLine);
  const stderrPromise = collect(child.stderr, options.onStderrLine);
  const [code] = (await once(child, 'close')) as [number | null];
  clearTimeout(timeout);
  const stdout = await stdoutPromise;
  const stderr = await stderrPromise;
  const result = { code: code ?? 0, stdout, stderr };

  if (timedOut) {
    throw new Error(`Command timed out after ${Math.ceil(timeoutMs / 1000)}s: ${command} ${args.join(' ')}`.trim());
  }

  if (!options.ignoreFailure && result.code !== 0) {
    const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join(EOL);
    throw new Error(detail || `Command failed: ${command} ${args.join(' ')}`);
  }

  return result;
}

export function createCommandRunner(): CommandRunner {
  return {
    run(command, args, options) {
      return spawnAndCollect(command, args, options);
    },
    runShell(command, options) {
      return spawnAndCollect(process.env.SHELL ?? '/bin/sh', ['-lc', command], options);
    },
    async which(command) {
      const result = await spawnAndCollect(process.env.SHELL ?? '/bin/sh', ['-lc', `command -v ${command}`], {
        ignoreFailure: true,
      });
      const value = result.stdout.trim();
      return result.code === 0 && value ? value : null;
    },
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
