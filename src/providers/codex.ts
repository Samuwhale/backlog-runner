import type { AgentRunRequest, CommandRunner, ToolValidationResult } from '../types.js';
import {
  assertAgentSuccess,
  extractStructuredOutput,
  JSON_SCHEMA,
  normalizeAgentResult,
  type ProviderValidationOptions,
  smokeStructuredOutput,
  simpleVersionValidation,
  type ProviderAdapter,
  readIfExists,
  withTempDir,
  writeTempFile,
} from './common.js';

const PROVIDER_SMOKE_TIMEOUT_MS = 2 * 60 * 1000;
const PROVIDER_RUN_TIMEOUT_MS = 30 * 60 * 1000;

function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function emitRawLine(
  request: AgentRunRequest,
  stream: 'stdout' | 'stderr',
  line: string,
): Promise<void> {
  await request.onProgress?.({
    type: 'raw-line',
    stream,
    line,
  });
}

async function handleStdoutLine(request: AgentRunRequest, line: string): Promise<void> {
  await emitRawLine(request, 'stdout', line);

  const event = parseJsonLine(line);
  if (!event || event.type !== 'item.completed') {
    return;
  }

  const item = event.item;
  if (!item || typeof item !== 'object') {
    return;
  }

  const itemRecord = item as Record<string, unknown>;
  if (itemRecord.type !== 'agent_message' || typeof itemRecord.text !== 'string') {
    return;
  }

  if (extractStructuredOutput(itemRecord.text)) {
    return;
  }

  await request.onProgress?.({
    type: 'assistant-message',
    message: itemRecord.text,
    rawLine: line,
  });
}

// Context is concatenated with the prompt into a single user message via stdin.
// Codex does not support separate system prompt files like Claude does.
export const codexProvider: ProviderAdapter = {
  tool: 'codex',
  async validate(commandRunner: CommandRunner, options: ProviderValidationOptions = {}): Promise<ToolValidationResult> {
    const { model, smokeTests = [] } = options;
    const base = await simpleVersionValidation(commandRunner, 'codex', 'codex');
    if (!base.ok) return base;

    const smokeCases = [
      {
        label: 'codex exec',
        schema: JSON_SCHEMA,
        prompt: 'Return exactly this JSON object and nothing else: {"status":"done","item":"smoke","note":"ok"}',
      },
      ...smokeTests,
    ];
    const smokeResults: ToolValidationResult[] = [];
    for (const testCase of smokeCases) {
      smokeResults.push(await withTempDir('backlog-codex-smoke-', async dir => {
        const schemaFile = await writeTempFile(dir, 'schema.json', testCase.schema);
        const outputFile = `${dir}/out.json`;
        return smokeStructuredOutput(
          async () => {
            const result = await commandRunner.run(
              'codex',
              [
                'exec',
                '--dangerously-bypass-approvals-and-sandbox',
                '--skip-git-repo-check',
                '--ephemeral',
                '--output-schema',
                schemaFile,
                '--output-last-message',
                outputFile,
                '-C',
                dir,
                ...(model ? ['--model', model] : []),
              ],
              {
                cwd: dir,
                input: testCase.prompt,
                timeoutMs: PROVIDER_SMOKE_TIMEOUT_MS,
                ignoreFailure: true,
              },
            );
            const output = await readIfExists(outputFile);
            return { ...result, stdout: output || result.stdout };
          },
          testCase.label,
          testCase,
        );
      }));
    }

    return {
      ok: base.ok && smokeResults.every(result => result.ok),
      messages: [...base.messages, ...smokeResults.flatMap(result => result.messages)],
    };
  },
  async run(commandRunner, request: AgentRunRequest) {
    return withTempDir('backlog-codex-', async dir => {
      const schemaFile = await writeTempFile(dir, 'schema.json', request.schema || JSON_SCHEMA);
      const outputFile = `${dir}/last-message.json`;
      const mergedPrompt = [
        request.contextPrefix,
        request.prompt,
        request.contextTail,
        !request.contextPrefix && !request.contextTail ? request.context : undefined,
      ].filter(Boolean).join('\n\n');
      const result = await commandRunner.run(
        'codex',
        [
          'exec',
          '--dangerously-bypass-approvals-and-sandbox',
          '--skip-git-repo-check',
          '--ephemeral',
          '--json',
          '--output-schema',
          schemaFile,
          '--output-last-message',
          outputFile,
          '-C',
          request.cwd,
          ...(request.model ? ['--model', request.model] : []),
        ],
        {
          cwd: request.cwd,
          input: mergedPrompt,
          timeoutMs: PROVIDER_RUN_TIMEOUT_MS,
          ignoreFailure: true,
          onStdoutLine: line => handleStdoutLine(request, line),
          onStderrLine: line => emitRawLine(request, 'stderr', line),
        },
      );

      const output = await readIfExists(outputFile);
      return assertAgentSuccess(normalizeAgentResult(output, result.stderr), {
        ...result,
        stdout: output || result.stdout,
      });
    });
  },
};
