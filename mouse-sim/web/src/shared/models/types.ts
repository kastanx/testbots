import type { Rng } from '../rng';
import type { SimTimeline, TrialConditions } from '../timeline';

export interface SimModel {
  id: string;
  label: string;
  generate(cond: TrialConditions, rng: Rng): Promise<SimTimeline>;
}
