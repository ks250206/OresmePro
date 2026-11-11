import type { MeasureText } from "../core/plot/displayList";

let context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
const cache = new Map<string, number>();

/** Measures text with the browser's own font engine, so layout matches what is drawn. */
export const measureText: MeasureText = (text, size, family) => {
  const key = `${size}|${family}|${text}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  context ??=
    typeof OffscreenCanvas === "undefined"
      ? document.createElement("canvas").getContext("2d")
      : new OffscreenCanvas(1, 1).getContext("2d");
  if (!context) return text.length * size * 0.55;
  context.font = `${size}px ${family}`;
  const { width } = context.measureText(text);
  if (cache.size > 5000) cache.clear();
  cache.set(key, width);
  return width;
};
