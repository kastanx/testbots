// In-memory event log in typed arrays (a 15-minute session is several hundred thousand events).
// Serialises to the raw events.jsonl format: one JSON object per event, CSS pixels as delivered.

export const KINDS = [
  'move', 'down', 'up', 'target_on', 'target_off', 'hit', 'miss',
  'pause', 'resume', 'blur', 'focus', 'leave', 'enter',
] as const;
export type Kind = (typeof KINDS)[number];
const KIND_ID = Object.fromEntries(KINDS.map((k, i) => [k, i])) as Record<Kind, number>;
const MOVE = KIND_ID.move;

function fmt(v: number): string {
  return String(Math.round(v * 1e4) / 1e4);
}

export class EventLog {
  n = 0;
  t = new Float64Array(1 << 16);
  x = new Float64Array(1 << 16);
  y = new Float64Array(1 << 16);
  b = new Uint8Array(1 << 16);
  k = new Uint8Array(1 << 16);
  aux = new Int32Array(1 << 16); // trial index for markers, button for down/up

  private grow(): void {
    const cap = this.t.length * 2;
    const g = <A extends Float64Array | Uint8Array | Int32Array>(a: A, ctor: new (n: number) => A): A => {
      const out = new ctor(cap);
      out.set(a);
      return out;
    };
    this.t = g(this.t, Float64Array);
    this.x = g(this.x, Float64Array);
    this.y = g(this.y, Float64Array);
    this.b = g(this.b, Uint8Array);
    this.k = g(this.k, Uint8Array);
    this.aux = g(this.aux, Int32Array);
  }

  push(kind: Kind, t: number, x = NaN, y = NaN, buttons = 0, aux = -1): void {
    if (this.n === this.t.length) this.grow();
    const i = this.n++;
    this.t[i] = t;
    this.x[i] = x;
    this.y[i] = y;
    this.b[i] = buttons;
    this.k[i] = KIND_ID[kind];
    this.aux[i] = aux;
  }

  isMove(i: number): boolean {
    return this.k[i] === MOVE;
  }

  /** JSON array body (without brackets) for events [from, to). */
  serialize(from: number, to: number): string {
    const parts: string[] = [];
    for (let i = from; i < to; i++) {
      const kind = KINDS[this.k[i]];
      let s = `{"t":${fmt(this.t[i])},"k":"${kind}"`;
      const hasXY = !Number.isNaN(this.x[i]);
      switch (kind) {
        case 'move':
          s += `,"x":${fmt(this.x[i])},"y":${fmt(this.y[i])},"b":${this.b[i]}`;
          break;
        case 'down':
        case 'up':
          s += `,"x":${fmt(this.x[i])},"y":${fmt(this.y[i])},"b":${this.b[i]},"btn":${this.aux[i]}`;
          break;
        case 'target_on':
        case 'target_off':
          s += `,"trial":${this.aux[i]}`;
          break;
        case 'hit':
        case 'miss':
          s += `,"trial":${this.aux[i]},"x":${fmt(this.x[i])},"y":${fmt(this.y[i])}`;
          break;
        default:
          if (hasXY) s += `,"x":${fmt(this.x[i])},"y":${fmt(this.y[i])}`;
      }
      parts.push(s + '}');
    }
    return parts.join(',');
  }
}
