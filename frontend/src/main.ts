import { showLanding } from "./landing";
import { DEFAULT_AVATAR, type ServerMsg } from "./proto";
import { serverWebSocketUrl } from "./server";
import { showToast } from "./toast";
import { getMicState, identityToName, isRemoteMutedByName, onActiveSpeakers, onMicState, toggleMic, toggleRemoteMute } from "./voice";
import { mountVoxelWebgl, type LandscapeKind, type VoxelWebglController } from "./voxelWebgl";
import { Conn, type ConnState } from "./ws";

type VoxelBlock = { x: number; y: number; z: number; color: number };
type VoxelPreset = "house" | "castle" | "trees";

const params = new URLSearchParams(location.search);
if (!params.has("room")) showLanding();
else bootVoxelRoom();

function presetBlocks(preset: VoxelPreset): VoxelBlock[] {
  const blocks: VoxelBlock[] = [];
  const block = (x: number, y: number, z: number, color: number): void => { blocks.push({ x, y, z, color }); };
  const box = (fromX: number, toX: number, fromY: number, toY: number, fromZ: number, toZ: number, color: number): void => {
    for (let x = fromX; x <= toX; x += 1) for (let y = fromY; y <= toY; y += 1) for (let z = fromZ; z <= toZ; z += 1) block(x, y, z, color);
  };

  if (preset === "house") {
    box(-2, 2, 0, 0, -2, 2, 13);
    for (let y = 1; y <= 3; y += 1) {
      for (let x = -2; x <= 2; x += 1) for (let z = -2; z <= 2; z += 1) {
        if (Math.abs(x) === 2 || Math.abs(z) === 2) block(x, y, z, 9);
      }
    }
    box(-1, 1, 4, 4, -2, 2, 0);
    box(0, 0, 5, 5, -1, 1, 0);
    block(0, 1, -2, 13);
    block(0, 2, -2, 13);
    block(-2, 2, 0, 12);
    block(2, 2, 0, 12);
    return blocks;
  }

  if (preset === "castle") {
    box(-3, 3, 0, 0, -3, 3, 11);
    for (let y = 1; y <= 3; y += 1) {
      for (let x = -3; x <= 3; x += 1) for (let z = -3; z <= 3; z += 1) {
        if (Math.abs(x) === 3 || Math.abs(z) === 3) block(x, y, z, 11);
      }
    }
    for (const [x, z] of [[-3, -3], [-3, 3], [3, -3], [3, 3]]) {
      box(x - 1, x + 1, 4, 5, z - 1, z + 1, 11);
      block(x, 6, z, 0);
    }
    block(0, 1, -3, 13);
    block(0, 2, -3, 13);
    return blocks;
  }

  for (const [x, z] of [[-3, -1], [2, 1], [0, 3]]) {
    box(x, x, 0, 3, z, z, 13);
    for (let y = 3; y <= 5; y += 1) {
      const radius = y === 5 ? 0 : 1;
      box(x - radius, x + radius, y, y, z - radius, z + radius, 10);
    }
  }
  return blocks;
}

function bootVoxelRoom(): void {
  document.body.classList.add("voxel-room-body");
  const room = params.get("room") ?? "";
  const solo = params.get("solo") === "1";
  let name = params.get("name")?.trim() ?? "";
  let conn: Conn | null = null;
  let canvas: VoxelWebglController | null = null;
  let connected = solo;
  let you: number | null = null;
  let host: number | null = null;
  let micState = getMicState();
  let speakers = new Set<string>();
  const players = new Map<number, string>();
  const materialColors: Record<string, number> = { grass: 10, stone: 11, glass: 12, wood: 13, water: 14, lava: 15, fire: 16 };

  document.body.innerHTML = `<main class="voxel-room${solo ? " voxel-room--solo" : ""}">
    <header class="voxel-room-head"><div></div><a class="voxi-wordmark-link" href="/" aria-label="Home"><div class="voxi-wordmark">VOXI</div></a>${solo ? "" : `<button class="voxel-room-code" id="copyCode" type="button">${escapeHtml(room)} <i class="ph ph-copy"></i></button>`}</header>
    <section class="voxel-room-canvas-shell${name || solo ? "" : " is-locked"}">
      <div class="voxel-canvas-tools"><div class="voxel-color-strip">${["#ef4444", "#f97316", "#facc15", "#84cc16", "#14b8a6", "#38bdf8", "#6366f1", "#ec4899"].map((color, index) => `<button class="voxel-color${index === 0 ? " is-active" : ""}" data-color="${index}" style="--voxel-color:${color}"></button>`).join("")}</div><label class="voxel-select-group">MATERIAL<select id="material">${Object.keys(materialColors).map((item) => `<option value="${item}">${item.toUpperCase()}</option>`).join("")}</select></label><label class="voxel-select-group">LAND<select id="land"><option value="grass">GRASS</option><option value="mud">MUD</option><option value="sand">SAND</option><option value="snow">SNOW</option><option value="water">WATER</option></select></label><label class="voxel-select-group">GRID<select id="grid"><option value="12">SMALL</option><option value="20" selected>MEDIUM</option><option value="32">LARGE</option><option value="40">XL</option></select></label><label class="voxel-template-select-group">PRESET<select id="preset"><option value="">CHOOSE</option><option value="house">HOUSE</option><option value="castle">CASTLE</option><option value="trees">TREES</option></select></label></div>
      <div class="voxel-name-gate" id="nameGate"${name || solo ? " hidden" : ""}><form id="nameForm" class="voxel-name-card"><h1>Join this room</h1><p>Choose the name other builders will see.</p><input id="nameInput" maxlength="24" required placeholder="Your name"/><button>Enter canvas</button></form></div><canvas id="voxelRoomCanvas" aria-label="Shared voxel canvas"></canvas>
    </section><aside class="voxel-chat-panel"><div class="voxel-chat-head"><div class="voxel-chat-summary"><strong>Room chat</strong><span id="count">0 builders online</span><span id="names"></span></div><span class="voxel-online-dot"></span></div><div class="voxel-chat-messages" id="messages"></div><form class="voxel-chat-form" id="chatForm"><input id="chatInput" maxlength="180" placeholder="Say something..."/><button>Send</button></form></aside></main>`;

  const element = document.getElementById("voxelRoomCanvas") as HTMLCanvasElement;
  const messages = document.getElementById("messages")!;
  const input = document.getElementById("chatInput") as HTMLInputElement;
  const grid = document.getElementById("grid") as HTMLSelectElement;
  const mount = (): void => { if (!canvas) canvas = mountVoxelWebgl(element, { onVoxel: sendVoxel }); };
  const enter = (next: string): void => { name = next.trim(); if (!name) return; params.set("name", name); history.replaceState({}, "", `${location.pathname}?${params}`); document.getElementById("nameGate")?.setAttribute("hidden", ""); document.querySelector(".voxel-room-canvas-shell")?.classList.remove("is-locked"); mount(); if (!solo) connect(); };
  if (solo || name) { mount(); if (!solo) connect(); }
  document.getElementById("nameForm")?.addEventListener("submit", (event) => { event.preventDefault(); enter((document.getElementById("nameInput") as HTMLInputElement).value); });
  document.getElementById("copyCode")?.addEventListener("click", () => void navigator.clipboard.writeText(room));
  document.querySelectorAll<HTMLButtonElement>("[data-color]").forEach((button) => button.addEventListener("click", () => { document.querySelectorAll("[data-color]").forEach((item) => item.classList.remove("is-active")); button.classList.add("is-active"); canvas?.setSelectedColor(Number(button.dataset.color)); }));
  document.getElementById("material")?.addEventListener("change", (event) => canvas?.setSelectedColor(materialColors[(event.target as HTMLSelectElement).value]));
  document.getElementById("land")?.addEventListener("change", (event) => canvas?.setLandscape((event.target as HTMLSelectElement).value as LandscapeKind));
  document.getElementById("preset")?.addEventListener("change", (event) => {
    const preset = (event.target as HTMLSelectElement).value as VoxelPreset | "";
    if (!preset) return;
    const blocks = presetBlocks(preset);
    let placed = 0;
    for (const block of blocks) {
      if (sendVoxel({ ...block, remove: false })) {
        canvas?.applyVoxel({ ...block, remove: false });
        placed += 1;
      }
    }
    (event.target as HTMLSelectElement).value = "";
    if (placed) showToast(`${preset[0].toUpperCase()}${preset.slice(1)} preset placed.`);
  });
  grid.addEventListener("change", () => { if (!solo && (!connected || you !== host)) { grid.value = String(grid.dataset.current ?? 20); showToast("Only the host can change the grid."); return; } const size = Number(grid.value); setGrid(size); if (!solo) conn?.send({ kind: "GridSize", size }); });
  document.getElementById("chatForm")?.addEventListener("submit", (event) => { event.preventDefault(); const text = input.value.trim(); if (!text || !connected) return; input.value = ""; conn?.send({ kind: "Chat", text }); });
  onMicState((state) => { micState = state; renderPlayers(); });
  onActiveSpeakers((ids) => { speakers = new Set([...ids].map(identityToName)); renderPlayers(); });

  function connect(): void { if (conn) return; const token = localStorage.getItem("voxi.client_token") ?? crypto.randomUUID(); localStorage.setItem("voxi.client_token", token); conn = new Conn({ url: serverWebSocketUrl(`/ws/${room}`), hello: () => ({ kind: "Hello", hello: { room, name, resume_from: null, client_token: token, avatar: DEFAULT_AVATAR } }), onMessage: handleMessage, onState: handleState }); }
  function handleMessage(message: ServerMsg): void {
    if (message.kind === "Welcome") { you = message.you; host = message.snapshot.game.host; connected = true; players.clear(); message.snapshot.players.forEach((player) => players.set(player.id, player.name)); canvas?.replaceWorkspace(message.snapshot.voxels); messages.innerHTML = ""; message.snapshot.chat.forEach((line) => appendChat(players.get(line.player) ?? "Builder", line.text)); setGrid(message.snapshot.grid_size ?? 20); renderPlayers(); return; }
    if (message.kind === "Presence") { message.joined.forEach((player) => players.set(player.id, player.name)); message.left.forEach((id) => players.delete(id)); renderPlayers(); return; }
    if (message.kind === "Chat") { appendChat(players.get(message.player) ?? "Builder", message.text); return; }
    if (message.kind === "Voxel") { canvas?.applyVoxel(message); return; }
    if (message.kind === "GridSize") { setGrid(message.size); return; }
    if (message.kind === "Game" && message.event.kind === "HostChanged") { host = message.event.new_host; renderPlayers(); return; }
    if (message.kind === "Bye") { connected = false; setConnectionLabel("Room closed"); }
  }
  function handleState(state: ConnState): void { if (state.kind !== "open") { connected = false; setConnectionLabel(state.kind === "reconnecting" ? "Reconnecting..." : "Connecting..."); } }
  function sendVoxel(voxel: { x: number; y?: number; z: number; color: number; remove: boolean }): boolean { if (solo) return true; if (!connected) { showToast("Reconnecting to the room."); return false; } conn?.send({ kind: "Voxel", ...voxel }); return true; }
  function setGrid(size: number): void { canvas?.setGridSize(size); grid.value = String(size); grid.dataset.current = String(size); grid.disabled = !solo && you !== host; }
  function setConnectionLabel(label: string): void { document.querySelector(".voxel-room")?.classList.add("is-disconnected"); input.disabled = !solo; input.placeholder = label; }
  function appendChat(author: string, text: string): void { const item = document.createElement("div"); item.className = "voxel-chat-message"; item.innerHTML = `<strong>${escapeHtml(author)}</strong><span>${escapeHtml(text)}</span>`; messages.appendChild(item); messages.scrollTop = messages.scrollHeight; }
  function renderPlayers(): void { const list = [...players.entries()]; document.getElementById("count")!.textContent = `${list.length} builder${list.length === 1 ? "" : "s"} online`; const names = document.getElementById("names")!; names.innerHTML = list.map(([id, player]) => { const self = id === you; const muted = !self && isRemoteMutedByName(player); const live = self && micState === "live"; return `<span class="voxel-player-audio${speakers.has(player) ? " is-speaking" : ""}"><button class="voxel-player-mic${live ? " is-live" : muted ? " is-muted" : ""}" data-player="${id}"><i class="ph ${live ? "ph-microphone" : "ph-microphone-slash"}"></i></button><span class="voxel-player-name">${escapeHtml(player)}${self ? " (you)" : ""}</span></span>`; }).join(""); names.querySelectorAll<HTMLButtonElement>("[data-player]").forEach((button) => button.addEventListener("click", async () => { const id = Number(button.dataset.player); const player = players.get(id); if (!player) return; if (id !== you) { toggleRemoteMute(player); renderPlayers(); return; } try { await toggleMic(room, name); } catch { showToast("Microphone access failed."); } })); }
}

function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character] ?? character)); }
