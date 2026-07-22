// Pre-room modal: pick a name + avatar before the WS connection opens.
// Replaces the bare `window.prompt`. Resolves once the user clicks "Join".

import {
  getPart,
  loadStoredAvatar,
  PARTS,
  randomAvatar,
  renderAvatar,
  saveAvatar,
  setPart,
  type PartKey,
} from "./avatar";
import type { Avatar } from "./proto";

const STORAGE_NAME = "pastel.name";
const STORAGE_AVATAR = "pastel.avatar";
const PART_ORDER: PartKey[] = ["skin", "hair", "eyes", "mouth", "accessory"];

/// True when the browser has a saved name + avatar from a previous session.
/// When true, callers can skip the picker and reuse the stored identity,
/// pairing with the `pastel.client_token` fingerprint so a reload lands as
/// the same player on the server.
export function hasStoredIdentity(): boolean {
  const name = window.localStorage.getItem(STORAGE_NAME);
  const avatar = window.localStorage.getItem(STORAGE_AVATAR);
  return !!name && name.trim().length > 0 && !!avatar;
}

/// Read the saved identity. Caller should only use this if `hasStoredIdentity`
/// returned true; otherwise the avatar will be a fresh random one and the
/// name will be empty.
export function loadStoredIdentity(): PickedIdentity {
  const name = (window.localStorage.getItem(STORAGE_NAME) ?? "").trim();
  return { name, avatar: loadStoredAvatar() };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export interface PickedIdentity {
  name: string;
  avatar: Avatar;
}

// A small "you're joining as <avatar> <name>" card shown to a player entering
// a room for the first time this session. Resolves true to keep the saved
// identity, false to open the full picker and change it.
export function confirmIdentity(identity: PickedIdentity): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "id-confirm";
    overlay.innerHTML = `
      <section class="id-confirm-card">
        <p class="id-confirm-eyebrow">you're joining as</p>
        <div class="id-confirm-who">
          <span class="id-confirm-avatar">${renderAvatar(identity.avatar)}</span>
          <span class="id-confirm-name">${escapeHtml(identity.name)}</span>
        </div>
        <div class="id-confirm-actions">
          <button type="button" class="id-confirm-change" id="idChange">
            <i class="ph ph-pencil-simple" aria-hidden="true"></i> Change
          </button>
          <button type="button" class="id-confirm-keep" id="idKeep">Looks good!</button>
        </div>
      </section>
    `;
    document.body.appendChild(overlay);

    const done = (keep: boolean): void => {
      overlay.remove();
      resolve(keep);
    };
    overlay.querySelector("#idKeep")!.addEventListener("click", () => done(true));
    overlay.querySelector("#idChange")!.addEventListener("click", () => done(false));
    overlay.querySelector<HTMLButtonElement>("#idKeep")!.focus();
  });
}

export function pickNameAndAvatar(): Promise<PickedIdentity> {
  return new Promise((resolve) => {
    const storedName = window.localStorage.getItem(STORAGE_NAME) ?? "";
    let avatar = loadStoredAvatar();

    const overlay = document.createElement("div");
    overlay.className = "picker";
    overlay.innerHTML = `
      <section class="picker-card">
        <header class="picker-head">
          <h1>Pick your look</h1>
          <p class="picker-tag">Don't worry, you can tweak this anytime.</p>
        </header>

        <div class="picker-preview">
          <div class="picker-svg" id="pickerSvg"></div>
          <button type="button" class="picker-random" id="pickerRandom"
                  title="Surprise me">Surprise me</button>
        </div>

        <label class="field picker-name">
          <span class="field-label">Your name</span>
          <input id="pickerName" type="text" maxlength="32" autocomplete="off"
                 placeholder="what should we call you?"
                 value="${escapeHtml(storedName)}" />
        </label>

        <nav class="picker-tabs" id="pickerTabs">
          ${PART_ORDER.map(
            (k, i) => `
            <button type="button" class="picker-tab ${
              i === 0 ? "picker-tab--on" : ""
            }" data-part="${k}">${escapeHtml(PARTS[k].label)}</button>`,
          ).join("")}
        </nav>

        <div class="picker-options" id="pickerOptions"></div>

        <button type="button" class="picker-submit" id="pickerSubmit">
          Looking good! Join in
        </button>
      </section>
    `;
    document.body.appendChild(overlay);

    const svgEl = overlay.querySelector<HTMLElement>("#pickerSvg")!;
    const nameInput = overlay.querySelector<HTMLInputElement>("#pickerName")!;
    const tabsEl = overlay.querySelector<HTMLElement>("#pickerTabs")!;
    const optionsEl = overlay.querySelector<HTMLElement>("#pickerOptions")!;
    const submitBtn = overlay.querySelector<HTMLButtonElement>("#pickerSubmit")!;
    const randomBtn = overlay.querySelector<HTMLButtonElement>("#pickerRandom")!;

    let activeTab: PartKey = "skin";

    function rerenderPreview(): void {
      svgEl.innerHTML = renderAvatar(avatar);
    }

    function rerenderOptions(): void {
      const def = PARTS[activeTab];
      const selected = getPart(avatar, activeTab);
      optionsEl.innerHTML = def.options
        .map((opt) => {
          const isOn = opt.id === selected;
          // For skin we render a colored swatch; everything else gets a tiny
          // preview avatar with only that slot changed so the user sees how
          // the choice will actually look on their face.
          const preview =
            activeTab === "skin"
              ? `<span class="picker-swatch picker-swatch--skin" style="background:#${SKIN_PREVIEW_HEX[opt.id] ?? "ddd"}"></span>`
              : `<span class="picker-swatch">${renderAvatar(
                  setPart(avatar, activeTab, opt.id),
                )}</span>`;
          return `<button type="button" class="picker-opt ${
            isOn ? "picker-opt--on" : ""
          }" data-id="${opt.id}">
            ${preview}
            <span class="picker-opt-label">${escapeHtml(opt.label)}</span>
          </button>`;
        })
        .join("");
      for (const btn of optionsEl.querySelectorAll<HTMLButtonElement>(
        ".picker-opt",
      )) {
        btn.addEventListener("click", () => {
          const id = Number(btn.dataset.id);
          if (Number.isNaN(id)) return;
          avatar = setPart(avatar, activeTab, id);
          rerenderPreview();
          rerenderOptions();
        });
      }
    }

    for (const tab of tabsEl.querySelectorAll<HTMLButtonElement>(".picker-tab")) {
      tab.addEventListener("click", () => {
        for (const t of tabsEl.querySelectorAll<HTMLButtonElement>(".picker-tab")) {
          t.classList.remove("picker-tab--on");
        }
        tab.classList.add("picker-tab--on");
        activeTab = tab.dataset.part as PartKey;
        rerenderOptions();
      });
    }

    randomBtn.addEventListener("click", () => {
      avatar = randomAvatar();
      rerenderPreview();
      rerenderOptions();
    });

    submitBtn.addEventListener("click", () => {
      const name = nameInput.value.trim().slice(0, 32) || "anon";
      window.localStorage.setItem(STORAGE_NAME, name);
      saveAvatar(avatar);
      overlay.remove();
      resolve({ name, avatar });
    });
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submitBtn.click();
      }
    });

    rerenderPreview();
    rerenderOptions();
    nameInput.focus();
  });
}

// Mirror of the skin palette used inside avatar.ts. Duplicated here only so
// the swatch chip can render without spinning up a full SVG per option.
const SKIN_PREVIEW_HEX = [
  "f8ede3",
  "f2d1c9",
  "d9a07b",
  "b89b72",
  "8b6b4f",
  "6b4a3a",
  "3b2a24",
];
