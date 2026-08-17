// Avatar rendering + parts table. Wire IDs come straight from the proto
// (each part is a small u8). We map them to DiceBear `big-smile` options.
//
// The wire has 7 fields (skin, hat, hair, eyes, mouth, specs, earrings) but
// big-smile only exposes one accessory slot, so the picker currently edits
// 5 (skin, hair, eyes, mouth, "accessory" which writes to `specs`). The hat
// and earrings fields stay at 0 and exist for forward-compat when we add
// custom SVG overlays or swap to a multi-slot style.

import { createAvatar } from "@dicebear/core";
import { bigSmile } from "@dicebear/collection";
import type { Avatar } from "./proto";
import { DEFAULT_AVATAR } from "./proto";

export type PartKey = "skin" | "hair" | "eyes" | "mouth" | "accessory";

interface PartDef {
  label: string;
  options: { id: number; label: string }[];
}

// Map our skin IDs (0..6) to a desaturated voxi palette. Matches the
// "porcelain / peach / tan / olive / hazel / cocoa / espresso" line from the
// avatar plan.
const SKIN_HEX = [
  "f8ede3", // porcelain
  "f2d1c9", // peach
  "d9a07b", // tan
  "b89b72", // olive
  "8b6b4f", // hazel
  "6b4a3a", // cocoa
  "3b2a24", // espresso
] as const;

const HAIR_VARIANTS = [
  "shavedHead", // 0 bald
  "shortHair", // 1 short
  "straightHair", // 2 long-loose
  "bunHair", // 3 ponytail
  "braids", // 4 twin-buns
  "bangs", // 5 bangs
  "curlyBob", // 6 curly
  "wavyBob", // 7 wavy
] as const;

const EYES_VARIANTS = [
  "normal", // 0 dot
  "cheery", // 1 round
  "sleepy", // 2 sleepy
  "starstruck", // 3 sparkle
  "winking", // 4 wink
  "confused", // 5 heart (closest available)
  "sad", // 6 side-eye (closest)
  "angry", // 7 closed-happy (closest)
] as const;

const MOUTH_VARIANTS = [
  "openedSmile", // 0 small smile
  "teethSmile", // 1 big smile
  "unimpressed", // 2 neutral
  "openSad", // 3 surprised o (closest)
  "awkwardSmile", // 4 smirk
  "kawaii", // 5 tongue (closest)
  "braces", // 6 frown (placeholder)
] as const;

const ACCESSORY_VARIANTS = [
  null, // 0 none
  "glasses",
  "sunglasses",
  "catEars",
  "sailormoonCrown",
] as const;

export const PARTS: Record<PartKey, PartDef> = {
  skin: {
    label: "Skin",
    options: [
      { id: 0, label: "Porcelain" },
      { id: 1, label: "Peach" },
      { id: 2, label: "Tan" },
      { id: 3, label: "Olive" },
      { id: 4, label: "Hazel" },
      { id: 5, label: "Cocoa" },
      { id: 6, label: "Espresso" },
    ],
  },
  hair: {
    label: "Hair",
    options: [
      { id: 0, label: "Bald" },
      { id: 1, label: "Short" },
      { id: 2, label: "Long" },
      { id: 3, label: "Ponytail" },
      { id: 4, label: "Braids" },
      { id: 5, label: "Bangs" },
      { id: 6, label: "Curly" },
      { id: 7, label: "Wavy" },
    ],
  },
  eyes: {
    label: "Eyes",
    options: [
      { id: 0, label: "Dot" },
      { id: 1, label: "Round" },
      { id: 2, label: "Sleepy" },
      { id: 3, label: "Sparkle" },
      { id: 4, label: "Wink" },
      { id: 5, label: "Heart" },
      { id: 6, label: "Side-eye" },
      { id: 7, label: "Happy" },
    ],
  },
  mouth: {
    label: "Mouth",
    options: [
      { id: 0, label: "Small smile" },
      { id: 1, label: "Big smile" },
      { id: 2, label: "Neutral" },
      { id: 3, label: "Surprised" },
      { id: 4, label: "Smirk" },
      { id: 5, label: "Tongue" },
      { id: 6, label: "Pouty" },
    ],
  },
  accessory: {
    label: "Accessory",
    options: [
      { id: 0, label: "None" },
      { id: 1, label: "Glasses" },
      { id: 2, label: "Sunglasses" },
      { id: 3, label: "Cat ears" },
      { id: 4, label: "Crown" },
    ],
  },
};

export function partCount(key: PartKey): number {
  return PARTS[key].options.length;
}

/// Stable seed per avatar so the deterministic noise in DiceBear's renderer
/// (positioning, etc) doesn't shift every time you change a slider.
function avatarSeed(a: Avatar): string {
  return `${a.skin}-${a.hair}-${a.eyes}-${a.mouth}-${a.specs}`;
}

export function renderAvatar(a: Avatar): string {
  const skin = SKIN_HEX[a.skin] ?? SKIN_HEX[0];
  const hair = HAIR_VARIANTS[a.hair] ?? HAIR_VARIANTS[0];
  const eyes = EYES_VARIANTS[a.eyes] ?? EYES_VARIANTS[0];
  const mouth = MOUTH_VARIANTS[a.mouth] ?? MOUTH_VARIANTS[0];
  const accessory = ACCESSORY_VARIANTS[a.specs] ?? null;
  return createAvatar(bigSmile, {
    seed: avatarSeed(a),
    backgroundColor: ["transparent"],
    skinColor: [skin],
    hair: [hair],
    eyes: [eyes],
    mouth: [mouth],
    accessories: accessory ? [accessory] : [],
    accessoriesProbability: accessory ? 100 : 0,
  }).toString();
}

export function randomAvatar(): Avatar {
  const r = (n: number) => Math.floor(Math.random() * n);
  return {
    skin: r(partCount("skin")),
    hat: 0,
    hair: r(partCount("hair")),
    eyes: r(partCount("eyes")),
    mouth: r(partCount("mouth")),
    specs: r(partCount("accessory")),
    earrings: 0,
  };
}

export function loadStoredAvatar(): Avatar {
  const raw = window.localStorage.getItem("voxi.avatar");
  if (!raw) return randomAvatar();
  try {
    const parsed = JSON.parse(raw) as Partial<Avatar>;
    return { ...DEFAULT_AVATAR, ...parsed };
  } catch {
    return randomAvatar();
  }
}

export function saveAvatar(a: Avatar): void {
  window.localStorage.setItem("voxi.avatar", JSON.stringify(a));
}

export function setPart(a: Avatar, key: PartKey, id: number): Avatar {
  const next = { ...a };
  switch (key) {
    case "skin":
      next.skin = id;
      break;
    case "hair":
      next.hair = id;
      break;
    case "eyes":
      next.eyes = id;
      break;
    case "mouth":
      next.mouth = id;
      break;
    case "accessory":
      next.specs = id;
      break;
  }
  return next;
}

export function getPart(a: Avatar, key: PartKey): number {
  switch (key) {
    case "skin":
      return a.skin;
    case "hair":
      return a.hair;
    case "eyes":
      return a.eyes;
    case "mouth":
      return a.mouth;
    case "accessory":
      return a.specs;
  }
}
