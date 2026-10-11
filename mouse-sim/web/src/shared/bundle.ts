// Loads what `python -m models.export` wrote to models/export (served at /bundle/).
import { getJson } from './api';

export interface Manifest {
  created: string;
  data: 'owner' | 'synthetic';
  screen: [number, number];
  setup_version: number | null;
  components: {
    baselines?: string;
    mm?: { json: string; bin: string; entries: number };
    test?: { json: string; bin: string; entries: number };
    gen?: { onnx: string; json: string };
    cursor?: { png: string; hotspot: [number, number]; size: number };
  };
  reports: Record<string, string>;
}

export interface BaselineParams {
  a_nominal: number;
  b_nominal: number;
  rt: number;
  dwell: number;
  hold: number;
}

/** Columnar library of real trials (models/motion_matching/library.py export). */
export interface LibraryData {
  n: number;
  screen: [number, number];
  fitts: { a_nominal: number; b_nominal: number };
  config: {
    weights: Record<string, number>;
    limits: { direction_deg: number; distance_ratio: number[]; size_ratio: number[]; across_ratio: number[] };
    top_k: number;
    similarity_tau: number;
    warp_lowpass_hz?: number;
  };
  D: number[];
  theta: number[];
  along: number[];
  across: number[];
  shape: number[];
  start_rel: number[];
  target: number[];
  onset: number[];
  offsets: number[];
  clicks: number[];
  click_offsets: number[];
  keys: string[];
  rel: Int16Array; // x, y pairs relative to each trial's start
}

export async function loadManifest(): Promise<Manifest | null> {
  try {
    return await getJson<Manifest>('/bundle/manifest.json');
  } catch {
    return null;
  }
}

export async function loadLibrary(json: string, bin: string): Promise<LibraryData> {
  const [meta, buf] = await Promise.all([
    getJson<Omit<LibraryData, 'rel'>>(`/bundle/${json}`),
    fetch(`/bundle/${bin}`, { cache: 'no-store' }).then((r) => r.arrayBuffer()),
  ]);
  return { ...meta, rel: new Int16Array(buf) };
}
