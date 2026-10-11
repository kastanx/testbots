// Hybrid (default): motion matching where it has qualifying candidates, the generative model elsewhere.
import type { Rng } from '../rng';
import type { SimTimeline, TrialConditions } from '../timeline';
import type { Generative } from './generative';
import type { Library, MotionMatching } from './motionMatching';
import type { SimModel } from './types';

export class Hybrid implements SimModel {
  readonly id = 'hybrid';
  readonly label = 'Hybrid (motion matching + generative)';

  constructor(private mm: MotionMatching, private gen: Generative | null) {}

  async generate(cond: TrialConditions, rng: Rng): Promise<SimTimeline> {
    if (this.gen && !this.mm.hasCoverage(cond)) {
      const tl = await this.gen.generate(cond, rng);
      tl.meta = { ...tl.meta, fallback: true };
      return tl;
    }
    return this.mm.generate(cond, rng);
  }
}

/** Real replay: the nearest recorded trial, exactly as it happened (its own start and target). */
export class RealReplay implements SimModel {
  readonly id = 'real';
  readonly label = 'Real replay (nearest recorded trial)';

  constructor(private lib: Library, private mm: MotionMatching) {}

  async generate(cond: TrialConditions): Promise<SimTimeline> {
    return this.lib.replay(this.mm.nearest(cond));
  }
}
