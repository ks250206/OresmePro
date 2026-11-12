import { zlibSync } from "fflate";
import type { MarkerShape } from "../doc/types";
import type { Prim } from "./displayList";

/**
 * Writes a display list as a one-page vector PDF.
 *
 * Text uses the fonts every PDF viewer has built in, so nothing is embedded:
 * Helvetica, Times or Courier for Latin text, and Symbol for Greek and
 * mathematical signs. Other scripts (Japanese, say) have no such font, so
 * that text is drawn as a picture when a rasterizer is supplied; without
 * one it falls back to a standard Japanese font that only some viewers have.
 */

/** Text drawn to pixels, for scripts the built-in PDF fonts cannot show. */
export interface RasterText {
  cols: number;
  rows: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;
  /** Size in CSS pixels: advance width, and extent above and below the baseline. */
  width: number;
  ascent: number;
  descent: number;
}

export interface PdfOptions {
  rasterizeText?: (text: string, family: string, size: number, fill: string) => RasterText | null;
  /**
   * PDF points per unit of the display list. By default 0.75: the list is in
   * CSS pixels. A page layout is in points already and passes 1.
   */
  scale?: number;
}

const num = (value: number): string => String(Math.round(value * 1000) / 1000);

function rgb(color: string): string {
  const value = Number.parseInt(color.slice(1), 16);
  return `${num(((value >> 16) & 255) / 255)} ${num(((value >> 8) & 255) / 255)} ${num((value & 255) / 255)}`;
}

/** Characters outside Latin-1 that the standard Latin fonts do have. */
const WIN_ANSI: Record<number, number> = {
  0x2013: 0x96,
  0x2014: 0x97,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2026: 0x85,
  0x20ac: 0x80,
  0x03bc: 0xb5,
};

/** Greek letters and signs, as character codes of the Symbol font. */
const SYMBOL: Record<number, number> = {
  0x2212: 0x2d,
  0x2264: 0xa3,
  0x2265: 0xb3,
  0x2260: 0xb9,
  0x2248: 0xbb,
  0x221e: 0xa5,
  0x2202: 0xb6,
  0x221a: 0xd6,
  0x2192: 0xae,
  0x2190: 0xac,
  0x221d: 0xb5,
  0x2206: 0x44,
  0x2126: 0x57,
};
const GREEK_UPPER = "ABGDEZHQIKLMNXOPR STUFCYW";
const GREEK_LOWER = "abgdezhqiklmnxoprVstufcyw";
for (let index = 0; index < 25; index += 1) {
  if (GREEK_UPPER[index] !== " ") SYMBOL[0x391 + index] = GREEK_UPPER.charCodeAt(index);
  SYMBOL[0x3b1 + index] = GREEK_LOWER.charCodeAt(index);
}

type FontKey = "latin" | "symbol" | "cjk";

/** Splits text into runs that one font can draw, as hex strings. */
function textRuns(text: string): { font: FontKey; hex: string }[] {
  const runs: { font: FontKey; hex: string }[] = [];
  const hex = (value: number, digits: number) => value.toString(16).padStart(digits, "0");
  for (const char of text) {
    const code = char.codePointAt(0)!;
    let font: FontKey;
    let encoded: string;
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) {
      font = "latin";
      encoded = hex(code, 2);
    } else if (WIN_ANSI[code] !== undefined) {
      font = "latin";
      encoded = hex(WIN_ANSI[code], 2);
    } else if (SYMBOL[code] !== undefined) {
      font = "symbol";
      encoded = hex(SYMBOL[code], 2);
    } else {
      font = "cjk";
      encoded = code > 0xffff ? "003f" : hex(code, 4);
    }
    const last = runs.at(-1);
    if (last?.font === font) last.hex += encoded;
    else runs.push({ font, hex: encoded });
  }
  return runs;
}

function latinFont(family: string): string {
  const name = family.toLowerCase();
  if (name.includes("courier") || name.includes("mono")) return "Courier";
  if (name.includes("times") || (name.includes("serif") && !name.includes("sans")))
    return "Times-Roman";
  return "Helvetica";
}

function markerPath(shape: MarkerShape, x: number, y: number, s: number): string {
  const p = (px: number, py: number) => `${num(px)} ${num(py)}`;
  switch (shape) {
    case "circle": {
      const k = s * 0.5523;
      return (
        `${p(x + s, y)} m ${p(x + s, y + k)} ${p(x + k, y + s)} ${p(x, y + s)} c ` +
        `${p(x - k, y + s)} ${p(x - s, y + k)} ${p(x - s, y)} c ` +
        `${p(x - s, y - k)} ${p(x - k, y - s)} ${p(x, y - s)} c ` +
        `${p(x + k, y - s)} ${p(x + s, y - k)} ${p(x + s, y)} c h `
      );
    }
    case "square":
      return `${p(x - s, y - s)} ${num(s * 2)} ${num(s * 2)} re `;
    case "triangle": {
      const h = s * 1.15;
      return `${p(x, y - h)} m ${p(x + h, y + h * 0.75)} l ${p(x - h, y + h * 0.75)} l h `;
    }
    case "diamond": {
      const h = s * 1.25;
      return `${p(x, y - h)} m ${p(x + h, y)} l ${p(x, y + h)} l ${p(x - h, y)} l h `;
    }
    case "cross":
      return `${p(x - s, y - s)} m ${p(x + s, y + s)} l ${p(x + s, y - s)} m ${p(x - s, y + s)} l `;
    case "plus":
      return `${p(x - s, y)} m ${p(x + s, y)} l ${p(x, y - s)} m ${p(x, y + s)} l `;
  }
}

interface PdfImage {
  cols: number;
  rows: number;
  rgb: Uint8Array;
  /** Present only when some pixel is transparent. */
  alpha: Uint8Array | null;
}

interface Context {
  out: string[];
  /** Fill opacities in use, by graphics state name. */
  alphas: Map<number, string>;
  fonts: Map<string, string>;
  images: PdfImage[];
  options: PdfOptions;
}

function addImage(context: Context, rgba: Uint8ClampedArray, cols: number, rows: number): string {
  const count = cols * rows;
  const pixels = new Uint8Array(count * 3);
  const alpha = new Uint8Array(count);
  let transparent = false;
  for (let index = 0; index < count; index += 1) {
    pixels[index * 3] = rgba[index * 4]!;
    pixels[index * 3 + 1] = rgba[index * 4 + 1]!;
    pixels[index * 3 + 2] = rgba[index * 4 + 2]!;
    alpha[index] = rgba[index * 4 + 3]!;
    if (alpha[index] !== 255) transparent = true;
  }
  context.images.push({ cols, rows, rgb: pixels, alpha: transparent ? alpha : null });
  return `/Im${context.images.length}`;
}

function fontName(context: Context, base: string): string {
  let name = context.fonts.get(base);
  if (!name) context.fonts.set(base, (name = `F${context.fonts.size + 1}`));
  return name;
}

const dashOp = (dash: readonly number[] | undefined): string =>
  dash ? `[${dash.map(num).join(" ")}] 0 d` : "[] 0 d";

function render(prims: readonly Prim[], context: Context): void {
  const { out } = context;
  for (const prim of prims) {
    switch (prim.kind) {
      case "rect":
        if (prim.fill) {
          out.push(
            `${rgb(prim.fill)} rg ${num(prim.x)} ${num(prim.y)} ${num(prim.w)} ${num(prim.h)} re f`,
          );
        }
        if (prim.stroke) {
          out.push(
            `${rgb(prim.stroke)} RG ${num(prim.width ?? 1)} w [] 0 d 0 J 0 j ` +
              `${num(prim.x + 0.5)} ${num(prim.y + 0.5)} ${num(prim.w - 1)} ${num(prim.h - 1)} re S`,
          );
        }
        break;
      case "polyline": {
        const { points } = prim;
        if (points.length < 2) break;
        let path = `${num(points[0]!)} ${num(points[1]!)} m `;
        if (points.length === 2) path += `${num(points[0]!)} ${num(points[1]!)} l `;
        for (let index = 2; index < points.length; index += 2) {
          path += `${num(points[index]!)} ${num(points[index + 1]!)} l `;
        }
        out.push(
          `${rgb(prim.stroke)} RG ${num(prim.width)} w ${dashOp(prim.dash)} ${points.length === 2 ? 1 : 0} J 1 j ${path}S`,
        );
        break;
      }
      case "polygon": {
        const { points } = prim;
        if (points.length < 6) break;
        let path = `${num(points[0]!)} ${num(points[1]!)} m `;
        for (let index = 2; index < points.length; index += 2) {
          path += `${num(points[index]!)} ${num(points[index + 1]!)} l `;
        }
        const opacity = Math.round((prim.opacity ?? 1) * 100) / 100;
        if (opacity < 1) {
          let name = context.alphas.get(opacity);
          if (!name) context.alphas.set(opacity, (name = `GS${context.alphas.size + 1}`));
          out.push(`q /${name} gs ${rgb(prim.fill)} rg ${path}h f Q`);
        } else {
          out.push(`${rgb(prim.fill)} rg ${path}h f`);
        }
        break;
      }
      case "segments": {
        const { points } = prim;
        if (points.length < 4) break;
        const offset = prim.crisp && Math.round(prim.width) % 2 === 1 ? 0.5 : 0;
        let path = "";
        for (let index = 0; index < points.length; index += 4) {
          const vertical = points[index] === points[index + 2];
          const ox = prim.crisp && vertical ? offset : 0;
          const oy = prim.crisp && !vertical ? offset : 0;
          path +=
            `${num(points[index]! + ox)} ${num(points[index + 1]! + oy)} m ` +
            `${num(points[index + 2]! + ox)} ${num(points[index + 3]! + oy)} l `;
        }
        out.push(
          `${rgb(prim.stroke)} RG ${num(prim.width)} w ${dashOp(prim.dash)} ${prim.crisp ? 2 : 0} J 0 j ${path}S`,
        );
        break;
      }
      case "markers": {
        const { points } = prim;
        if (points.length < 2) break;
        let path = "";
        for (let index = 0; index < points.length; index += 2) {
          path += markerPath(prim.shape, points[index]!, points[index + 1]!, prim.size);
        }
        const open = prim.shape === "cross" || prim.shape === "plus";
        const fill = prim.fill && !open ? prim.fill : null;
        const stroke = prim.width > 0;
        if (!fill && !stroke) break;
        out.push(
          `${fill ? `${rgb(fill)} rg ` : ""}${stroke ? `${rgb(prim.stroke)} RG ${num(prim.width)} w [] 0 d 0 J 0 j ` : ""}` +
            `${path}${fill && stroke ? "B" : fill ? "f" : "S"}`,
        );
        break;
      }
      case "text": {
        const angle = ((prim.rotate ?? 0) * Math.PI) / 180;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const runs = textRuns(prim.text);
        const picture = runs.some((run) => run.font === "cjk")
          ? context.options.rasterizeText?.(prim.text, prim.family, prim.size, prim.fill)
          : null;
        if (picture) {
          // Place the picture in the text's own frame: origin at the baseline start.
          const height = picture.ascent + picture.descent;
          const name = addImage(context, picture.rgba, picture.cols, picture.rows);
          out.push(
            `q ${num(cos)} ${num(sin)} ${num(-sin)} ${num(cos)} ${num(prim.x)} ${num(prim.y)} cm ` +
              `${num(picture.width)} 0 0 ${num(-height)} 0 ${num(picture.descent)} cm ${name} Do Q`,
          );
          break;
        }
        // Glyphs are upright in a y-up space; the page here is y-down.
        let line = `BT ${rgb(prim.fill)} rg ${num(cos)} ${num(sin)} ${num(sin)} ${num(-cos)} ${num(prim.x)} ${num(prim.y)} Tm`;
        for (const run of runs) {
          const base =
            run.font === "latin"
              ? latinFont(prim.family)
              : run.font === "symbol"
                ? "Symbol"
                : "CJK";
          line += ` /${fontName(context, base)} ${num(prim.size)} Tf <${run.hex}> Tj`;
        }
        out.push(`${line} ET`);
        break;
      }
      case "image":
        out.push(
          `q ${num(prim.w)} 0 0 ${num(-prim.h)} ${num(prim.x)} ${num(prim.y + prim.h)} cm ` +
            `${addImage(context, prim.rgba, prim.cols, prim.rows)} Do Q`,
        );
        break;
      case "clip":
        out.push(`q ${num(prim.x)} ${num(prim.y)} ${num(prim.w)} ${num(prim.h)} re W n`);
        render(prim.children, context);
        out.push("Q");
        break;
    }
  }
}

const ascii = (text: string): Uint8Array => Uint8Array.from(text, (char) => char.charCodeAt(0));

export function toPdf(
  prims: readonly Prim[],
  width: number,
  height: number,
  options: PdfOptions = {},
): Uint8Array {
  const context: Context = { out: [], alphas: new Map(), fonts: new Map(), images: [], options };
  const scale = options.scale ?? 0.75;
  const pageWidth = width * scale;
  const pageHeight = height * scale;
  context.out.push(`${num(scale)} 0 0 ${num(-scale)} 0 ${num(pageHeight)} cm`);
  render(prims, context);

  // Objects are numbered from 1; bodies are collected first, then written with offsets.
  const objects: Uint8Array[][] = [];
  const add = (...parts: (string | Uint8Array)[]): number => {
    objects.push(parts.map((part) => (typeof part === "string" ? ascii(part) : part)));
    return objects.length;
  };
  const stream = (dictionary: string, data: Uint8Array): number => {
    const packed = zlibSync(data);
    return add(
      `<< ${dictionary} /Filter /FlateDecode /Length ${packed.length} >>\nstream\n`,
      packed,
      "\nendstream",
    );
  };

  const catalog = add("");
  const pages = add("");
  const page = add("");
  const content = stream("", ascii(context.out.join("\n")));

  const fontRefs: string[] = [];
  for (const [base, name] of context.fonts) {
    let id: number;
    if (base === "CJK") {
      const descriptor = add(
        "<< /Type /FontDescriptor /FontName /HeiseiKakuGo-W5 /Flags 4 /FontBBox [-92 -250 1010 922] " +
          "/ItalicAngle 0 /Ascent 752 /Descent -271 /CapHeight 737 /StemV 114 >>",
      );
      const descendant = add(
        "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiKakuGo-W5 " +
          "/CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 2 >> " +
          `/FontDescriptor ${descriptor} 0 R /DW 1000 >>`,
      );
      id = add(
        "<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiKakuGo-W5 /Encoding /UniJIS-UCS2-H " +
          `/DescendantFonts [${descendant} 0 R] >>`,
      );
    } else {
      const encoding = base === "Symbol" ? "" : " /Encoding /WinAnsiEncoding";
      id = add(`<< /Type /Font /Subtype /Type1 /BaseFont /${base}${encoding} >>`);
    }
    fontRefs.push(`/${name} ${id} 0 R`);
  }

  const imageRefs = context.images.map((image, index) => {
    const size = `/Width ${image.cols} /Height ${image.rows} /BitsPerComponent 8`;
    const mask = image.alpha
      ? stream(`/Type /XObject /Subtype /Image ${size} /ColorSpace /DeviceGray`, image.alpha)
      : null;
    const id = stream(
      `/Type /XObject /Subtype /Image ${size} /ColorSpace /DeviceRGB${mask ? ` /SMask ${mask} 0 R` : ""}`,
      image.rgb,
    );
    return `/Im${index + 1} ${id} 0 R`;
  });

  const alphaRefs = [...context.alphas].map(
    ([opacity, name]) => `/${name} << /Type /ExtGState /ca ${num(opacity)} >>`,
  );

  objects[catalog - 1] = [ascii(`<< /Type /Catalog /Pages ${pages} 0 R >>`)];
  objects[pages - 1] = [ascii(`<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`)];
  objects[page - 1] = [
    ascii(
      `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${num(pageWidth)} ${num(pageHeight)}] ` +
        `/Contents ${content} 0 R /Resources << /Font << ${fontRefs.join(" ")} >> ` +
        `/XObject << ${imageRefs.join(" ")} >> /ExtGState << ${alphaRefs.join(" ")} >> >> >>`,
    ),
  ];

  const chunks: Uint8Array[] = [ascii("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")];
  let offset = chunks[0]!.length;
  const offsets: number[] = [];
  objects.forEach((parts, index) => {
    offsets.push(offset);
    for (const part of [ascii(`${index + 1} 0 obj\n`), ...parts, ascii("\nendobj\n")]) {
      chunks.push(part);
      offset += part.length;
    }
  });
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((value) => `${String(value).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  chunks.push(ascii(xref));

  const pdf = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    pdf.set(chunk, at);
    at += chunk.length;
  }
  return pdf;
}
