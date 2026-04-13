const ANSI_ESCAPE_REGEX =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping requires escape sequences.
  /\u001B\[[0-9;]*m/g;

const STACK_FRAME_REGEX = /^at\s/;
const NOISE_LINE_PATTERNS = [
  /^RUN\s+v/i,
  /^[✓↓]\s/,
  /^Test Files\s+/,
  /^Tests\s+/,
  /^Start at\s+/,
  /^Duration\s+/,
  /^\{$/,
  /^\}$/,
  /^(errno|code|syscall):\s/i,
];
const FAILURE_HINT_PATTERNS = [
  /\bFAIL\b/i,
  /\berror\b/i,
  /AssertionError/i,
  /\bException\b/i,
];

function stripAnsi(line: string): string {
  return line.replace(ANSI_ESCAPE_REGEX, '');
}

function isNoiseLine(line: string): boolean {
  return STACK_FRAME_REGEX.test(line) || NOISE_LINE_PATTERNS.some(pattern => pattern.test(line));
}

function isFailureHint(line: string): boolean {
  return FAILURE_HINT_PATTERNS.some(pattern => pattern.test(line));
}

export function summarizeCommandOutput(stdout: string, stderr: string): string {
  const lines = [stdout, stderr]
    .join('\n')
    .split('\n')
    .map(line => stripAnsi(line).trim())
    .filter(Boolean);

  const meaningfulLines = lines.filter(line => !isNoiseLine(line));
  const prioritizedLines = meaningfulLines.filter(isFailureHint);
  const source = prioritizedLines.length > 0 ? prioritizedLines : meaningfulLines;

  return source.slice(-8).join(' | ') || 'no output';
}
