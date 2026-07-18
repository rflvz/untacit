#!/usr/bin/env node
/**
 * untacit-server CLI (docs/06 §4.5): serve + user/grant administration.
 * No web admin UI in v1 — in Docker this runs as
 * `docker exec untacit untacit-server user add …` against the live db.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { Command } from 'commander';

import {
  loadServerConfig,
  resolveConfigPath,
  resolveDataDir,
  type LoadConfigOptions,
  type ServerConfig,
} from './config.js';
import { openServerDb, pruneExpired } from './db.js';
import { SqliteUserStore } from './users/sqlite.js';

interface GlobalOpts {
  config?: string;
  dataDir?: string;
}

function loadOpts(program: Command): LoadConfigOptions {
  const opts = program.opts<GlobalOpts>();
  return { configPath: opts.config, dataDir: opts.dataDir };
}

/**
 * Config is optional for user administration; required to serve. A
 * present-but-INVALID config (e.g. one graph volume temporarily unmounted or
 * half-cloned) must degrade the same way an absent one does — otherwise
 * `status` (the very command you run to diagnose that) and `grant`, which touch
 * only server.db, would crash on an unrelated graph-path error. `serve` calls
 * loadServerConfig directly and still fails fast.
 */
function tryLoadConfig(program: Command): ServerConfig | undefined {
  const opts = loadOpts(program);
  if (!existsSync(resolveConfigPath(opts))) return undefined;
  try {
    return loadServerConfig(opts);
  } catch (err) {
    console.warn(
      `warning: config present but invalid, ignoring for this command — ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

function openStore(program: Command) {
  const dataDir = resolveDataDir(loadOpts(program));
  const db = openServerDb(dataDir);
  return { db, users: new SqliteUserStore(db), dataDir };
}

async function readPassword(opts: { passwordStdin?: boolean }, promptText: string): Promise<string> {
  if (opts.passwordStdin) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
    if (password.length === 0) throw new Error('empty password on stdin');
    return password;
  }
  if (!process.stdin.isTTY) {
    throw new Error('stdin is not a TTY — pass the password with --password-stdin');
  }
  // Muted interactive prompt (sudo/git/ssh style: no visible echo). We can't
  // emit one '*' per keystroke by intercepting output, because in terminal mode
  // readline drives the display through this same stream — a single edit fires
  // several writes (cursor moves, full-line refresh, the rewritten line), so
  // masking each write to one '*' miscounts and corrupts on backspace. Swallow
  // readline's echo entirely instead; the captured value is unaffected.
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const muted = { on: false };
  const write = process.stdout.write.bind(process.stdout);
  const maskedWrite = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    if (muted.on && typeof chunk === 'string' && chunk !== '\n' && chunk !== '\r\n') {
      return true; // drop readline's per-char echo and its refresh/cursor escapes
    }
    return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  process.stdout.write = maskedWrite;
  try {
    const ask = (q: string) =>
      new Promise<string>((resolvePromise) => {
        write(q);
        muted.on = true;
        rl.question('', (answer) => {
          muted.on = false;
          write('\n');
          resolvePromise(answer);
        });
      });
    const password = await ask(promptText);
    if (password.length === 0) throw new Error('empty password');
    const confirm = await ask('Repeat password: ');
    if (password !== confirm) throw new Error('passwords do not match');
    return password;
  } finally {
    process.stdout.write = write;
    rl.close();
  }
}

function fail(err: unknown): never {
  console.error(`untacit-server: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

export function buildProgram(): Command {
  const program = new Command('untacit-server')
    .description('Self-hosted untacit MCP server over Streamable HTTP (docs/06)')
    .option('-c, --config <path>', 'config file (default: UNTACIT_SERVER_CONFIG or <dataDir>/untacit-server.config.json)')
    .option('-d, --data-dir <path>', 'data dir with server.db (default: UNTACIT_SERVER_DATA_DIR or the config file directory)');

  program
    .command('serve')
    .description('start the HTTP server')
    .action(async () => {
      try {
        const config = loadServerConfig(loadOpts(program));
        const { startServer } = await import('./index.js');
        const running = await startServer(config);
        console.log(`untacit-server listening on ${running.url} (public: ${config.publicUrl})`);
        console.log(`graphs: ${config.graphs.map((g) => g.id).join(', ')}`);
        const shutdown = (signal: string) => {
          console.log(`${signal} received, shutting down`);
          running.close().then(
            () => process.exit(0),
            () => process.exit(1),
          );
        };
        process.once('SIGINT', () => shutdown('SIGINT'));
        process.once('SIGTERM', () => shutdown('SIGTERM'));
      } catch (err) {
        fail(err);
      }
    });

  const user = program.command('user').description('manage local users');

  user
    .command('add')
    .argument('<username>')
    .option('--name <displayName>', 'human display name')
    .option('--password-stdin', 'read the password from stdin instead of prompting')
    .description('create a user')
    .action(async (username: string, opts: { name?: string; passwordStdin?: boolean }) => {
      try {
        const password = await readPassword(opts, `Password for ${username}: `);
        const { db, users } = openStore(program);
        try {
          const record = users.add(username, password, opts.name);
          console.log(`user ${record.username} created (id ${record.id})`);
          console.log(`grant access with: untacit-server grant ${record.username} <graphId>`);
        } finally {
          db.close();
        }
      } catch (err) {
        fail(err);
      }
    });

  user
    .command('list')
    .description('list users and their graph grants')
    .action(() => {
      try {
        const { db, users } = openStore(program);
        try {
          const all = users.list();
          if (all.length === 0) {
            console.log('no users — create one with: untacit-server user add <username>');
            return;
          }
          for (const u of all) {
            const grants = users.grants(u.id);
            const state = u.disabled ? ' [disabled]' : '';
            const name = u.displayName ? ` (${u.displayName})` : '';
            console.log(`${u.username}${name}${state} → ${grants.length > 0 ? grants.join(', ') : 'no graphs'}`);
          }
        } finally {
          db.close();
        }
      } catch (err) {
        fail(err);
      }
    });

  for (const [cmd, disabled] of [
    ['disable', true],
    ['enable', false],
  ] as const) {
    user
      .command(cmd)
      .argument('<username>')
      .description(`${cmd} a user${disabled ? ' (also revokes their live tokens)' : ''}`)
      .action((username: string) => {
        try {
          const { db, users } = openStore(program);
          try {
            users.setDisabled(username, disabled);
            if (disabled) {
              const target = users.getByUsername(username);
              if (target) {
                db.prepare('UPDATE tokens SET revoked = 1 WHERE user_id = ?').run(target.id);
              }
            }
            console.log(`user ${username} ${cmd}d`);
          } finally {
            db.close();
          }
        } catch (err) {
          fail(err);
        }
      });
  }

  user
    .command('set-password')
    .argument('<username>')
    .option('--password-stdin', 'read the password from stdin instead of prompting')
    .description('change a user password')
    .action(async (username: string, opts: { passwordStdin?: boolean }) => {
      try {
        const password = await readPassword(opts, `New password for ${username}: `);
        const { db, users } = openStore(program);
        try {
          users.setPassword(username, password);
          console.log(`password updated for ${username}`);
        } finally {
          db.close();
        }
      } catch (err) {
        fail(err);
      }
    });

  program
    .command('grant')
    .argument('<username>')
    .argument('<graphId>')
    .description('grant a user access to a graph')
    .action((username: string, graphId: string) => {
      try {
        const config = tryLoadConfig(program);
        if (config && !config.graphs.some((g) => g.id === graphId)) {
          throw new Error(
            `graph "${graphId}" is not in the config (${config.graphs.map((g) => g.id).join(', ')})`,
          );
        }
        if (!config) {
          console.warn(`warning: no config file found — cannot verify that graph "${graphId}" exists`);
        }
        const { db, users } = openStore(program);
        try {
          const target = users.getByUsername(username);
          if (!target) throw new Error(`User "${username}" not found`);
          users.grant(target.id, graphId);
          console.log(`${username} → ${graphId} granted`);
        } finally {
          db.close();
        }
      } catch (err) {
        fail(err);
      }
    });

  program
    .command('revoke')
    .argument('<username>')
    .argument('<graphId>')
    .description('revoke a user\'s access to a graph (also revokes tokens bound to it)')
    .action((username: string, graphId: string) => {
      try {
        const { db, users } = openStore(program);
        try {
          const target = users.getByUsername(username);
          if (!target) throw new Error(`User "${username}" not found`);
          users.revoke(target.id, graphId);
          // Tokens bound to this graph via RFC 8707 `resource` die immediately;
          // unbound tokens are cut off by the per-request grant check (docs/06 §5).
          db.prepare("UPDATE tokens SET revoked = 1 WHERE user_id = ? AND resource LIKE '%/graphs/' || ? || '/mcp'")
            .run(target.id, graphId);
          console.log(`${username} → ${graphId} revoked`);
        } finally {
          db.close();
        }
      } catch (err) {
        fail(err);
      }
    });

  program
    .command('status')
    .description('graphs, users and live token counts')
    .action(() => {
      try {
        const config = tryLoadConfig(program);
        const { db, users, dataDir } = openStore(program);
        try {
          pruneExpired(db);
          console.log(`data dir: ${dataDir}`);
          if (config) {
            console.log(`public URL: ${config.publicUrl}`);
            console.log('graphs:');
            for (const g of config.graphs) {
              const indexed = existsSync(join(g.path, '.untacit', 'index.db'));
              console.log(`  ${g.id} (${g.name}) — ${g.path}${indexed ? '' : ' [no index yet]'} tools=${g.tools}`);
            }
          } else {
            console.log('config: not found (pass --config to include graph status)');
          }
          const all = users.list();
          console.log(`users: ${all.length}`);
          for (const u of all) {
            console.log(`  ${u.username}${u.disabled ? ' [disabled]' : ''} → ${users.grants(u.id).join(', ') || 'no graphs'}`);
          }
          const counts = db
            .prepare(
              `SELECT kind, COUNT(*) AS n FROM tokens
               WHERE revoked = 0 AND expires_at > unixepoch() GROUP BY kind`,
            )
            .all() as { kind: string; n: number }[];
          const byKind = Object.fromEntries(counts.map((c) => [c.kind, c.n]));
          console.log(`live tokens: ${byKind.access ?? 0} access, ${byKind.refresh ?? 0} refresh`);
          console.log('(MCP sessions live in server memory — see the server logs)');
        } finally {
          db.close();
        }
      } catch (err) {
        fail(err);
      }
    });

  return program;
}

// Only run when executed as a bin, not when imported by tests.
const isMain = process.argv[1]?.endsWith('bin.js') || process.argv[1]?.endsWith('untacit-server');
if (isMain) {
  await buildProgram().parseAsync(process.argv);
}
