import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import type { AgentProgressEvent, BacklogRunnerConfig, BacklogTaskClaim } from './types.js';

type TranscriptRecord =
  | {
      recordedAt: string;
      type: 'jsonl-event';
      stream: 'stdout' | 'stderr';
      rawLine: string;
      event: unknown;
    }
  | {
      recordedAt: string;
      type: 'raw-line';
      stream: 'stdout' | 'stderr';
      line: string;
    };

function timestampSlug(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
}

function parseJsonLine(line: string): unknown | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function serializeRecord(event: Extract<AgentProgressEvent, { type: 'raw-line' }>): TranscriptRecord {
  const parsed = parseJsonLine(event.line);
  if (parsed !== null) {
    return {
      recordedAt: new Date().toISOString(),
      type: 'jsonl-event',
      stream: event.stream,
      rawLine: event.line,
      event: parsed,
    };
  }
  return {
    recordedAt: new Date().toISOString(),
    type: 'raw-line',
    stream: event.stream,
    line: event.line,
  };
}

export interface AgentTranscriptRecorder {
  transcriptPath: string;
  record(event: AgentProgressEvent): Promise<void>;
  close(): Promise<void>;
}

export async function createAgentTranscriptRecorder(
  config: BacklogRunnerConfig,
  claim: BacklogTaskClaim,
): Promise<AgentTranscriptRecorder> {
  const transcriptDir = path.join(config.files.runnerLogDir, 'agent-transcripts');
  await mkdir(transcriptDir, { recursive: true });
  const transcriptPath = path.join(transcriptDir, `${timestampSlug()}-${claim.task.id}.jsonl`);
  const handle = await open(transcriptPath, 'a');
  let pending = Promise.resolve();

  return {
    transcriptPath,
    async record(event: AgentProgressEvent): Promise<void> {
      if (event.type !== 'raw-line') {
        return;
      }
      const record = serializeRecord(event);
      pending = pending.then(() => handle.write(`${JSON.stringify(record)}\n`).then(() => undefined));
      await pending;
    },
    async close(): Promise<void> {
      await pending;
      await handle.close();
    },
  };
}
