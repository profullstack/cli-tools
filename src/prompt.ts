/**
 * Read a secret at the terminal without echoing it.
 *
 * A key typed at a visible prompt ends up in the scrollback of whatever
 * terminal multiplexer or screen recorder is running, which is a worse place
 * for it than the 0600 file it is about to go into. Raw mode, no echo, and
 * only Enter or EOF ends it.
 *
 * Without a terminal (`echo "$KEY" | cli-tools config set openai`), stdin is
 * read whole and trimmed, so a script can feed it.
 */
export async function promptSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8').trim();
  }

  process.stderr.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise<string>((resolve) => {
    let value = '';
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        // Enter, or EOF/interrupt.
        if (byte === 0x0d || byte === 0x0a || byte === 0x04) {
          finish();
          return;
        }
        if (byte === 0x03) {
          process.stderr.write('\n');
          process.exit(130);
        }
        // Backspace / delete.
        if (byte === 0x7f || byte === 0x08) {
          value = value.slice(0, -1);
          continue;
        }
        value += String.fromCharCode(byte);
      }
    };
    const finish = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write('\n');
      resolve(value.trim());
    };
    process.stdin.on('data', onData);
  });
}

/** A yes/no on stdin. Non-interactive callers must pass --yes rather than hang. */
export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  process.stderr.write(`${question} [y/N] `);
  const answer = await new Promise<string>((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (chunk) => resolve(String(chunk)));
  });
  return /^y(es)?$/i.test(answer.trim());
}
