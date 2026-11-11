import { DocError } from "./types";

const NAMED: Record<string, string> = {
  red: "#ff0000",
  blue: "#0000ff",
  green: "#009900",
  black: "#000000",
  white: "#ffffff",
  gray: "#808080",
  grey: "#808080",
  orange: "#ff9900",
  purple: "#9900cc",
  cyan: "#00a0c8",
  magenta: "#ff00cc",
  yellow: "#e6c800",
  brown: "#996633",
};

const hex2 = (value: number): string => value.toString(16).padStart(2, "0");

/**
 * Accepts `#rgb`, `#rrggbb`, a color name, or an `[r, g, b]` triple of 0-255
 * values, and returns `#rrggbb`.
 */
export function normalizeColor(value: unknown): string {
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(text)) return text;
    if (/^#[0-9a-f]{3}$/.test(text)) {
      return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`;
    }
    const named = NAMED[text];
    if (named) return named;
    throw new DocError(
      `Unknown color ${JSON.stringify(value)}. Use "#rrggbb", an (r, g, b) triple, or one of: ${Object.keys(NAMED).join(", ")}.`,
    );
  }
  if (Array.isArray(value) && value.length === 3) {
    const parts = value.map((part) => {
      if (typeof part !== "number" || !Number.isFinite(part) || part < 0 || part > 255) {
        throw new DocError("Color components must be numbers from 0 to 255.");
      }
      return hex2(Math.round(part));
    });
    return `#${parts.join("")}`;
  }
  throw new DocError('A color must be "#rrggbb", a color name, or an (r, g, b) triple.');
}

export const COLOR_NAMES = Object.keys(NAMED);
