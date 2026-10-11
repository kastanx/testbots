// Blind test (handoff Phase 3, metric 3): one real test movement and one generated movement for the
// same start and target, played one after the other in random order at real speed; the owner picks
// the real one. 100 trials; 58 or fewer correct passes. Results go to data/blindtests/ via the server.
import { postJson } from '../shared/api';
import { harnessConfig } from '../shared/config';
import type { Library } from '../shared/models/motionMatching';
import type { SimModel } from '../shared/models/types';
import type { Rng } from '../shared/rng';
import type { ScreenSize, SimTimeline } from '../shared/timeline';

export interface BlindUi {
  root: HTMLElement;
  msg: HTMLElement;
  buttons: HTMLElement;
  a: HTMLButtonElement;
  b: HTMLButtonElement;
  replay: HTMLButtonElement;
  progress: HTMLElement;
}

interface BlindTrial {
  i: number;
  test_key: string;
  real: 'A' | 'B';
  answer: 'A' | 'B' | null;
  replays: number;
  gen_meta: Record<string, unknown> | undefined;
  answered_at: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class BlindTest {
  private trials: BlindTrial[] = [];
  private stopped = false;

  constructor(
    private lib: Library,
    private model: SimModel,
    private screen: ScreenSize,
    private rng: Rng,
    private ui: BlindUi,
    private play: (tl: SimTimeline) => Promise<void>,
  ) {}

  stop(): void {
    this.stopped = true;
  }

  private ask(replayPair: () => Promise<void>): Promise<{ answer: 'A' | 'B'; replays: number }> {
    return new Promise((resolve) => {
      let replays = 0;
      const done = (answer: 'A' | 'B') => {
        window.removeEventListener('keydown', onKey);
        this.ui.buttons.hidden = true;
        resolve({ answer, replays });
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === '1') done('A');
        else if (e.key === '2') done('B');
      };
      this.ui.a.onclick = () => done('A');
      this.ui.b.onclick = () => done('B');
      this.ui.replay.disabled = false;
      this.ui.replay.onclick = async () => {
        replays++;
        this.ui.replay.disabled = true;
        this.ui.buttons.hidden = true;
        await replayPair();
        this.ui.buttons.hidden = false;
      };
      window.addEventListener('keydown', onKey);
      this.ui.buttons.hidden = false;
    });
  }

  async run(n = harnessConfig.blind.trials): Promise<void> {
    const N = this.lib.size;
    const order = Array.from({ length: N }, (_, i) => i);
    for (let i = N - 1; i > 0; i--) {
      const j = this.rng.int(i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
    const started = new Date().toISOString();
    this.ui.root.hidden = false;
    for (let i = 0; i < n && !this.stopped; i++) {
      const entry = order[i % N];
      const real = this.lib.replay(entry);
      real.screen = this.screen;
      const cond = { start: { x: real.pos[0], y: real.pos[1] }, target: real.target, screen: this.screen };
      this.ui.msg.textContent = 'Watch both movements.';
      this.ui.progress.textContent = `${i + 1} / ${n}`;
      const gen = await this.model.generate(cond, this.rng);
      const realFirst = this.rng.next() < 0.5;
      const pair = realFirst ? [real, gen] : [gen, real];
      const playPair = async () => {
        await this.play(pair[0]);
        await sleep(700);
        await this.play(pair[1]);
      };
      await sleep(400);
      await playPair();
      if (this.stopped) break;
      this.ui.msg.textContent = 'Which one was really you?';
      const { answer, replays } = await this.ask(playPair);
      this.trials.push({
        i, test_key: String(real.meta?.source), real: realFirst ? 'A' : 'B', answer, replays,
        gen_meta: gen.meta, answered_at: new Date().toISOString(),
      });
    }
    const correct = this.trials.filter((t) => t.answer === t.real).length;
    const passMax = harnessConfig.blind.pass_max_correct;
    let saved = '';
    try {
      const r = await postJson<{ saved: string }>('/api/blindtests', {
        model: this.model.id, started_at: started, finished_at: new Date().toISOString(),
        screen: this.screen, trials: this.trials,
      });
      saved = `Saved as data/blindtests/${r.saved}.`;
    } catch (e) {
      saved = `Could not save the result: ${e}`;
    }
    const complete = this.trials.length >= n;
    this.ui.msg.textContent = complete
      ? `${correct} of ${this.trials.length} correct: ${correct <= passMax ? 'PASS (no better than chance)' : 'FAIL (you can tell them apart)'}.\n${saved}`
      : `Stopped after ${this.trials.length} trials (${correct} correct). ${saved}`;
    this.ui.progress.textContent = 'Press Esc to leave the blind test.';
  }
}
