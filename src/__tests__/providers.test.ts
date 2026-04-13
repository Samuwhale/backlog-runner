import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { PLANNER_RESULT_SCHEMA, PLANNER_SCHEMA_SMOKE_PROMPT } from '../planner.js';
import { claudeProvider } from '../providers/claude.js';
import { codexProvider } from '../providers/codex.js';
import { assertAgentSuccess, normalizeAgentResult } from '../providers/common.js';
import type { AgentProgressEvent, CommandResult, CommandRunOptions, CommandRunner } from '../types.js';

function createFakeCommandRunner(
  responses: {
    version?: CommandResult;
    auth?: CommandResult;
    smoke?: CommandResult;
  },
): CommandRunner {
  return {
    async run(command: string, args: string[]): Promise<CommandResult> {
      if (command === 'claude' && args.includes('--version')) {
        return responses.version ?? { code: 0, stdout: '1.0.0', stderr: '' };
      }
      if (command === 'claude' && args[0] === 'auth') {
        return responses.auth ?? { code: 0, stdout: 'Logged in', stderr: '' };
      }
      if (command === 'claude') {
        return responses.smoke ?? {
          code: 0,
          stdout: JSON.stringify({
            structured_output: { status: 'done', item: 'smoke', note: 'ok' },
          }),
          stderr: '',
        };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    async runShell(): Promise<CommandResult> {
      return { code: 0, stdout: '', stderr: '' };
    },
    async which(command: string): Promise<string | null> {
      return command === 'claude' ? '/usr/bin/claude' : null;
    },
  };
}

function createCodexCommandRunner(
  responses: {
    version?: CommandResult;
    smokeOutputs?: string[];
    smokeResult?: CommandResult;
    stdoutLines?: string[];
    stderrLines?: string[];
  } = {},
): CommandRunner {
  const smokeOutputs = [...(responses.smokeOutputs ?? [JSON.stringify({
    structured_output: {
      status: 'done',
      item: 'smoke',
      note: 'ok',
    },
  })])];

  return {
    async run(command: string, args: string[], options?: CommandRunOptions): Promise<CommandResult> {
      if (command === 'codex' && args.includes('--version')) {
        return responses.version ?? { code: 0, stdout: 'codex-cli 0.118.0', stderr: '' };
      }

      if (command === 'codex' && args[0] === 'exec') {
        const outputFlagIndex = args.indexOf('--output-last-message');
        const outputFile = outputFlagIndex >= 0 ? args[outputFlagIndex + 1] : null;
        const output = smokeOutputs.shift() ?? smokeOutputs[smokeOutputs.length - 1] ?? '';
        if (outputFile && output) {
          await writeFile(outputFile, output, 'utf8');
        }
        for (const line of responses.stdoutLines ?? []) {
          await options?.onStdoutLine?.(line);
        }
        for (const line of responses.stderrLines ?? []) {
          await options?.onStderrLine?.(line);
        }
        return responses.smokeResult ?? {
          code: 0,
          stdout: '',
          stderr: '',
        };
      }

      return { code: 0, stdout: '', stderr: '' };
    },
    async runShell(): Promise<CommandResult> {
      return { code: 0, stdout: '', stderr: '' };
    },
    async which(command: string): Promise<string | null> {
      return command === 'codex' ? '/usr/bin/codex' : null;
    },
  };
}

describe('provider normalization', () => {
  it('parses Claude structured output envelopes', () => {
    const result = normalizeAgentResult(
      JSON.stringify({
        structured_output: { status: 'done', item: 'claude item', note: 'ok' },
        num_turns: 4,
        duration_ms: 3200,
      }),
      '',
    );

    expect(result).toMatchObject({
      status: 'done',
      item: 'claude item',
      note: 'ok',
      turns: 4,
      durationSeconds: 3,
    });
  });

  it('rejects malformed output that is not valid top-level JSON', () => {
    const result = normalizeAgentResult(
      'some logs before {"status":"done","item":"raw item","note":"worked"}',
      '',
    );

    expect(result).toBeNull();
  });

  it('fails provider validation when smoke output is malformed', async () => {
    const validation = await claudeProvider.validate(
      createFakeCommandRunner({
        smoke: {
          code: 0,
          stdout: 'not json',
          stderr: '',
        },
      }),
      'claude-sonnet-4-6',
    );

    expect(validation.ok).toBe(false);
    expect(validation.messages.join('\n')).toContain('smoke test failed');
  });

  it('surfaces non-auth structured-output failures with provider detail', () => {
    expect(() =>
      assertAgentSuccess(null, {
        code: 1,
        stdout: '',
        stderr: 'ERROR: invalid_json_schema',
      }),
    ).toThrow(/invalid_json_schema/);
  });

  it('surfaces max-turn failures without dumping the provider envelope', () => {
    expect(() =>
      assertAgentSuccess(null, {
        code: 1,
        stdout: JSON.stringify({
          type: 'result',
          subtype: 'error_max_turns',
          is_error: true,
          num_turns: 13,
          stop_reason: 'tool_use',
          terminal_reason: 'max_turns',
          errors: ['Reached maximum number of turns (12)'],
        }),
        stderr: '',
      }),
    ).toThrow('Reached maximum number of turns (12)');
  });

  it('keeps planner child schema OpenAI-compatible by requiring every child property', () => {
    const parsed = JSON.parse(PLANNER_RESULT_SCHEMA) as {
      properties: {
        children: {
          items: {
            properties: Record<string, unknown>;
            required: string[];
          };
        };
      };
    };

    const childProperties = Object.keys(parsed.properties.children.items.properties).sort();
    const childRequired = [...parsed.properties.children.items.required].sort();
    expect(childRequired).toEqual(childProperties);
  });

  it('validates Codex against both the base schema and planner schema', async () => {
    const validation = await codexProvider.validate(
      createCodexCommandRunner({
        smokeOutputs: [
          JSON.stringify({ status: 'done', item: 'smoke', note: 'ok' }),
          JSON.stringify({
            status: 'done',
            item: 'planner-smoke',
            note: 'ok',
            action: 'supersede',
            parent_task_ids: ['parent-a'],
            children: [
              {
                title: 'Planner smoke child',
                task_kind: 'research',
                priority: 'normal',
                touch_paths: ['backlog'],
                acceptance_criteria: ['Emit concrete follow-up backlog tasks.'],
                validation_profile: null,
                capabilities: null,
                context: null,
              },
            ],
          }),
        ],
      }),
      {
        model: 'gpt-5.4',
        smokeTests: [
          {
            label: 'planner schema',
            schema: PLANNER_RESULT_SCHEMA,
            prompt: PLANNER_SCHEMA_SMOKE_PROMPT,
            expectedItem: 'planner-smoke',
          },
        ],
      },
    );

    expect(validation.ok).toBe(true);
    expect(validation.messages.join('\n')).toContain('planner schema smoke test');
  });

  it('runs Codex with sandbox and approval bypass enabled', async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = {
      async run(command: string, args: string[]): Promise<CommandResult> {
        calls.push([command, ...args]);
        if (command === 'codex') {
          const outputFlagIndex = args.indexOf('--output-last-message');
          const outputFile = outputFlagIndex >= 0 ? args[outputFlagIndex + 1] : null;
          if (outputFile) {
            await writeFile(outputFile, JSON.stringify({
              structured_output: {
                status: 'done',
                item: 'codex item',
                note: 'ok',
              },
            }), 'utf8');
          }
          return {
            code: 0,
            stdout: '',
            stderr: '',
          };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
      async runShell(): Promise<CommandResult> {
        return { code: 0, stdout: '', stderr: '' };
      },
      async which(command: string): Promise<string | null> {
        return command === 'codex' ? '/usr/bin/codex' : null;
      },
    };

    const result = await codexProvider.run(runner, {
      prompt: 'Implement the task.',
      context: 'Context block.',
      cwd: process.cwd(),
      maxTurns: 5,
      tool: 'codex',
      schema: PLANNER_RESULT_SCHEMA,
    });

    expect(result).toMatchObject({
      status: 'done',
      item: 'codex item',
      note: 'ok',
    });

    const execCall = calls.find(call => call[0] === 'codex' && call[1] === 'exec');
    expect(execCall).toBeDefined();
    expect(execCall).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(execCall).toContain('--json');
    expect(execCall).not.toContain('--sandbox');
  });

  it('captures Codex assistant milestones from JSONL output without treating the final payload as progress', async () => {
    const progress: AgentProgressEvent[] = [];
    const result = await codexProvider.run(
      createCodexCommandRunner({
        smokeOutputs: [JSON.stringify({
          structured_output: {
            status: 'done',
            item: 'codex item',
            note: 'ok',
          },
        })],
        stdoutLines: [
          'Reading prompt from stdin...',
          JSON.stringify({
            type: 'item.completed',
            item: {
              id: 'item_1',
              type: 'agent_message',
              text: 'Investigating task scope.',
            },
          }),
          JSON.stringify({
            type: 'item.completed',
            item: {
              id: 'item_2',
              type: 'agent_message',
              text: '{"status":"done","item":"codex item","note":"ok"}',
            },
          }),
        ],
        stderrLines: ['warning from stderr'],
      }),
      {
        prompt: 'Implement the task.',
        context: 'Context block.',
        cwd: process.cwd(),
        maxTurns: 5,
        tool: 'codex',
        schema: PLANNER_RESULT_SCHEMA,
        onProgress: async event => {
          progress.push(event);
        },
      },
    );

    expect(result.status).toBe('done');
    expect(progress).toContainEqual({
      type: 'assistant-message',
      message: 'Investigating task scope.',
      rawLine: JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'agent_message',
          text: 'Investigating task scope.',
        },
      }),
    });
    expect(progress).toContainEqual({
      type: 'raw-line',
      stream: 'stdout',
      line: 'Reading prompt from stdin...',
    });
    expect(progress).toContainEqual({
      type: 'raw-line',
      stream: 'stderr',
      line: 'warning from stderr',
    });
    expect(progress).not.toContainEqual({
      type: 'assistant-message',
      message: '{"status":"done","item":"codex item","note":"ok"}',
      rawLine: JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_2',
          type: 'agent_message',
          text: '{"status":"done","item":"codex item","note":"ok"}',
        },
      }),
    });
  });
});
