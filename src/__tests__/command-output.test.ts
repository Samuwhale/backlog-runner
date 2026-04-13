import { describe, expect, it } from 'vitest';
import { summarizeCommandOutput } from '../command-output.js';

describe('summarizeCommandOutput', () => {
  it('drops stack frames and vitest noise from summaries', () => {
    const summary = summarizeCommandOutput(
      [
        ' RUN  v3.2.4 /tmp/worktree',
        ' ✓ src/__tests__/token-store.test.ts (129 tests | 128 skipped) 16ms',
        ' Test Files  1 passed | 3 skipped (4)',
      ].join('\n'),
      [
        '[TokenStore] Recovery: themes update failed — marker preserved for retry on next restart: EISDIR: illegal operation on a directory, read',
        '    at readFileHandle (node:internal/fs/promises:553:24)',
        '    at TokenStore.applyThemesRename (/tmp/token-store.ts:82:17)',
        '{',
        '  errno: -21,',
        "  code: 'EISDIR',",
        "  syscall: 'read'",
        '}',
      ].join('\n'),
    );

    expect(summary).toBe(
      '[TokenStore] Recovery: themes update failed — marker preserved for retry on next restart: EISDIR: illegal operation on a directory, read',
    );
  });

  it('prefers actual failure lines when they are present', () => {
    const summary = summarizeCommandOutput(
      [
        ' FAIL  src/__tests__/api.test.ts > sets route > rejects malformed payload',
        'AssertionError: expected 400 to be 422',
      ].join('\n'),
      [
        '[TokenStore] Recovery: themes update failed — marker preserved for retry on next restart: EISDIR: illegal operation on a directory, read',
        '    at TokenStore.applyThemesRename (/tmp/token-store.ts:82:17)',
      ].join('\n'),
    );

    expect(summary).toBe(
      'FAIL  src/__tests__/api.test.ts > sets route > rejects malformed payload | AssertionError: expected 400 to be 422',
    );
  });
});
