import * as THREE from "three";

export type VoxelWebglOptions = {
  onVoxel?: (voxel: { x: number; z: number; color: number; remove: boolean }) => void;
  onCellClick?: (cell: { x: number; z: number }) => boolean;
};

export type VoxelWebglController = {
  applyVoxel: (voxel: { x: number; y: number; z: number; color: number; remove: boolean }) => void;
  setSelectedColor: (color: number) => void;
  setGridSize: (size: number) => void;
};

const COLORS = ["#ef4444", "#f97316", "#facc15", "#84cc16", "#14b8a6", "#38bdf8", "#6366f1", "#ec4899", "#a16207", "#f5f5f4"];
const MATERIAL_PREVIEWS: Record<number, string> = {
  10: "#4d9d32",
  11: "#8d9297",
  12: "#9eeaf6",
  13: "#8b5528",
  14: "#2db7e8",
  15: "#ff5a18",
  16: "#ffcf33",
};
const GRID_COLORS = {
  light: { major: "#aeb9c6", minor: "#d7dee7" },
  dark: { major: "#5c6674", minor: "#343d49" },
};

type MaterialKind = "solid" | "grass" | "stone" | "glass" | "wood" | "water" | "lava" | "fire";

const materialKind = (color: number): MaterialKind => {
  if (color === 10) return "grass";
  if (color === 11) return "stone";
  if (color === 12) return "glass";
  if (color === 13) return "wood";
  if (color === 14) return "water";
  if (color === 15) return "lava";
  if (color === 16) return "fire";
  return "solid";
};

const previewColor = (color: number): string => MATERIAL_PREVIEWS[color] ?? COLORS[color % COLORS.length];

const makeTexture = (kind: MaterialKind): THREE.CanvasTexture | null => {
  if (kind === "solid" || kind === "glass") return null;
  const size = 96;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const fill = (color: string): void => {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, size, size);
  };
  const noise = (alpha: number, colors: string[]): void => {
    for (let i = 0; i < 420; i++) {
      ctx.globalAlpha = alpha * (.45 + Math.random() * .8);
      ctx.fillStyle = colors[Math.floor(Math.random() * colors.length)];
      const s = 1 + Math.random() * 5;
      ctx.fillRect(Math.random() * size, Math.random() * size, s, s);
    }
    ctx.globalAlpha = 1;
  };

  if (kind === "grass") {
    fill("#4f9f38");
    noise(.42, ["#2f7d2d", "#75bf48", "#1f5f27", "#a4d96d"]);
    for (let i = 0; i < 26; i++) {
      ctx.strokeStyle = i % 2 ? "#2e7d31" : "#8ccc55";
      ctx.lineWidth = 1 + Math.random() * 2;
      const x = Math.random() * size;
      ctx.beginPath();
      ctx.moveTo(x, size);
      ctx.lineTo(x + (Math.random() * 14 - 7), Math.random() * size);
      ctx.stroke();
    }
  } else if (kind === "stone") {
    fill("#8f969c");
    noise(.5, ["#6f767d", "#b6bcc1", "#555c63", "#9fa6ac"]);
    ctx.strokeStyle = "rgba(52,58,64,.42)";
    for (let i = 0; i < 9; i++) {
      ctx.beginPath();
      ctx.moveTo(Math.random() * size, Math.random() * size);
      for (let j = 0; j < 4; j++) ctx.lineTo(Math.random() * size, Math.random() * size);
      ctx.stroke();
    }
  } else if (kind === "wood") {
    fill("#8c552c");
    for (let y = 0; y < size; y += 6) {
      ctx.fillStyle = y % 12 ? "#73401e" : "#a76a35";
      ctx.fillRect(0, y + Math.sin(y * .35) * 2, size, 3);
    }
    noise(.2, ["#532b16", "#c08445"]);
    ctx.strokeStyle = "rgba(55,28,12,.45)";
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.ellipse(22 + i * 16, 24 + (i % 2) * 28, 8, 4, Math.random(), 0, Math.PI * 2);
      ctx.stroke();
    }
  } else if (kind === "water") {
    const gradient = ctx.createLinearGradient(0, 0, size, size);
    gradient.addColorStop(0, "#67dcff");
    gradient.addColorStop(1, "#127fc2");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = "rgba(255,255,255,.42)";
    for (let i = 0; i < 12; i++) {
      ctx.beginPath();
      const y = i * 8 + Math.random() * 4;
      ctx.moveTo(0, y);
      for (let x = 0; x <= size; x += 12) ctx.lineTo(x, y + Math.sin(x * .18 + i) * 4);
      ctx.stroke();
    }
  } else if (kind === "lava" || kind === "fire") {
    const gradient = ctx.createRadialGradient(size * .45, size * .45, 4, size * .5, size * .5, size * .8);
    gradient.addColorStop(0, kind === "fire" ? "#fff7a8" : "#ffd15a");
    gradient.addColorStop(.45, "#ff6a18");
    gradient.addColorStop(1, kind === "fire" ? "#901414" : "#3c1111");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    noise(.5, ["#fff176", "#ff8a1c", "#e11d1d", "#5f1717"]);
    ctx.strokeStyle = "rgba(255,238,130,.8)";
    for (let i = 0; i < 7; i++) {
      ctx.beginPath();
      ctx.moveTo(Math.random() * size, size);
      ctx.bezierCurveTo(Math.random() * size, size * .65, Math.random() * size, size * .35, Math.random() * size, 0);
      ctx.stroke();
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1, 1);
  texture.anisotropy = 4;
  return texture;
};

export function mountVoxelWebgl(canvas: HTMLCanvasElement, options: VoxelWebglOptions = {}): VoxelWebglController {
  const darkTheme = document.body.classList.contains("voxi-theme-dark");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(darkTheme ? "#111419" : "#ffffff");
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, .1, 200);
  camera.position.set(13, 15, 18);
  camera.lookAt(0, 0, 0);
  scene.add(new THREE.HemisphereLight(darkTheme ? "#d9e5ff" : "#fff8e7", darkTheme ? "#202733" : "#7b6b52", 3.2));
  const keyLight = new THREE.DirectionalLight("#ffffff", 2.4);
  keyLight.position.set(-8, 14, 10);
  scene.add(keyLight);
  // Grid lines sit on cell edges; integer cube positions then land in cell centers.
  const gridColors = darkTheme ? GRID_COLORS.dark : GRID_COLORS.light;
  const createGrid = (size: number): THREE.GridHelper => {
    const helper = new THREE.GridHelper(size, size, gridColors.major, gridColors.minor);
    const materials = Array.isArray(helper.material) ? helper.material : [helper.material];
    materials.forEach((gridMaterial) => {
      if (gridMaterial instanceof THREE.LineBasicMaterial) {
        gridMaterial.transparent = true;
        gridMaterial.opacity = darkTheme ? .9 : .96;
        gridMaterial.depthWrite = false;
      }
    });
    helper.position.set(.5, 0, .5);
    return helper;
  };
  let grid = createGrid(20);
  scene.add(grid);
  const cubes = new Map<string, THREE.Mesh>();
  let selectedColor = 0;
  const ghost = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: previewColor(selectedColor), transparent: true, opacity: .32, depthWrite: false, depthTest: false }),
  );
  ghost.position.set(0, .5, 0);
  ghost.renderOrder = 10;
  ghost.visible = true;
  scene.add(ghost);
  let gridSize = 20;
  let yaw = .62;
  let pitch = .62;
  let distance = 23;
  let dragging = false;
  let pointerDown = false;
  let lastX = 0;
  let lastY = 0;
  const clock = new THREE.Clock();

  const material = (color: number): THREE.MeshPhysicalMaterial => {
    const kind = materialKind(color);
    if (kind === "solid") {
      return new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(COLORS[color % COLORS.length]),
        roughness: .48,
        metalness: 0,
      });
    }
    const texture = makeTexture(kind);
    const mat = new THREE.MeshPhysicalMaterial({
      color: kind === "glass" ? "#b9f5ff" : "#ffffff",
      map: texture ?? undefined,
      bumpMap: texture ?? undefined,
      bumpScale: kind === "stone" ? .07 : kind === "wood" ? .045 : kind === "grass" ? .035 : .025,
      roughness: kind === "water" || kind === "glass" ? .08 : kind === "stone" ? .82 : kind === "wood" ? .62 : .48,
      metalness: 0,
      transmission: kind === "glass" ? .72 : kind === "water" ? .35 : 0,
      thickness: kind === "glass" || kind === "water" ? .55 : 0,
      opacity: kind === "glass" ? .48 : kind === "water" ? .74 : 1,
      transparent: kind === "glass" || kind === "water",
      clearcoat: kind === "glass" || kind === "water" ? .8 : .08,
      clearcoatRoughness: kind === "glass" ? .04 : .18,
      emissive: kind === "lava" || kind === "fire" ? new THREE.Color(kind === "fire" ? "#ffb020" : "#ff3d00") : new THREE.Color("#000000"),
      emissiveMap: kind === "lava" || kind === "fire" ? texture ?? undefined : undefined,
      emissiveIntensity: kind === "fire" ? 1.1 : kind === "lava" ? .75 : 0,
    });
    mat.userData = { kind };
    return mat;
  };
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const add = (x: number, y: number, z: number, color: number): void => {
    const id = key(x, y, z);
    if (cubes.has(id)) return;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material(color));
    mesh.position.set(x, y + .5, z);
    mesh.userData = { x, y, z, kind: materialKind(color) };
    scene.add(mesh); cubes.set(id, mesh);
  };
  const remove = (x: number, y: number, z: number): void => {
    const mesh = cubes.get(key(x, y, z));
    if (!mesh) return;
    const meshMaterial = mesh.material as THREE.MeshPhysicalMaterial;
    meshMaterial.map?.dispose();
    if (meshMaterial.bumpMap !== meshMaterial.map) meshMaterial.bumpMap?.dispose();
    if (meshMaterial.emissiveMap !== meshMaterial.map) meshMaterial.emissiveMap?.dispose();
    scene.remove(mesh); mesh.geometry.dispose(); meshMaterial.dispose(); cubes.delete(key(x, y, z));
  };
  const columnHeight = (x: number, z: number): number => [...cubes.values()].filter((m) => m.userData.x === x && m.userData.z === z).length;
  const updateGhost = (cell: { x: number; z: number } | null): void => {
    if (!cell) { ghost.visible = false; return; }
    const y = columnHeight(cell.x, cell.z);
    ghost.position.set(cell.x, y + .5, cell.z);
    ghost.visible = true;
  };
  const resize = (): void => { const r = canvas.getBoundingClientRect(); renderer.setSize(r.width, r.height, false); camera.aspect = r.width / Math.max(1, r.height); camera.updateProjectionMatrix(); };
  const orbit = (): void => { camera.position.set(Math.sin(yaw) * Math.cos(pitch) * distance, Math.sin(pitch) * distance, Math.cos(yaw) * Math.cos(pitch) * distance); camera.lookAt(0, 0, 0); };
  const ray = new THREE.Raycaster();
  const point = (event: PointerEvent): { x: number; z: number } | null => { const r = canvas.getBoundingClientRect(); const ndc = new THREE.Vector2((event.clientX-r.left)/r.width*2-1, -((event.clientY-r.top)/r.height)*2+1); ray.setFromCamera(ndc, camera); const hit = ray.intersectObject(grid)[0]; if (!hit) return null; const limit = Math.floor(gridSize / 2); return { x: Math.max(-limit, Math.min(limit - 1, Math.floor(hit.point.x + .5))), z: Math.max(-limit, Math.min(limit - 1, Math.floor(hit.point.z + .5))) }; };
  const selectColor = (color: number): void => {
    selectedColor = color;
    (ghost.material as THREE.MeshBasicMaterial).color.set(previewColor(selectedColor));
  };
  const render = (): void => {
    const time = clock.getElapsedTime();
    cubes.forEach((mesh) => {
      const kind = mesh.userData.kind as MaterialKind | undefined;
      const meshMaterial = mesh.material as THREE.MeshPhysicalMaterial;
      if (kind === "water") {
        meshMaterial.opacity = .68 + Math.sin(time * 2.2 + mesh.position.x) * .06;
        meshMaterial.clearcoatRoughness = .1 + Math.sin(time * 1.7 + mesh.position.z) * .04;
      } else if (kind === "lava" || kind === "fire") {
        meshMaterial.emissiveIntensity = (kind === "fire" ? 1.08 : .72) + Math.sin(time * 5.5 + mesh.position.x + mesh.position.z) * .18;
      }
    });
    renderer.render(scene, camera);
  };
  const loop = (): void => { render(); requestAnimationFrame(loop); };
  const controller: VoxelWebglController = {
    applyVoxel: (v) => { if (v.remove) remove(v.x, v.y, v.z); else add(v.x, v.y, v.z, v.color); },
    setSelectedColor: selectColor,
    setGridSize: (size) => {
      gridSize = Math.max(12, Math.min(40, size));
      scene.remove(grid);
      grid.geometry.dispose();
      if (Array.isArray(grid.material)) grid.material.forEach((material) => material.dispose());
      else grid.material.dispose();
      grid = createGrid(gridSize);
      scene.add(grid);
      render();
    },
  };
  canvas.addEventListener("pointerdown", (e) => { pointerDown = true; dragging = false; lastX = e.clientX; lastY = e.clientY; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener("pointermove", (e) => { const cell = point(e); if (pointerDown && Math.hypot(e.clientX-lastX, e.clientY-lastY) > 3) dragging = true; if (pointerDown && dragging) { ghost.visible = false; yaw += (e.clientX-lastX)*.01; pitch = Math.max(.15, Math.min(1.35, pitch+(e.clientY-lastY)*.008)); orbit(); lastX=e.clientX; lastY=e.clientY; } else updateGhost(cell); });
  canvas.addEventListener("pointerup", (e) => { pointerDown = false; if (!dragging) { const cell=point(e); if (cell && !options.onCellClick?.(cell)) { const y=[...cubes.values()].filter(m=>m.userData.x===cell.x&&m.userData.z===cell.z).length; add(cell.x,y,cell.z,selectedColor); options.onVoxel?.({x:cell.x,z:cell.z,color:selectedColor,remove:false}); } } dragging = false; });
  canvas.addEventListener("pointerleave", () => { if (!pointerDown) ghost.visible = false; });
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); distance=Math.max(8,Math.min(50,distance+e.deltaY*.02)); orbit(); }, { passive:false });
  document.querySelectorAll<HTMLButtonElement>("[data-voxel-color]").forEach((b) => b.addEventListener("click", () => { selectColor(Number(b.dataset.voxelColor)); document.querySelectorAll("[data-voxel-color]").forEach((item) => item.classList.remove("is-active")); b.classList.add("is-active"); }));
  new ResizeObserver(resize).observe(canvas); resize(); orbit(); loop();
  return controller;
}
