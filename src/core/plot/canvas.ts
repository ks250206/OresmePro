import type { MarkerShape } from "../doc/types";
import type { Prim } from "./displayList";

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function traceMarker(ctx: Ctx, shape: MarkerShape, x: number, y: number, s: number): void {
  switch (shape) {
    case "circle":
      ctx.moveTo(x + s, y);
      ctx.arc(x, y, s, 0, Math.PI * 2);
      break;
    case "square":
      ctx.rect(x - s, y - s, s * 2, s * 2);
      break;
    case "triangle": {
      const h = s * 1.15;
      ctx.moveTo(x, y - h);
      ctx.lineTo(x + h, y + h * 0.75);
      ctx.lineTo(x - h, y + h * 0.75);
      ctx.closePath();
      break;
    }
    case "diamond": {
      const h = s * 1.25;
      ctx.moveTo(x, y - h);
      ctx.lineTo(x + h, y);
      ctx.lineTo(x, y + h);
      ctx.lineTo(x - h, y);
      ctx.closePath();
      break;
    }
    case "cross":
      ctx.moveTo(x - s, y - s);
      ctx.lineTo(x + s, y + s);
      ctx.moveTo(x + s, y - s);
      ctx.lineTo(x - s, y + s);
      break;
    case "plus":
      ctx.moveTo(x - s, y);
      ctx.lineTo(x + s, y);
      ctx.moveTo(x, y - s);
      ctx.lineTo(x, y + s);
      break;
  }
}

const sources = new WeakMap<Uint8ClampedArray, OffscreenCanvas | HTMLCanvasElement>();

/** A canvas holding the pixels, so they can be drawn scaled. Cached per pixel buffer. */
function imageSource(rgba: Uint8ClampedArray<ArrayBuffer>, cols: number, rows: number) {
  const cached = sources.get(rgba);
  if (cached) return cached;
  if (cols === 0 || rows === 0) return null;
  const canvas =
    typeof OffscreenCanvas === "undefined"
      ? Object.assign(document.createElement("canvas"), { width: cols, height: rows })
      : new OffscreenCanvas(cols, rows);
  const context = canvas.getContext("2d") as CanvasRenderingContext2D | null;
  if (!context) return null;
  context.putImageData(new ImageData(rgba, cols, rows), 0, 0);
  sources.set(rgba, canvas);
  return canvas;
}

const isOpenShape = (shape: MarkerShape): boolean => shape === "cross" || shape === "plus";

/**
 * Draws a display list. The context must already be scaled so that one unit
 * is one CSS pixel; `dpr` is that scale, used to snap axis and tick lines to
 * whole device pixels so they stay sharp at any zoom level.
 */
export function drawPrims(ctx: Ctx, prims: readonly Prim[], dpr: number): void {
  for (const prim of prims) {
    switch (prim.kind) {
      case "rect":
        if (prim.fill) {
          ctx.fillStyle = prim.fill;
          ctx.fillRect(prim.x, prim.y, prim.w, prim.h);
        }
        if (prim.stroke) {
          ctx.strokeStyle = prim.stroke;
          ctx.lineWidth = prim.width ?? 1;
          ctx.setLineDash([]);
          ctx.strokeRect(prim.x + 0.5, prim.y + 0.5, prim.w - 1, prim.h - 1);
        }
        break;
      case "polyline": {
        const { points } = prim;
        if (points.length < 2) break;
        ctx.beginPath();
        ctx.moveTo(points[0]!, points[1]!);
        if (points.length === 2) ctx.lineTo(points[0]!, points[1]!);
        for (let index = 2; index < points.length; index += 2) {
          ctx.lineTo(points[index]!, points[index + 1]!);
        }
        ctx.strokeStyle = prim.stroke;
        ctx.lineWidth = prim.width;
        ctx.lineJoin = "round";
        ctx.lineCap = points.length === 2 ? "round" : "butt";
        ctx.setLineDash(prim.dash ? [...prim.dash] : []);
        ctx.stroke();
        break;
      }
      case "polygon": {
        const { points } = prim;
        if (points.length < 6) break;
        ctx.beginPath();
        ctx.moveTo(points[0]!, points[1]!);
        for (let index = 2; index < points.length; index += 2) {
          ctx.lineTo(points[index]!, points[index + 1]!);
        }
        ctx.closePath();
        const alpha = ctx.globalAlpha;
        ctx.globalAlpha = alpha * (prim.opacity ?? 1);
        ctx.fillStyle = prim.fill;
        ctx.fill();
        ctx.globalAlpha = alpha;
        break;
      }
      case "segments": {
        const { points } = prim;
        ctx.strokeStyle = prim.stroke;
        ctx.setLineDash(prim.dash ? [...prim.dash] : []);
        ctx.beginPath();
        if (prim.crisp) {
          // Work in device pixels so every line covers whole pixels.
          const lineWidth = Math.max(1, Math.round(prim.width * dpr));
          const offset = (lineWidth % 2) / 2;
          const snap = (value: number) => Math.round(value * dpr) + offset;
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          for (let index = 0; index < points.length; index += 4) {
            const ax = points[index]!;
            const ay = points[index + 1]!;
            const bx = points[index + 2]!;
            const by = points[index + 3]!;
            if (ax === bx) {
              const x = snap(ax);
              ctx.moveTo(x, Math.round(ay * dpr));
              ctx.lineTo(x, Math.round(by * dpr));
            } else {
              const y = snap(ay);
              ctx.moveTo(Math.round(ax * dpr), y);
              ctx.lineTo(Math.round(bx * dpr), y);
            }
          }
          ctx.lineWidth = lineWidth;
          ctx.lineCap = "square";
          ctx.stroke();
          ctx.restore();
        } else {
          for (let index = 0; index < points.length; index += 4) {
            ctx.moveTo(points[index]!, points[index + 1]!);
            ctx.lineTo(points[index + 2]!, points[index + 3]!);
          }
          ctx.lineWidth = prim.width;
          ctx.lineCap = "butt";
          ctx.stroke();
        }
        break;
      }
      case "markers": {
        const { points } = prim;
        ctx.beginPath();
        for (let index = 0; index < points.length; index += 2) {
          traceMarker(ctx, prim.shape, points[index]!, points[index + 1]!, prim.size);
        }
        if (prim.fill && !isOpenShape(prim.shape)) {
          ctx.fillStyle = prim.fill;
          ctx.fill();
        }
        if (prim.width > 0) {
          ctx.strokeStyle = prim.stroke;
          ctx.lineWidth = prim.width;
          ctx.lineCap = "butt";
          ctx.lineJoin = "miter";
          ctx.setLineDash([]);
          ctx.stroke();
        }
        break;
      }
      case "text":
        ctx.font = `${prim.size}px ${prim.family}`;
        ctx.fillStyle = prim.fill;
        ctx.textBaseline = "alphabetic";
        ctx.textAlign = "left";
        if (prim.rotate) {
          ctx.save();
          ctx.translate(prim.x, prim.y);
          ctx.rotate((prim.rotate * Math.PI) / 180);
          ctx.fillText(prim.text, 0, 0);
          ctx.restore();
        } else {
          ctx.fillText(prim.text, prim.x, prim.y);
        }
        break;
      case "image": {
        const source = imageSource(prim.rgba, prim.cols, prim.rows);
        if (!source) break;
        const smoothing = ctx.imageSmoothingEnabled;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(source, prim.x, prim.y, prim.w, prim.h);
        ctx.imageSmoothingEnabled = smoothing;
        break;
      }
      case "clip":
        ctx.save();
        ctx.beginPath();
        ctx.rect(prim.x, prim.y, prim.w, prim.h);
        ctx.clip();
        drawPrims(ctx, prim.children, dpr);
        ctx.restore();
        break;
    }
  }
}
