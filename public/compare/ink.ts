import type * as pdfjs from "pdfjs-dist";
import type { Box, TextRun } from "./diffcore";

export type Rect = { left: number; right: number; top: number; bottom: number }; // CSS px within the page

/**
 * Where words really are on a rendered page. pdf.js gives each text run's width but not
 * each character's, and justified text stretches the spaces, so evenly spaced estimates
 * drift along a line. This reads the rendered pixels instead: the gaps between words in
 * a run are its widest blank columns, and each word is trimmed to its own ink.
 */
export class PageInk {
  private pixels: Uint8ClampedArray | null = null;
  private k: number; // measuring-canvas pixels per CSS pixel
  private anchors = new Map<TextRun, number[]>();

  constructor(
    private page: pdfjs.PDFPageProxy,
    private canvas: HTMLCanvasElement,
    private viewport: pdfjs.PageViewport,
  ) {
    this.k = canvas.width / viewport.width;
  }

  /**
   * Make sure there are enough pixels to tell word spaces from letter spacing. On a 1x
   * screen the page on display is too coarse, so measure on a sharper off-screen copy.
   */
  async prepare() {
    const MIN = 3; // canvas pixels per PDF point
    const density = this.canvas.width / this.page.getViewport({ scale: 1 }).width;
    if (this.pixels || density >= MIN) return;
    const viewport = this.page.getViewport({ scale: MIN });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await this.page.render({ canvas, viewport }).promise;
    this.canvas = canvas;
    this.k = canvas.width / this.viewport.width;
  }

  /** A word part's box in CSS px, measured against the ink. */
  rect(box: Box): Rect {
    const [top, bottom] = this.band(box);
    const xs = this.anchorsOf(box.run);
    const [left, right] = this.trim(xs[box.from]!, xs[box.to]!, box) ?? [xs[box.from]!, xs[box.to]!];
    return { left, right, top, bottom };
  }

  /** Vertical extent of a line: a bit below the baseline for descenders, most of the size above. */
  private band(box: { y: number; h: number }): [number, number] {
    const [, top] = this.viewport.convertToViewportPoint(0, box.y + box.h * 0.85) as [number, number];
    const [, bottom] = this.viewport.convertToViewportPoint(0, box.y - box.h * 0.25) as [number, number];
    return [Math.min(top, bottom), Math.max(top, bottom)];
  }

  /** x (CSS px) at each character boundary of a run; exact at spaces and run ends, which is where words start and stop. */
  private anchorsOf(run: TextRun): number[] {
    let xs = this.anchors.get(run);
    if (xs) return xs;
    const [left] = this.viewport.convertToViewportPoint(run.x, run.y) as [number, number];
    const [right] = this.viewport.convertToViewportPoint(run.x + run.w, run.y) as [number, number];
    const n = run.str.length;
    xs = Array.from({ length: n + 1 }, (_, i) => left + ((right - left) * i) / Math.max(1, n));
    const spaces = [...run.str].flatMap((ch, i) => (/\s/.test(ch) ? [i] : []));
    if (spaces.length) {
      const gaps = this.gaps(left, right, run);
      if (gaps.length >= spaces.length) {
        // The widest blank stretches are the word spaces; letters sit much closer together.
        const chosen = [...gaps].sort((a, b) => b[1] - b[0] - (a[1] - a[0])).slice(0, spaces.length).sort((a, b) => a[0] - b[0]);
        spaces.forEach((i, g) => {
          xs![i] = chosen[g]![0];
          xs![i + 1] = chosen[g]![1];
        });
      }
    }
    this.anchors.set(run, xs);
    return xs;
  }

  /** Blank column stretches strictly inside the inked part of [left, right], in CSS px. */
  private gaps(left: number, right: number, line: { y: number; h: number }): [number, number][] {
    const ink = this.columns(left, right, line);
    const first = ink.indexOf(true);
    const last = ink.lastIndexOf(true);
    const out: [number, number][] = [];
    let start = -1;
    for (let c = first; c <= last && first >= 0; c++) {
      if (!ink[c] && start < 0) start = c;
      if (ink[c] && start >= 0) {
        out.push([left + start / this.k, left + c / this.k]);
        start = -1;
      }
    }
    return out;
  }

  /** Shrink [left, right] to the ink inside it (null when there's none, e.g. a space). */
  private trim(left: number, right: number, line: { y: number; h: number }): [number, number] | null {
    const ink = this.columns(left, right, line);
    const first = ink.indexOf(true);
    if (first < 0) return null;
    return [left + first / this.k, left + (ink.lastIndexOf(true) + 1) / this.k];
  }

  /** Whether each canvas column between left and right (CSS px) has ink within the line's band. */
  private columns(left: number, right: number, line: { y: number; h: number }): boolean[] {
    this.pixels ??= this.canvas.getContext("2d")!.getImageData(0, 0, this.canvas.width, this.canvas.height).data;
    const [top, bottom] = this.band({ y: line.y + line.h * 0.05, h: line.h * 0.9 }); // a little inside, clear of neighbouring lines
    const x0 = Math.max(0, Math.floor(left * this.k));
    const x1 = Math.min(this.canvas.width, Math.ceil(right * this.k));
    const y0 = Math.max(0, Math.floor(top * this.k));
    const y1 = Math.min(this.canvas.height, Math.ceil(bottom * this.k));
    const out: boolean[] = [];
    for (let x = x0; x < x1; x++) {
      let inked = false;
      for (let y = y0; y < y1 && !inked; y++) {
        const p = (y * this.canvas.width + x) * 4;
        inked = 255 - Math.min(this.pixels[p]!, this.pixels[p + 1]!, this.pixels[p + 2]!) > 70; // dark enough to be text, not anti-aliasing haze
      }
      out.push(inked);
    }
    return out;
  }
}
