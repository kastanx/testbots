// Seeded PRNG (xoshiro128**), so recorder sessions and simulator runs can be reproduced.

function splitmix32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

export class Rng {
  private s = new Uint32Array(4);
  private spare: number | null = null;
  readonly seed: number;

  constructor(seed?: number) {
    this.seed = seed ?? crypto.getRandomValues(new Uint32Array(1))[0];
    const sm = splitmix32(this.seed);
    for (let i = 0; i < 4; i++) this.s[i] = sm();
  }

  private nextU32(): number {
    const s = this.s;
    const result = Math.imul(rotl(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0;
    const t = (s[1] << 9) >>> 0;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 11);
    return result;
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.nextU32() / 4294967296;
  }

  uniform(a: number, b: number): number {
    return a + (b - a) * this.next();
  }

  logUniform(a: number, b: number): number {
    return Math.exp(this.uniform(Math.log(a), Math.log(b)));
  }

  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  normal(): number {
    if (this.spare !== null) {
      const v = this.spare;
      this.spare = null;
      return v;
    }
    let u = 0;
    while (u <= 1e-12) u = this.next();
    const v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }

  /** Index drawn with probability proportional to weights; -1 if all weights are zero. */
  weighted(weights: ArrayLike<number>): number {
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += weights[i];
    if (!(total > 0)) return -1;
    let u = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      u -= weights[i];
      if (u < 0) return i;
    }
    for (let i = weights.length - 1; i >= 0; i--) if (weights[i] > 0) return i;
    return -1;
  }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}
