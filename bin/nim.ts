#!/usr/bin/env node
/**
 * nim — NVIDIA's hosted NIM API (build.nvidia.com): models, chat, and is my key good.
 *
 *   nim models [filter]            the model ids it serves (no key needed)
 *   nim chat "explain RAID 5"      one reply, to stdout
 *   echo "…" | nim chat            the prompt from stdin
 *   nim key                        can this key call the hosted API, and if not, why
 *
 * Not to be confused with the Nim language compiler, which is also `nim`; this
 * one is on PATH from ~/.local/bin, so it wins where both are installed.
 */

import { UsageError } from '../src/args.ts';
import { resolveCredentials } from '../src/credentials.ts';
import { isMain } from '../src/is-main.ts';
import {
  DEFAULT_MAX_TOKENS,
  MISSING_KEY,
  NimError,
  baseUrl,
  chat,
  checkKey,
  defaultModel,
  listModels,
  parseNimArgs,
  resolveKey,
} from '../src/nim.ts';

const USAGE = `Usage:
  nim models [--json] [filter]
  nim chat [--model ID] [--max-tokens N] [--json] <prompt...>
  nim key [--model ID] [--json]

NVIDIA's hosted inference API (build.nvidia.com), OpenAI-compatible at
${baseUrl()}.

  models   the ids /v1/models lists; works without a key
  chat     one reply to stdout; the prompt may come from stdin instead
  key      one 1-token completion: says whether the key can use the hosted API

Options:
  -m, --model ID     chat model (default: ${defaultModel()}; NIM_MODEL overrides)
      --max-tokens N reply cap for chat (default: ${DEFAULT_MAX_TOKENS})
      --json         machine-readable output
  -h, --help         this help

Key, first found: NVIDIA_API_KEY, NVIDIA_NIM_API_KEY, NGC_API_KEY, from the
environment or \`cli-tools config\` (\`cli-tools config pull\` brings them down).
`;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseNimArgs(argv);
  const base = baseUrl();

  if (parsed.command === 'help') {
    process.stdout.write(USAGE);
    return argv.length === 0 ? 1 : 0;
  }

  if (parsed.command === 'models') {
    const ids = await listModels({ base, filter: parsed.filter });
    process.stdout.write(parsed.json ? `${JSON.stringify(ids, null, 2)}\n` : ids.map((id) => `${id}\n`).join(''));
    return ids.length > 0 ? 0 : 1;
  }

  const found = resolveKey(process.env, resolveCredentials(process.env));
  const model = parsed.model ?? defaultModel();

  if (parsed.command === 'key') {
    const result = await checkKey(found, { model, base });
    if (parsed.json) {
      // The variable name, never the value.
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (result.ok) {
      process.stdout.write(`ok: ${result.variable} can call ${model}\n`);
    } else {
      process.stdout.write(`${result.variable ? `${result.variable}: ` : ''}${result.message}\n`);
    }
    return result.ok ? 0 : 1;
  }

  if (!found) {
    process.stderr.write(`${MISSING_KEY}\n`);
    return 1;
  }
  const prompt = parsed.prompt || (await readStdin());
  if (!prompt) throw new UsageError('nim chat needs a prompt, as arguments or on stdin');

  const reply = await chat({ key: found.key, model, prompt, maxTokens: parsed.maxTokens, base });
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(reply.raw, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(reply.text.endsWith('\n') ? reply.text : `${reply.text}\n`);
  if (!reply.text && reply.finishReason === 'length') {
    process.stderr.write('nim: the reply was cut off before any text; raise --max-tokens\n');
  }
  return 0;
}

if (isMain(import.meta.url)) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`nim: ${error.message}\n${USAGE}`);
      process.exit(2);
    }
    if (error instanceof NimError) {
      process.stderr.write(`nim: ${error.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`nim: ${(error as Error).message}\n`);
    process.exit(1);
  }
}
