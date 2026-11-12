import type { MarkerShape } from "../doc/types";
import type { Prim } from "./displayList";
import { encodePng, toBase64 } from "./png";

const num = (value: number): string => String(Math.round(value * 100) / 100);

const escapeXml = (text: string): string =>
  text.replace(/[&<>"]/g, (char) =>
    char === "&" ? "&amp;" : char === "<" ? "&lt;" : char === ">" ? "&gt;" : "&quot;",
  );

function markerPath(shape: MarkerShape, x: number, y: number, s: number): string {
  switch (shape) {
    case "circle":
      return `M${num(x - s)} ${num(y)}a${num(s)} ${num(s)} 0 1 0 ${num(s * 2)} 0a${num(s)} ${num(s)} 0 1 0 ${num(-s * 2)} 0z`;
    case "square":
      return `M${num(x - s)} ${num(y - s)}h${num(s * 2)}v${num(s * 2)}h${num(-s * 2)}z`;
    case "triangle": {
      const h = s * 1.15;
      return `M${num(x)} ${num(y - h)}L${num(x + h)} ${num(y + h * 0.75)}L${num(x - h)} ${num(y + h * 0.75)}z`;
    }
    case "diamond": {
      const h = s * 1.25;
      return `M${num(x)} ${num(y - h)}L${num(x + h)} ${num(y)}L${num(x)} ${num(y + h)}L${num(x - h)} ${num(y)}z`;
    }
    case "cross":
      return `M${num(x - s)} ${num(y - s)}L${num(x + s)} ${num(y + s)}M${num(x + s)} ${num(y - s)}L${num(x - s)} ${num(y + s)}`;
    case "plus":
      return `M${num(x - s)} ${num(y)}L${num(x + s)} ${num(y)}M${num(x)} ${num(y - s)}L${num(x)} ${num(y + s)}`;
  }
}

function dashAttr(dash: readonly number[] | undefined): string {
  return dash ? ` stroke-dasharray="${dash.join(" ")}"` : "";
}

function render(prims: readonly Prim[], state: { clips: number }, out: string[]): void {
  for (const prim of prims) {
    switch (prim.kind) {
      case "rect": {
        const stroke = prim.stroke
          ? ` stroke="${prim.stroke}" stroke-width="${num(prim.width ?? 1)}"`
          : "";
        // A stroked rect is inset half a pixel so the border is one sharp pixel.
        const inset = prim.stroke ? 0.5 : 0;
        out.push(
          `<rect x="${num(prim.x + inset)}" y="${num(prim.y + inset)}" width="${num(prim.w - inset * 2)}" height="${num(prim.h - inset * 2)}" fill="${prim.fill ?? "none"}"${stroke}/>`,
        );
        break;
      }
      case "polyline": {
        const { points } = prim;
        if (points.length < 2) break;
        const coords: string[] = [];
        for (let index = 0; index < points.length; index += 2) {
          coords.push(`${num(points[index]!)},${num(points[index + 1]!)}`);
        }
        if (coords.length === 1) coords.push(coords[0]!);
        out.push(
          `<polyline points="${coords.join(" ")}" fill="none" stroke="${prim.stroke}" stroke-width="${num(prim.width)}" stroke-linejoin="round"${coords.length === 2 ? ' stroke-linecap="round"' : ""}${dashAttr(prim.dash)}/>`,
        );
        break;
      }
      case "polygon": {
        const { points } = prim;
        if (points.length < 6) break;
        const coords: string[] = [];
        for (let index = 0; index < points.length; index += 2) {
          coords.push(`${num(points[index]!)},${num(points[index + 1]!)}`);
        }
        const opacity =
          prim.opacity !== undefined && prim.opacity < 1
            ? ` fill-opacity="${num(prim.opacity)}"`
            : "";
        out.push(`<polygon points="${coords.join(" ")}" fill="${prim.fill}"${opacity}/>`);
        break;
      }
      case "segments": {
        const { points } = prim;
        if (points.length < 4) break;
        const offset = prim.crisp && Math.round(prim.width) % 2 === 1 ? 0.5 : 0;
        let d = "";
        for (let index = 0; index < points.length; index += 4) {
          const ax = points[index]!;
          const ay = points[index + 1]!;
          const bx = points[index + 2]!;
          const by = points[index + 3]!;
          const vertical = ax === bx;
          const ox = prim.crisp && vertical ? offset : 0;
          const oy = prim.crisp && !vertical ? offset : 0;
          d += `M${num(ax + ox)} ${num(ay + oy)}L${num(bx + ox)} ${num(by + oy)}`;
        }
        out.push(
          `<path d="${d}" fill="none" stroke="${prim.stroke}" stroke-width="${num(prim.width)}"${prim.crisp ? ' stroke-linecap="square"' : ""}${dashAttr(prim.dash)}/>`,
        );
        break;
      }
      case "markers": {
        const { points } = prim;
        if (points.length < 2) break;
        let d = "";
        for (let index = 0; index < points.length; index += 2) {
          d += markerPath(prim.shape, points[index]!, points[index + 1]!, prim.size);
        }
        const open = prim.shape === "cross" || prim.shape === "plus";
        const fill = prim.fill && !open ? prim.fill : "none";
        const stroke =
          prim.width > 0 ? ` stroke="${prim.stroke}" stroke-width="${num(prim.width)}"` : "";
        out.push(`<path d="${d}" fill="${fill}"${stroke}/>`);
        break;
      }
      case "text": {
        const rotate = prim.rotate
          ? ` transform="rotate(${num(prim.rotate)} ${num(prim.x)} ${num(prim.y)})"`
          : "";
        const style = `${prim.italic ? ' font-style="italic"' : ""}${prim.bold ? ' font-weight="bold"' : ""}`;
        out.push(
          `<text x="${num(prim.x)}" y="${num(prim.y)}" font-family="${escapeXml(prim.family)}" font-size="${num(prim.size)}"${style} fill="${prim.fill}" xml:space="preserve"${rotate}>${escapeXml(prim.text)}</text>`,
        );
        break;
      }
      case "image":
        out.push(
          `<image x="${num(prim.x)}" y="${num(prim.y)}" width="${num(prim.w)}" height="${num(prim.h)}" preserveAspectRatio="none" style="image-rendering:pixelated" href="data:image/png;base64,${toBase64(encodePng(prim.rgba, prim.cols, prim.rows))}"/>`,
        );
        break;
      case "clip": {
        const id = `clip${(state.clips += 1)}`;
        out.push(
          `<clipPath id="${id}"><rect x="${num(prim.x)}" y="${num(prim.y)}" width="${num(prim.w)}" height="${num(prim.h)}"/></clipPath>`,
          `<g clip-path="url(#${id})">`,
        );
        render(prim.children, state, out);
        out.push("</g>");
        break;
      }
    }
  }
}

/** Serializes a display list as a standalone SVG document. */
export function toSvg(prims: readonly Prim[], width: number, height: number): string {
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(width)}" height="${num(height)}" viewBox="0 0 ${num(width)} ${num(height)}">`,
  ];
  render(prims, { clips: 0 }, out);
  out.push("</svg>");
  return out.join("\n");
}
