/**
 * Terminal agentic interview (docs/03 §4.3): script from graph gaps, live
 * triples with accept/reject, cross-verification. The transcript is NEVER
 * persisted — only role, script and proposals reach disk (docs/03 §privacidad).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { GraphIndex, importBatch, interviewSessionPath } from '@untacit/core';
import type { Command } from 'commander';
import pc from 'picocolors';

import { stdinIsInteractive, stdoutIsInteractive, unicodeOk } from '../output.js';
import { createInterviewUi } from '../ui.js';
import { cliVersion, graphRoot } from './helpers.js';

export function registerInterviewCommand(program: Command): void {
  program
    .command('interview')
    .requiredOption('--graph <dir>', 'graph repo directory')
    .option('--role <rol>', 'rol de la persona entrevistada (nunca su nombre)')
    .option('--model <id>', 'LLM model for the interviewer agent')
    .option(
      '--gaps-only',
      'print coverage gaps and verification targets as JSON and exit (no LLM call)',
      false,
    )
    .option('--resume', 'retomar una entrevista interrumpida de este graph repo (sin transcripción: solo rol, guion y propuestas)', false)
    .description(
      'Entrevista agéntica en terminal: guion desde huecos del grafo, triples en vivo con aceptar/rechazar, verificación cruzada (docs/03 §4.3)',
    )
    .action(async (opts: { graph: string; role?: string; model?: string; gapsOnly: boolean; resume: boolean }) => {
      const extractors = await import('@untacit/extractors');
      const repo = graphRoot(opts);
      const sessionPath = interviewSessionPath(repo);

      // Validate the cheap preconditions before opening/reindexing the index.
      const role = opts.role?.trim() ?? '';
      if (!opts.gapsOnly) {
        if (opts.resume && !existsSync(sessionPath)) {
          throw new Error(
            `no hay ninguna sesión de entrevista interrumpida en ${sessionPath} — arranca una nueva sin --resume`,
          );
        }
        if (role === '' && !opts.resume) {
          throw new Error('--role es obligatorio (rol de la persona entrevistada, nunca su nombre)');
        }
        // Without a live stdin, rl.question never settles (EOF) or eats piped
        // lines as prompt answers — either way the process would "succeed"
        // silently having interviewed nobody. Fail loudly instead.
        if (!stdinIsInteractive()) {
          throw new Error(
            'la entrevista es interactiva y stdin no es un terminal — ejecútala en un TTY (o usa --gaps-only para la parte sin LLM)',
          );
        }
        const engine = extractors.claudeCodeAvailable();
        if (!engine.ok) {
          throw new Error(`el agente entrevistador corre sobre Claude Code y no está disponible: ${engine.detail}`);
        }
      }

      const index = GraphIndex.open(repo);
      let gaps: ReturnType<typeof extractors.findCoverageGaps>;
      let verifications: ReturnType<typeof extractors.verificationTargets>;
      try {
        gaps = extractors.findCoverageGaps(index, 12);
        verifications = extractors.verificationTargets(index, 5);
      } finally {
        index.close();
      }
      if (opts.gapsOnly) {
        console.log(JSON.stringify({ gaps, verifications }, null, 2));
        return;
      }

      const llm = new extractors.ClaudeCodeLlmClient(opts.model !== undefined ? { model: opts.model } : {});
      const ui = createInterviewUi({ tty: stdoutIsInteractive(), unicode: unicodeOk() });

      let state: ReturnType<typeof extractors.startInterview>;
      if (opts.resume) {
        const persisted = JSON.parse(readFileSync(sessionPath, 'utf8')) as { version?: unknown };
        if (persisted.version !== 1) {
          throw new Error(
            `versión de sesión desconocida en ${sessionPath} — bórrala o actualiza untacit (untacit update)`,
          );
        }
        const snapshot = persisted as unknown as Parameters<typeof extractors.resumeInterview>[0];
        if (role !== '' && role !== snapshot.state.speakerRole) {
          throw new Error(
            `la sesión guardada es del rol "${snapshot.state.speakerRole}" — retómala sin --role, o con ese mismo rol`,
          );
        }
        state = extractors.resumeInterview(snapshot);
        console.log(pc.dim(`sesión retomada (guardada ${snapshot.savedAt})`));
      } else {
        if (existsSync(sessionPath)) {
          const confirm = createInterface({ input: process.stdin, output: process.stdout });
          confirm.on('SIGINT', () => process.exit(130));
          try {
            const answer = (
              await confirm.question(
                pc.yellow(
                  'hay una sesión de entrevista interrumpida en este grafo (retómala con --resume). ¿Empezar una nueva y descartarla? [s/N] ',
                ),
              )
            )
              .trim()
              .toLowerCase();
            if (!(answer === 's' || answer === 'si' || answer === 'sí')) {
              console.log(pc.dim('sesión conservada — retómala con: untacit interview --resume --graph …'));
              return;
            }
          } finally {
            confirm.close();
          }
          rmSync(sessionPath, { force: true });
        }
        console.log(pc.dim(`${gaps.length} huecos detectados en el grafo`));
        const spin = ui.spinner('generando guion');
        let script: string[];
        try {
          script = await extractors.generateScript(llm, gaps);
          spin.stop();
        } catch (err) {
          spin.stop();
          throw err;
        }
        const interviewId = `int-${Date.now().toString(36)}`;
        state = extractors.startInterview(interviewId, role, { script, verifications });
      }

      ui.banner(cliVersion(), repo, state.speakerRole);

      // Save after every turn (atomic tmp+rename): a crash or Ctrl+C loses at
      // most the answer in flight, and the generated script — an LLM spend —
      // survives from the very first write. Transcript is never persisted.
      const saveSession = (): void => {
        mkdirSync(dirname(sessionPath), { recursive: true });
        const tmp = `${sessionPath}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(extractors.serializeInterview(state), null, 2)}\n`, 'utf8');
        renameSync(tmp, sessionPath);
      };
      // Delete only OUR session on success: a concurrent interview over the
      // same graph may have overwritten the file, and its (resumable) work
      // must not be swept away by this process closing.
      const removeOwnSession = (): void => {
        try {
          const onDisk = JSON.parse(readFileSync(sessionPath, 'utf8')) as {
            state?: { interviewId?: string };
          };
          if (onDisk.state?.interviewId !== state.interviewId) return;
        } catch {
          return;
        }
        rmSync(sessionPath, { force: true });
      };
      saveSession();

      const rl = createInterface({ input: process.stdin, output: process.stdout });
      // Without a listener, readline swallows Ctrl+C between questions (raw
      // mode): it just closes the interface, the in-flight LLM call keeps
      // spending, and the next rl.question dies with a cryptic
      // ERR_USE_AFTER_CLOSE. The session is saved after every turn, so an
      // interrupt can exit cleanly and point at --resume.
      rl.on('SIGINT', () => {
        console.log(
          `\n${pc.dim('entrevista interrumpida — la sesión está guardada; retómala con: untacit interview --resume --graph …')}`,
        );
        process.exit(130);
      });
      try {
        // Cross-verification pass (docs/03 §4.3.5) before the open conversation.
        // Only still-pending ones: a resumed session skips what was resolved.
        for (const proposal of state.proposals.filter(
          (p) => p.kind === 'verification' && p.status === 'proposed',
        )) {
          const v = proposal.verification!;
          const answer = (
            await rl.question(
              `${pc.yellow(`${ui.mood('verifying')} verificar`)} ${proposal.statement} (confianza ${v.confidence}) — [c]onfirmar / [r]efutar / ENTER salta: `,
            )
          )
            .trim()
            .toLowerCase();
          const verdict = answer.startsWith('c') ? 'confirm' : answer.startsWith('r') ? 'refute' : 'skip';
          extractors.resolveVerification(state, proposal.id, verdict);
          saveSession();
        }

        console.log('');
        ui.agentSays(state.transcript[0]!.text);
        console.log(pc.dim('Responde al agente. ":fin" termina la sesión y guarda lo aceptado.\n'));

        for (;;) {
          const answer = (await rl.question(pc.bold('tú > '))).trim();
          if (answer === '') continue;
          if (answer === ':fin' || answer === '/fin') break;

          // A transient LLM failure must not kill the session: processAnswer
          // leaves the state untouched on error, so the user just retries.
          // The spinner stops before anything else prints — it owns the line.
          const spin = ui.spinner('pensando');
          let outcome: Awaited<ReturnType<typeof extractors.processAnswer>>;
          try {
            outcome = await extractors.processAnswer(llm, state, answer);
            spin.stop();
          } catch (err) {
            spin.stop();
            console.log(
              pc.yellow(
                `error del LLM (${err instanceof Error ? err.message : String(err)}) — la sesión sigue: reintenta la respuesta o cierra con ":fin"`,
              ),
            );
            continue;
          }
          if (outcome.proposals.length > 0) {
            console.log(pc.dim('propuestas de este turno:'));
            for (const p of outcome.proposals) {
              console.log(`  ${pc.cyan(p.id)} ${p.statement}`);
            }
            const selection = (
              await rl.question('aceptar (ids separados por espacio, "todo", ENTER = decidir al final): ')
            ).trim();
            if (selection.toLowerCase() === 'todo') {
              for (const p of outcome.proposals) extractors.acceptProposal(state, p.id);
              ui.celebrate(outcome.proposals.length);
            } else if (selection !== '') {
              let accepted = 0;
              for (const id of selection.split(/\s+/)) {
                try {
                  extractors.acceptProposal(state, id);
                  accepted++;
                } catch (err) {
                  console.log(pc.yellow(err instanceof Error ? err.message : String(err)));
                }
              }
              ui.celebrate(accepted);
            }
          }
          saveSession();
          ui.agentSays(outcome.reply);
          console.log('');
          if (outcome.finished) {
            console.log(pc.dim('El guion está cubierto; puedes seguir hablando o cerrar con ":fin".'));
          }
        }

        const pending = state.proposals.filter(
          (p) => p.kind !== 'verification' && p.status === 'proposed',
        );
        if (pending.length > 0) {
          const bulk = (
            await rl.question(
              `Quedan ${pending.length} propuestas pendientes. ¿Aceptarlas todas? [s/N] `,
            )
          )
            .trim()
            .toLowerCase();
          if (bulk === 's' || bulk === 'si' || bulk === 'sí') {
            ui.celebrate(extractors.acceptAll(state).length);
          }
        }
      } finally {
        // Belt and braces: whatever path leaves this block, the last state is
        // on disk (the success paths below delete the file afterwards).
        try {
          saveSession();
        } catch {
          /* saving must never mask the original error */
        }
        rl.close();
      }

      const batch = extractors.finishInterview(state);
      if (batch.nodes.length === 0 && batch.edges.length === 0) {
        removeOwnSession();
        console.log(pc.dim('nada aceptado — la sesión no se importa'));
        return;
      }
      try {
        const imported = await importBatch(repo, batch);
        const s = imported.stats;
        for (const issue of imported.rejections) {
          console.log(`${pc.yellow('rejected')} ${issue.path}: ${issue.message}`);
        }
        console.log(
          `${pc.green('run ' + imported.runId)}: +${s.nodes_created}/~${s.nodes_updated} nodes, ` +
            `+${s.edges_created}/~${s.edges_updated} edges, +${s.evidence_added} evidence`,
        );
        if (imported.commit) console.log(pc.dim(`  commit ${imported.commit.slice(0, 10)}`));
        // Only a successful close removes the resumable session.
        removeOwnSession();
      } catch (err) {
        // The session cost a real conversation — never lose the batch to an
        // import failure the user can fix and retry. The session file stays
        // resumable too (--resume) in case they prefer to keep talking.
        const rescue = resolve(`untacit-batch-${batch.run_id}.json`);
        writeFileSync(rescue, `${JSON.stringify(batch, null, 2)}\n`, 'utf8');
        console.error(
          pc.yellow(`import failed; batch saved to ${rescue} — fix the problem and re-run: untacit import ${rescue} --graph ...`),
        );
        throw err;
      }
    });
}
