// Generates public/og.png using Satori. Run with: node scripts/og.mjs

import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { writeFileSync } from "node:fs";

async function loadFonts() {
  const cssUrl = "https://fonts.googleapis.com/css?family=Fredoka:500,700&display=swap";
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
const fontBold = fonts[700];
const fontMedium = fonts[500];
if (!fontBold || !fontMedium) throw new Error("missing Fredoka weights");

const PINK = "#f2a4b0";
const TEAL = "#8ecac4";
const YELLOW = "#e8c96e";
const INK = "#3a3a3a";
const MUTED = "#7a7a7a";
const CREAM = "#fdfbf7";
const LINE = "#e7e1d6";

const node = {
  type: "div",
  props: {
    style: {
      width: "1200px",
      height: "630px",
      display: "flex",
      flexDirection: "column",
      justifyContent: "center",
      alignItems: "center",
      backgroundColor: CREAM,
      fontFamily: "Fredoka",
      position: "relative",
    },
    children: [
      {
        type: "div",
        props: {
          style: {
            position: "absolute",
            top: "70px",
            left: "100px",
            width: "180px",
            height: "180px",
            borderRadius: "90px",
            backgroundColor: PINK,
            opacity: 0.45,
            display: "flex",
          },
        },
      },
      {
        type: "div",
        props: {
          style: {
            position: "absolute",
            top: "110px",
            right: "150px",
            width: "130px",
            height: "130px",
            borderRadius: "65px",
            backgroundColor: YELLOW,
            opacity: 0.55,
            display: "flex",
          },
        },
      },
      {
        type: "div",
        props: {
          style: {
            position: "absolute",
            bottom: "90px",
            left: "180px",
            width: "110px",
            height: "110px",
            borderRadius: "55px",
            backgroundColor: TEAL,
            opacity: 0.5,
            display: "flex",
          },
        },
      },
      {
        type: "div",
        props: {
          style: {
            position: "absolute",
            bottom: "120px",
            right: "220px",
            width: "70px",
            height: "70px",
            borderRadius: "35px",
            backgroundColor: PINK,
            opacity: 0.4,
            display: "flex",
          },
        },
      },
      {
        type: "div",
        props: {
          style: {
            fontSize: "260px",
            fontWeight: 700,
            color: INK,
            lineHeight: 1,
            letterSpacing: "-6px",
          },
          children: "pastel",
        },
      },
      {
        type: "div",
        props: {
          style: {
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            marginTop: "32px",
            gap: "20px",
          },
          children: [
            {
              type: "div",
              props: {
                style: {
                  width: "14px",
                  height: "14px",
                  borderRadius: "7px",
                  backgroundColor: PINK,
                  display: "flex",
                },
              },
            },
            {
              type: "div",
              props: {
                style: {
                  fontSize: "52px",
                  fontWeight: 500,
                  color: MUTED,
                },
                children: "draw. guess. laugh.",
              },
            },
            {
              type: "div",
              props: {
                style: {
                  width: "14px",
                  height: "14px",
                  borderRadius: "7px",
                  backgroundColor: TEAL,
                  display: "flex",
                },
              },
            },
          ],
        },
      },
      {
        type: "div",
        props: {
          style: {
            position: "absolute",
            bottom: "44px",
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            gap: "10px",
            fontSize: "26px",
            fontWeight: 500,
            color: "#a59f93",
            paddingTop: "12px",
            paddingLeft: "20px",
            paddingRight: "20px",
            borderTop: `2px dashed ${LINE}`,
          },
          children: "playpastel.com",
        },
      },
    ],
  },
};

const svg = await satori(node, {
  width: 1200,
  height: 630,
  fonts: [
    { name: "Fredoka", data: fontBold, weight: 700, style: "normal" },
    { name: "Fredoka", data: fontMedium, weight: 500, style: "normal" },
  ],
});

const png = new Resvg(svg, { fitTo: { mode: "width", value: 1200 } })
  .render()
  .asPng();

const outPath = new URL("../public/og.png", import.meta.url);
writeFileSync(outPath, png);
console.log(`wrote ${outPath.pathname}`);
