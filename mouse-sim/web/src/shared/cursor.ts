// The simulated cursor: the owner's Windows arrow (extracted by tools/extract_cursor.py) at its real
// size and hotspot, drawn on whole physical pixels. Falls back to a drawn arrow.

export interface CursorSprite {
  draw(ctx: CanvasRenderingContext2D, x: number, y: number): void;
}

export async function loadCursor(png?: string, hotspot?: [number, number]): Promise<CursorSprite> {
  if (png) {
    try {
      const img = new Image();
      img.src = `/bundle/${png}`;
      await img.decode();
      const [hx, hy] = hotspot ?? [0, 0];
      return { draw: (ctx, x, y) => ctx.drawImage(img, Math.round(x) - hx, Math.round(y) - hy) };
    } catch {
      // fall through
    }
  }
  return defaultCursor();
}

/** A drawn Windows-style arrow, used until (or if) the owner's cursor image loads. */
export function defaultCursor(): CursorSprite {
  return {
    draw(ctx, x, y) {
      const px = Math.round(x);
      const py = Math.round(y);
      ctx.save();
      ctx.translate(px + 0.5, py + 0.5);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, 17);
      ctx.lineTo(4, 13);
      ctx.lineTo(7, 19);
      ctx.lineTo(9, 18);
      ctx.lineTo(6, 12);
      ctx.lineTo(11, 12);
      ctx.closePath();
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    },
  };
}
