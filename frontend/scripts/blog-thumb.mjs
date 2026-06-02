// Generates assets/blog-thumb.png for the engineering write-up at
// .docs/notes/blogv1.md. Classic grained-gradient background, big
// title typeset in Fredoka, small pastel wordmark in the corner.
//
// Run with:  node scripts/blog-thumb.mjs

import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { writeFileSync } from "node:fs";

// -----------------------------------------------------------------------
// Fonts: pull Fredoka 500 + 700 from Google Fonts in TTF form. Old CSS
// API serves real TTF (the v2 endpoint serves WOFF2 which Satori can't
// parse), so we hit /css and grep for the .ttf URLs.
// -----------------------------------------------------------------------

async function loadFonts() {
  const cssUrl =
    "https://fonts.googleapis.com/css?family=Fredoka:500,600,700&display=swap";
  const css = await fetch(cssUrl, {
    headers: { "User-Agent": "Mozilla/5.0" },
  }).then((r) => r.text());
  const blocks = css.split("@font-face").slice(1);
  const out = {};
  for (const block of blocks) {
    const weight = Number(block.match(/font-weight:\s*(\d+)/)?.[1]);
    const url = block.match(/url\((https:\/\/[^)]+\.ttf)\)/)?.[1];
    if (!weight || !url) continue;
    const buf = await fetch(url).then((r) => r.arrayBuffer());
    out[weight] = new Uint8Array(buf);
  }
  return out;
}

const fonts = await loadFonts();
if (!fonts[700] || !fonts[600] || !fonts[500]) {
  throw new Error("missing Fredoka weights");
}

// -----------------------------------------------------------------------
// Grain: render a small fractal-noise SVG with resvg, base64 it, then
// pass as a tiled background-image to Satori. Doing it this way means
// we get real noise (not a fake CSS approximation) without depending on
// any pre-built texture file.
// -----------------------------------------------------------------------

function buildNoiseDataUri() {
  const noiseSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240">
    <filter id="g">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2"
                    stitchTiles="stitch" seed="3"/>
      <feColorMatrix values="0 0 0 0 0
                             0 0 0 0 0
                             0 0 0 0 0
                             0 0 0 0.55 0"/>
    </filter>
    <rect width="100%" height="100%" filter="url(#g)"/>
  </svg>`;
  const png = new Resvg(noiseSvg, { fitTo: { mode: "width", value: 240 } })
    .render()
    .asPng();
  return `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
}

const NOISE = buildNoiseDataUri();

// -----------------------------------------------------------------------
// Palette: pastel brand. Background is a soft diagonal gradient of
// cream into peach into a warm beige, so the grain reads against a
// living background rather than a dead solid colour.
// -----------------------------------------------------------------------

const PINK = "#f2a4b0";
const TEAL = "#8ecac4";
const YELLOW = "#e8c96e";
// Warm, on-palette text colours rather than dead neutral grey. Deep
// aubergine reads as "near-black" against the peach gradient but has a
// red undertone that keeps it on-brand. Taupe is the muted partner.
// Rose-deep gives the wordmark a quiet accent without going neon.
const INK = "#2a1a22";
const MUTED = "#7a6a6e";
const ROSE_DEEP = "#7d3a4a";

// Two gradients stacked: a base diagonal and a soft radial highlight in
// the top-left for warmth. The grain image sits on top at low opacity.
const BG_GRADIENT = `radial-gradient(circle at 18% 22%, rgba(242,164,176,0.55) 0%, rgba(242,164,176,0) 45%),
radial-gradient(circle at 82% 78%, rgba(142,202,196,0.32) 0%, rgba(142,202,196,0) 55%),
linear-gradient(135deg, #fdfbf7 0%, #fbeee6 50%, #efe6d8 100%)`;

const node = {
  type: "div",
  props: {
    style: {
      width: "1200px",
      height: "630px",
      display: "flex",
      flexDirection: "column",
      justifyContent: "space-between",
      backgroundImage: `url("${NOISE}"), ${BG_GRADIENT}`,
      backgroundRepeat: "repeat, no-repeat, no-repeat, no-repeat",
      backgroundSize: "240px 240px, 100% 100%, 100% 100%, 100% 100%",
      fontFamily: "Fredoka",
      padding: "60px 72px",
      position: "relative",
    },
    children: [
      // Top row: small wordmark + a faint "engineering notes" eyebrow on
      // the opposite side. Eyebrow gives the thumbnail a "this is a
      // write-up, not the game itself" cue at a glance.
      {
        type: "div",
        props: {
          style: {
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          },
          children: [
            {
              type: "div",
              props: {
                style: {
                  display: "flex",
                  alignItems: "center",
                  gap: "14px",
                  fontSize: "34px",
                  fontWeight: 700,
                  color: ROSE_DEEP,
                  letterSpacing: "-0.5px",
                },
                children: [
                  {
                    type: "div",
                    props: {
                      style: {
                        width: "22px",
                        height: "22px",
                        borderRadius: "11px",
                        backgroundColor: PINK,
                        display: "flex",
                      },
                    },
                  },
                  {
                    type: "div",
                    props: {
                      style: { display: "flex" },
                      children: "pastel",
                    },
                  },
                ],
              },
            },
            {
              type: "div",
              props: {
                style: {
                  fontSize: "18px",
                  fontWeight: 500,
                  letterSpacing: "0.18em",
                  color: MUTED,
                  textTransform: "uppercase",
                  paddingTop: "6px",
                  paddingBottom: "6px",
                  paddingLeft: "14px",
                  paddingRight: "14px",
                  borderRadius: "999px",
                  border: `1px dashed ${MUTED}`,
                  display: "flex",
                },
                children: "engineering notes",
              },
            },
          ],
        },
      },

      // Title block: the actual blog title, wrapped onto two lines, with
      // a thin pastel accent rule above to anchor it.
      {
        type: "div",
        props: {
          style: {
            display: "flex",
            flexDirection: "column",
            gap: "26px",
            alignItems: "flex-start",
            maxWidth: "1000px",
          },
          children: [
            {
              type: "div",
              props: {
                style: {
                  width: "92px",
                  height: "6px",
                  borderRadius: "3px",
                  backgroundColor: PINK,
                  display: "flex",
                },
              },
            },
            {
              type: "div",
              props: {
                style: {
                  fontSize: "76px",
                  fontWeight: 700,
                  color: INK,
                  lineHeight: 1.05,
                  letterSpacing: "-2.2px",
                  display: "flex",
                  flexDirection: "column",
                },
                children: [
                  {
                    type: "div",
                    props: {
                      style: { display: "flex" },
                      children: "i wanted a convenient skribbl,",
                    },
                  },
                  {
                    type: "div",
                    props: {
                      style: { display: "flex" },
                      children: "so i built it in rust.",
                    },
                  },
                ],
              },
            },
          ],
        },
      },

      // Bottom row: a tagline pulled from the post's lede, plus three
      // pastel dots that echo the wordmark dot. Quiet, no logos beyond
      // the brand itself.
      {
        type: "div",
        props: {
          style: {
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          },
          children: [
            {
              type: "div",
              props: {
                style: {
                  fontSize: "28px",
                  fontWeight: 500,
                  color: MUTED,
                  display: "flex",
                  alignItems: "center",
                  gap: "14px",
                },
                children: [
                  {
                    type: "div",
                    props: {
                      style: { display: "flex" },
                      children: "real-time multiplayer drawing. rust + tokio + postcard.",
                    },
                  },
                ],
              },
            },
            {
              type: "div",
              props: {
                style: {
                  display: "flex",
                  alignItems: "center",
                  gap: "10px",
                },
                children: [
                  { type: "div", props: { style: dot(PINK) } },
                  { type: "div", props: { style: dot(YELLOW) } },
                  { type: "div", props: { style: dot(TEAL) } },
                ],
              },
            },
          ],
        },
      },
    ],
  },
};

function dot(bg) {
  return {
    width: "14px",
    height: "14px",
    borderRadius: "7px",
    backgroundColor: bg,
    display: "flex",
  };
}

const svg = await satori(node, {
  width: 1200,
  height: 630,
  fonts: [
    { name: "Fredoka", data: fonts[500], weight: 500, style: "normal" },
    { name: "Fredoka", data: fonts[600], weight: 600, style: "normal" },
    { name: "Fredoka", data: fonts[700], weight: 700, style: "normal" },
  ],
});

const png = new Resvg(svg, { fitTo: { mode: "width", value: 1200 } })
  .render()
  .asPng();

// Output goes to repo-root /assets so the existing blog image-host
// convention (raw.githubusercontent.com/.../main/assets/*.png) keeps
// working.
const outPath = new URL("../../assets/blog-thumb.png", import.meta.url);
writeFileSync(outPath, png);
console.log(`wrote ${outPath.pathname}`);
