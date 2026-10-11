// Uploads the session in ordered chunks (a backup every 60 s, the rest at the end). The server
// appends chunk `seq` only once, so a retry after a lost response can never duplicate data.
import { ApiError, postJson } from '../shared/api';
import type { EventLog } from './capture';

export class Uploader {
  private seq = 0;
  private sentEvents = 0;
  private sentTrials = 0;
  private busy: Promise<boolean> | null = null;
  lastError: string | null = null;

  constructor(
    readonly sessionId: string,
    private log: EventLog,
    private trials: () => object[],
  ) {}

  /** Send everything recorded so far as one chunk. Resolves true on success. */
  flush(): Promise<boolean> {
    if (!this.busy) this.busy = this.send().finally(() => (this.busy = null));
    return this.busy;
  }

  private async send(): Promise<boolean> {
    const evEnd = this.log.n;
    const all = this.trials();
    const trEnd = all.length;
    if (evEnd === this.sentEvents && trEnd === this.sentTrials) return true;
    const body =
      `{"seq":${this.seq},"events":[${this.log.serialize(this.sentEvents, evEnd)}],` +
      `"trials":${JSON.stringify(all.slice(this.sentTrials, trEnd))}}`;
    try {
      await postJson(`/api/sessions/${this.sessionId}/chunks`, body);
      this.seq++;
      this.sentEvents = evEnd;
      this.sentTrials = trEnd;
      this.lastError = null;
      return true;
    } catch (e) {
      this.lastError = e instanceof ApiError ? e.message : String(e);
      return false;
    }
  }

  /** Flush (with retries) and mark the session finished. */
  async finish(meta: object, attempts = 5): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      if (this.busy) await this.busy;
      if ((await this.flush()) && this.sentEvents === this.log.n && this.sentTrials === this.trials().length) {
        try {
          await postJson(`/api/sessions/${this.sessionId}/finish`, { meta, seq_total: this.seq });
          return true;
        } catch (e) {
          this.lastError = e instanceof ApiError ? e.message : String(e);
        }
      }
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
    return false;
  }
}
