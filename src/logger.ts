import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import type { BacklogRunnerConfig, LogSink } from './types.js';

class FileConsoleLogSink implements LogSink {
  constructor(private readonly handle: Awaited<ReturnType<typeof open>>) {}

  write(line: string): void {
    process.stdout.write(line);
    void this.handle.write(line);
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}

export async function createDefaultLogSink(config: BacklogRunnerConfig): Promise<LogSink> {
  await mkdir(config.files.runnerLogDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const logPath = path.join(config.files.runnerLogDir, `runner-${timestamp}.log`);
  const handle = await open(logPath, 'a');
  return new FileConsoleLogSink(handle);
}

export class RunnerLogger {
  constructor(private readonly sink: LogSink) {}

  line(value = ''): void {
    this.sink.write(`${value}\n`);
  }

  async close(): Promise<void> {
    await this.sink.close();
  }
}
