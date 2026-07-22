// 30 colours, three flavours of ten. Hex value is stored as 0xRRGGBB integer.

export interface Swatch {
  name: string;
  rgb: number;
}

export interface Palette {
  id: "basic" | "performative" | "queen";
  label: string;
  colors: Swatch[];
}

export const PALETTES: Palette[] = [
  {
    id: "basic",
    label: "Basic",
    colors: [
      { name: "Charcoal", rgb: 0x2d3436 },
      { name: "Slate", rgb: 0x636e72 },
      { name: "Sand", rgb: 0xddd5c7 },
      { name: "Brick", rgb: 0xb54434 },
      { name: "Ochre", rgb: 0xd68c45 },
      { name: "Mustard", rgb: 0xd4a72c },
      { name: "Sage", rgb: 0x87a96b },
      { name: "Denim", rgb: 0x4a6fa5 },
      { name: "Plum", rgb: 0x6b3e75 },
      { name: "Walnut", rgb: 0x8b5e3c },
    ],
  },
  {
    id: "performative",
    label: "Performative",
    colors: [
      { name: "Hot Pink", rgb: 0xff2d87 },
      { name: "Cyan", rgb: 0x00f0ff },
      { name: "Lime", rgb: 0xb8ff00 },
      { name: "Electric", rgb: 0xffe600 },
      { name: "Magenta", rgb: 0xff00aa },
      { name: "Sunset", rgb: 0xff5722 },
      { name: "Toxic", rgb: 0x39ff14 },
      { name: "Aqua", rgb: 0x00ffe1 },
      { name: "Tangerine", rgb: 0xff7e00 },
      { name: "Violet", rgb: 0xb026ff },
    ],
  },
  {
    id: "queen",
    label: "Queen",
    colors: [
      { name: "Ruby", rgb: 0x9b1c2c },
      { name: "Emerald", rgb: 0x046b3a },
      { name: "Sapphire", rgb: 0x1b4d89 },
      { name: "Amethyst", rgb: 0x7a45a5 },
      { name: "Topaz", rgb: 0xd4920a },
      { name: "Rose Gold", rgb: 0xb76e79 },
      { name: "Garnet", rgb: 0x6b2230 },
      { name: "Pearl", rgb: 0xede7d3 },
      { name: "Onyx", rgb: 0x1c1c1c },
      { name: "Antique", rgb: 0x8c6a1a },
    ],
  },
];

export interface Tool {
  id: "pen" | "nib" | "pencil" | "brush" | "pastel" | "crayon" | "eraser" | "fill";
  label: string;
  width: number;
  // When set, choosing this tool forces colour to this value. Used by the
  // eraser, which paints white (destination-out on the canvas).
  forcedColor?: number;
}

// Smallest to largest. Widths are in logical canvas pixels (canvas is 960x600).
// The fill (paint bucket) tool has width 0 as a sentinel: the canvas treats a
// width-0 stroke as a flood fill at its origin, mirroring how the eraser is a
// colour-sentinel stroke. It carries no points on the wire.
export const TOOLS: Tool[] = [
  { id: "pen", label: "Pen", width: 2 },
  { id: "nib", label: "Nib", width: 3 },
  { id: "pencil", label: "Pencil", width: 4 },
  { id: "brush", label: "Brush", width: 8 },
  { id: "pastel", label: "Pastel", width: 14 },
  { id: "crayon", label: "Crayon", width: 20 },
  { id: "fill", label: "Fill", width: 0 },
  { id: "eraser", label: "Eraser", width: 16, forcedColor: 0xffffff },
];

// Width-0 is the paint-bucket sentinel (see TOOLS above).
export const FILL_WIDTH = 0;

export const ERASER_COLOR = 0xffffff;

export function findColor(rgb: number): Swatch | undefined {
  for (const p of PALETTES) {
    for (const c of p.colors) {
      if (c.rgb === rgb) return c;
    }
  }
  return undefined;
}

export function findTool(id: string): Tool | undefined {
  return TOOLS.find((t) => t.id === id);
}

export function rgbToCss(rgb: number): string {
  const r = (rgb >> 16) & 0xff;
  const g = (rgb >> 8) & 0xff;
  const b = rgb & 0xff;
  return `rgb(${r}, ${g}, ${b})`;
}
