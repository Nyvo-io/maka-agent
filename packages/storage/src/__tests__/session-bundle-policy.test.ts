import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RuntimeEvent } from '@maka/core';
import {
  assertSessionBundleRootLayout,
  exportSessionBundleState,
  planSessionBundleExport,
  type SessionBundleExportError,
} from '../session-bundle-policy.js';
import { createSqliteRuntimeStore } from '../sqlite-runtime-store.js';

test('exports one session only and excludes credential/config canaries', async () => {
  await withBundleRoots(async ({ stateRoot, configRoot, destinationRoot }) => {
    await mkdir(join(stateRoot, 'sessions', 'session-1', 'runs'), { recursive: true });
    await mkdir(join(stateRoot, 'sessions', 'session-2'), { recursive: true });
    await mkdir(join(stateRoot, 'artifacts', 'session-1'), { recursive: true });
    await mkdir(join(stateRoot, 'artifacts', 'session-2'), { recursive: true });
    await writeFile(
      join(stateRoot, 'sessions', 'session-1', 'header.json'),
      '{"session":"owned"}\n',
    );
    await writeFile(join(stateRoot, 'sessions', 'session-2', 'header.json'), 'other-session\n');
    await writeFile(join(stateRoot, 'artifacts', 'session-1', 'output.txt'), 'session output\n');
    await writeFile(
      join(stateRoot, 'artifacts', 'session-2', 'other-output.txt'),
      'other output\n',
    );
    await writeFile(
      join(stateRoot, 'artifacts', 'metadata.jsonl'),
      [
        JSON.stringify({ sessionId: 'session-1', relativePath: 'session-1/output.txt' }),
        JSON.stringify({ sessionId: 'session-2', relativePath: 'session-2/other-output.txt' }),
      ].join('\n') + '\n',
    );
    const runtime = createSqliteRuntimeStore(join(stateRoot, 'runtime.sqlite'));
    await runtime.appendRuntimeEvent('session-1', 'run-1', runtimeEvent('event-1'));
    await runtime.appendRuntimeEvent(
      'session-2',
      'run-2',
      runtimeEvent('event-2', {
        sessionId: 'session-2',
        runId: 'run-2',
        invocationId: 'run-2',
      }),
    );
    runtime.close();
    await writeFile(join(stateRoot, 'credentials.json'), 'super-secret-api-key');
    await writeFile(join(stateRoot, 'llm-connections.json'), 'host-provider-config');
    await writeFile(join(stateRoot, '.maka_cli_claude_device_id'), 'device-identity');
    await writeFile(join(configRoot, 'credentials.json'), 'config-secret-canary');

    const plan = await exportSessionBundleState({
      stateRoot,
      configRoot,
      destinationRoot,
      sessionId: 'session-1',
    });

    assert.deepEqual(plan.includedEntries, ['artifacts', 'runtime.sqlite', 'sessions']);
    assert.deepEqual(
      [...plan.excludedEntries].sort(),
      [
        '.maka_cli_claude_device_id',
        'artifacts/session-2',
        'credentials.json',
        'llm-connections.json',
        'sessions/session-2',
      ].sort(),
    );
    assert.equal(
      await readFile(join(destinationRoot, 'sessions', 'session-1', 'header.json'), 'utf8'),
      '{"session":"owned"}\n',
    );
    await assert.rejects(readFile(join(destinationRoot, 'sessions', 'session-2', 'header.json')));
    await assert.rejects(
      readFile(join(destinationRoot, 'artifacts', 'session-2', 'other-output.txt')),
    );
    assert.match(
      await readFile(join(destinationRoot, 'artifacts', 'metadata.jsonl'), 'utf8'),
      /"sessionId":"session-1"/,
    );
    assert.doesNotMatch(
      await readFile(join(destinationRoot, 'artifacts', 'metadata.jsonl'), 'utf8'),
      /session-2/,
    );
    const exportedRuntime = createSqliteRuntimeStore(join(destinationRoot, 'runtime.sqlite'));
    try {
      assert.equal((await exportedRuntime.readSessionRuntimeEvents('session-1')).length, 1);
      assert.equal((await exportedRuntime.readSessionRuntimeEvents('session-2')).length, 0);
    } finally {
      exportedRuntime.close();
    }
    await assert.rejects(readFile(join(destinationRoot, 'credentials.json'), 'utf8'));
    await assert.rejects(readFile(join(destinationRoot, 'llm-connections.json'), 'utf8'));
    await assert.rejects(readFile(join(destinationRoot, '.maka_cli_claude_device_id'), 'utf8'));
    assert.equal(
      await readFile(join(configRoot, 'credentials.json'), 'utf8'),
      'config-secret-canary',
    );
  });
});

test('fails closed on unknown top-level state entries', async () => {
  await withBundleRoots(async ({ stateRoot, configRoot, destinationRoot }) => {
    await writeFile(join(stateRoot, 'new-secret-store.json'), 'unknown-secret');

    await assertExportError(
      planSessionBundleExport({ stateRoot, configRoot, destinationRoot, sessionId: 'session-1' }),
      'unknown_entry',
    );
  });
});

test('fails closed on symlinked state entries and path escape', async () => {
  await withBundleRoots(async ({ stateRoot, configRoot, destinationRoot, root }) => {
    const outside = join(root, 'outside-secret.txt');
    await writeFile(outside, 'outside-secret');
    await mkdir(join(stateRoot, 'sessions', 'session-1'), { recursive: true });
    await symlink(outside, join(stateRoot, 'sessions', 'session-1', 'escaped.txt'));

    await assertExportError(
      planSessionBundleExport({ stateRoot, configRoot, destinationRoot, sessionId: 'session-1' }),
      'symlink',
    );
  });
});

test('rejects unsafe root overlap while allowing explicit legacy sharing', async () => {
  await withBundleRoots(async ({ stateRoot, configRoot }) => {
    await assertSessionBundleRootLayout({ stateRoot, configRoot });
    await assertSessionBundleRootLayout({
      stateRoot,
      configRoot: stateRoot,
      allowShared: true,
    });

    await assertExportError(
      assertSessionBundleRootLayout({
        stateRoot,
        configRoot: join(stateRoot, 'config'),
      }),
      'overlapping_roots',
    );
  });
});

test('rejects a bundle destination nested inside a source root', async () => {
  await withBundleRoots(async ({ stateRoot, configRoot }) => {
    await assertExportError(
      planSessionBundleExport({
        stateRoot,
        configRoot,
        destinationRoot: join(stateRoot, 'bundle'),
        sessionId: 'session-1',
      }),
      'overlapping_roots',
    );
  });
});

async function assertExportError(
  operation: Promise<unknown>,
  code: SessionBundleExportError['code'],
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.equal((error as SessionBundleExportError).code, code);
    return true;
  });
}

function runtimeEvent(id: string, overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    id,
    invocationId: 'run-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text: id },
    ...overrides,
  };
}

async function withBundleRoots(
  fn: (roots: {
    root: string;
    stateRoot: string;
    configRoot: string;
    destinationRoot: string;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-bundle-'));
  const stateRoot = join(root, 'state');
  const configRoot = join(root, 'config');
  const destinationRoot = join(root, 'export');
  await Promise.all([mkdir(stateRoot), mkdir(configRoot)]);
  try {
    await fn({ root, stateRoot, configRoot, destinationRoot });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
