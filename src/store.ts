import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { ToolError } from './errors.js';

const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const entrySchema = z.strictObject({
  requestId: z.string().min(1).max(128), fingerprint: hash, hash,
  nonce: z.number().int().nonnegative().safe(), raw: z.string().regex(/^0x02(?:[0-9a-f]{2})+$/),
  createdBlock: z.string().regex(/^\d+$/),
  status: z.enum(['pending', 'submission_unknown', 'confirmed', 'reverted']),
  receiptBlock: z.string().regex(/^\d+$/).optional(), receiptBlockHash: hash.optional(),
});
const journalSchema = z.strictObject({ version: z.literal(1), identity: z.string(), entries: z.array(entrySchema).max(10_000) });
export type Entry = z.infer<typeof entrySchema>;
export type Journal = z.infer<typeof journalSchema>;
export interface Store { state: Journal; save(): Promise<void>; close(): Promise<void> }

export class FileStore implements Store {
  private constructor(readonly file: string, readonly state: Journal, private readonly release: () => Promise<void>) {}
  static async open(file: string, identity: string) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(file, { realpath: false, stale: 30_000, update: 10_000, retries: 0 });
    try {
      let state: Journal;
      try { state = journalSchema.parse(JSON.parse(await readFile(file, 'utf8'))); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ToolError('JOURNAL_INVALID', 'Journal is invalid; do not delete it to bypass transaction recovery.');
        state = { version: 1, identity, entries: [] };
      }
      if (state.identity !== identity || new Set(state.entries.map(e => e.requestId)).size !== state.entries.length
        || new Set(state.entries.map(e => e.nonce)).size !== state.entries.length
        || state.entries.filter(e => e.status === 'pending' || e.status === 'submission_unknown').length > 1) {
        throw new ToolError('JOURNAL_INVALID', 'Journal identity, request IDs or nonces do not match this server.');
      }
      return new FileStore(file, state, release);
    } catch (error) { await release(); throw error; }
  }
  async save() {
    try {
      const temporary = `${this.file}.${process.pid}.tmp`;
      const handle = await open(temporary, 'w', 0o600);
      try { await handle.writeFile(JSON.stringify(this.state, null, 2) + '\n'); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, this.file);
      const directory = await open(dirname(this.file), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch { throw new ToolError('JOURNAL_UNAVAILABLE', 'Cannot persist transaction intent. Fix storage and restart before submitting.'); }
  }
  async close() { await this.release(); }
}
