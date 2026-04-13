import type { AgentRunRequest, CommandRunner, ToolValidationResult } from '../types.js';
import {
  assertAgentSuccess,
  checkCommandAuth,
  JSON_SCHEMA,
  normalizeAgentResult,
  type ProviderValidationOptions,
  smokeStructuredOutput,
  simpleVersionValidation,
  type ProviderAdapter,
  withTempDir,
  writeTempFile,
} from './common.js';

const PROVIDER_SMOKE_TIMEOUT_MS = 2 * 60 * 1000;
const PROVIDER_RUN_TIMEOUT_MS = 30 * 60 * 1000;

// Context is injected via --append-system-prompt-file, separating it from the user prompt.
// This differs from the Codex provider which concatenates context into the user prompt
// (Codex does not support system prompt files).
export const claudeProvider: ProviderAdapter = {
  tool: 'claude',
  async validate(commandRunner: CommandRunner, options: ProviderValidationOptions = {}): Promise<ToolValidationResult> {
    const { model, smokeTests = [] } = options;
    const base = await simpleVersionValidation(commandRunner, 'claude', 'claude');
    if (!base.ok) return base;

    const auth = await checkCommandAuth(commandRunner, 'claude', ['auth', 'status', '--text'], /logged in|authenticated/i);
    const smokeCases = [
      {
        label: 'claude',
        schema: JSON_SCHEMA,
        prompt: 'Return exactly this JSON object and nothing else: {"status":"done","item":"smoke","note":"ok"}',
      },
      ...smokeTests,
    ];

    const smokeResults = await Promise.all(
      smokeCases.map(testCase =>
        withTempDir('backlog-claude-smoke-', async dir => {
          const contextFile = await writeTempFile(dir, 'context.md', 'Return exactly the requested JSON.');
          return smokeStructuredOutput(
            () =>
              commandRunner.run(
                'claude',
                [
                  '--dangerously-skip-permissions',
                  '--print',
                  '--no-session-persistence',
                  '--max-turns',
                  '3',
                  '--output-format',
                  'json',
                  '--json-schema',
                  testCase.schema,
                  ...(model ? ['--model', model] : []),
                  '--append-system-prompt-file',
                  contextFile,
                ],
                {
                  cwd: dir,
                  input: testCase.prompt,
                  timeoutMs: PROVIDER_SMOKE_TIMEOUT_MS,
                  ignoreFailure: true,
                },
              ),
            testCase.label,
            testCase,
          );
        }),
      ),
    );

    return {
      ok: base.ok && auth.ok && smokeResults.every(result => result.ok),
      messages: [...base.messages, auth.message, ...smokeResults.flatMap(result => result.messages)],
    };
  },
  async run(commandRunner, request: AgentRunRequest) {
    return withTempDir('backlog-claude-', async dir => {
      const contextFile = await writeTempFile(dir, 'context.md', request.context);
      const args = [
        '--dangerously-skip-permissions',
        '--print',
        '--no-session-persistence',
        '--max-turns',
        String(request.maxTurns ?? 100),
        '--output-format',
        'json',
        '--json-schema',
        request.schema || JSON_SCHEMA,
      ];
      if (request.model) {
        args.push('--model', request.model);
      }
      args.push('--append-system-prompt-file', contextFile);
      const result = await commandRunner.run(
        'claude',
        args,
        {
          cwd: request.cwd,
          input: request.prompt,
          timeoutMs: PROVIDER_RUN_TIMEOUT_MS,
          ignoreFailure: true,
        },
      );

      return assertAgentSuccess(normalizeAgentResult(result.stdout, result.stderr), result);
    });
  },
};
