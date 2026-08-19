import * as THREE from "three";

export type VoxelWebglOptions = {
  onVoxel?: (voxel: { x: number; y?: number; z: number; color: number; remove: boolean }) => boolean | void;
  onCellClick?: (cell: { x: number; z: number }) => boolean;
};

export type VoxelWebglController = {
  applyVoxel: (voxel: { x: number; y: number; z: number; color: number; remove: boolean }) => void;
  replaceWorkspace: (voxels: Array<{ x: number; y: number; z: number; color: number }>) => void;
  clearWorkspace: () => Array<{ x: number; y: number; z: number; color: number }>;
  setSelectedColor: (color: number) => void;
  setGridSize: (size: number) => void;
  setLandscape: (landscape: LandscapeKind) => void;
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
export type LandscapeKind = "grass" | "mud" | "sand" | "snow" | "water";
type AnimatedVoxelData = { x: number; y: number; z: number; color: number; kind: MaterialKind; phase: number; light?: THREE.PointLight };
const LANDSCAPE_COLORS: Record<LandscapeKind, string> = {
  grass: "#78b941",
  mud: "#8b5b32",
  sand: "#f2d47a",
  snow: "#edf6f7",
  water: "#28aee4",
};

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

const makeTexture = (kind: MaterialKind | LandscapeKind): THREE.CanvasTexture | null => {
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
  const blockTiles = (base: string, colors: string[], alpha = .55): void => {
    fill(base);
    const unit = 12;
    for (let y = 0; y < size; y += unit) {
      for (let x = 0; x < size; x += unit) {
        if (Math.random() < .72) {
          ctx.globalAlpha = alpha * (.55 + Math.random() * .45);
          ctx.fillStyle = colors[Math.floor(Math.random() * colors.length)];
          ctx.fillRect(x, y, unit, unit);
        }
      }
    }
    ctx.globalAlpha = 1;
  };

  if (kind === "grass") {
    blockTiles("#4f9f38", ["#2f7d2d", "#75bf48", "#1f5f27", "#a4d96d"], .42);
  } else if (kind === "stone") {
    blockTiles("#8f969c", ["#6f767d", "#b6bcc1", "#555c63", "#9fa6ac"], .38);
  } else if (kind === "wood") {
    blockTiles("#8c552c", ["#673719", "#a76a35", "#74431f", "#bd7b3d"], .36);
    ctx.globalAlpha = .18;
    ctx.fillStyle = "#3d1d0e";
    for (let x = 0; x < size; x += 24) ctx.fillRect(x, 0, 12, size);
    ctx.globalAlpha = 1;
  } else if (kind === "water") {
    blockTiles("#1ca5dc", ["#67dcff", "#2db7e8", "#127fc2", "#9eeaf6"], .34);
    ctx.globalAlpha = .2;
    ctx.fillStyle = "#e8fbff";
    for (let i = 0; i < 7; i++) ctx.fillRect(Math.floor(Math.random() * 8) * 12, Math.floor(Math.random() * 8) * 12, 12, 12);
    ctx.globalAlpha = 1;
  } else if (kind === "mud") {
    blockTiles("#8b5b32", ["#6c4224", "#a87343", "#573019", "#9a6a3d"], .4);
  } else if (kind === "sand") {
    blockTiles("#e9c96b", ["#f7dd8d", "#dcb956", "#cfa44e", "#fff0a6"], .34);
  } else if (kind === "snow") {
    blockTiles("#ecf6f7", ["#ffffff", "#d6e8ea", "#bdd7dd", "#f7ffff"], .28);
  } else if (kind === "lava" || kind === "fire") {
    blockTiles(kind === "fire" ? "#ff8a1c" : "#b82816", ["#fff176", "#ff8a1c", "#e11d1d", "#5f1717"], kind === "fire" ? .5 : .44);
    ctx.globalAlpha = .26;
    ctx.fillStyle = "#fff7a8";
    for (let i = 0; i < 8; i++) ctx.fillRect(Math.floor(Math.random() * 8) * 12, Math.floor(Math.random() * 8) * 12, 12, 12);
    ctx.globalAlpha = 1;
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1, 1);
  if (kind === "water") texture.repeat.set(1.15, 1.15);
  if (kind === "lava" || kind === "fire") texture.repeat.set(1, 1);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.anisotropy = 4;
  return texture;
};

export function mountVoxelWebgl(canvas: HTMLCanvasElement, options: VoxelWebglOptions = {}): VoxelWebglController {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor("#ffffff");
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, .1, 200);
  camera.position.set(13, 15, 18);
  camera.lookAt(0, 0, 0);
  scene.add(new THREE.HemisphereLight("#fff8e7", "#7b6b52", 3.2));
  const keyLight = new THREE.DirectionalLight("#ffffff", 2.4);
  keyLight.position.set(-8, 14, 10);
  scene.add(keyLight);
  // Grid lines sit on cell edges; integer cube positions then land in cell centers.
  const createGrid = (size: number): THREE.GridHelper => {
    const gridColors = GRID_COLORS.light;
    const helper = new THREE.GridHelper(size, size, gridColors.major, gridColors.minor);
    const materials = Array.isArray(helper.material) ? helper.material : [helper.material];
    materials.forEach((gridMaterial) => {
      if (gridMaterial instanceof THREE.LineBasicMaterial) {
        gridMaterial.transparent = true;
        gridMaterial.opacity = .96;
        gridMaterial.depthWrite = false;
      }
    });
    helper.position.set(.5, 0, .5);
    return helper;
  };
  let grid = createGrid(20);
  scene.add(grid);
  let landscapeKind: LandscapeKind = "grass";
  const landscapeGeometry = new THREE.PlaneGeometry(20, 20);
  let landscapeMaterial = makeLandscapeMaterial(landscapeKind, 20);
  const landscape = new THREE.Mesh(landscapeGeometry, landscapeMaterial);
  landscape.rotation.x = -Math.PI / 2;
  landscape.position.set(.5, -.03, .5);
  landscape.receiveShadow = true;
  scene.add(landscape);
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

  function makeLandscapeMaterial(kind: LandscapeKind, size: number): THREE.MeshPhysicalMaterial {
    const texture = makeTexture(kind);
    if (texture) texture.repeat.set(size / 4, size / 4);
    return new THREE.MeshPhysicalMaterial({
      color: LANDSCAPE_COLORS[kind],
      map: texture ?? undefined,
      bumpMap: texture ?? undefined,
      bumpScale: kind === "water" ? .018 : .035,
      roughness: kind === "water" ? .12 : kind === "snow" ? .38 : .72,
      metalness: 0,
      transparent: kind === "water",
      opacity: kind === "water" ? .82 : 1,
      clearcoat: kind === "water" ? .72 : .04,
      clearcoatRoughness: kind === "water" ? .12 : .35,
    });
  }
  const updateLandscape = (kind = landscapeKind): void => {
    landscapeKind = kind;
    landscape.geometry.dispose();
    landscape.geometry = new THREE.PlaneGeometry(gridSize, gridSize);
    landscape.position.set(.5, -.03, .5);
    landscapeMaterial.map?.dispose();
    if (landscapeMaterial.bumpMap !== landscapeMaterial.map) landscapeMaterial.bumpMap?.dispose();
    landscapeMaterial.dispose();
    landscapeMaterial = makeLandscapeMaterial(kind, gridSize);
    landscape.material = landscapeMaterial;
    renderer.setClearColor(kind === "water" ? "#e7fbff" : kind === "snow" ? "#f7fbfb" : "#ffffff");
  };
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
    if (texture) {
      texture.offset.set(Math.random(), Math.random());
      texture.rotation = kind === "water" ? Math.random() * .25 : 0;
      texture.center.set(.5, .5);
    }
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
    const kind = materialKind(color);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material(color));
    mesh.position.set(x, y + .5, z);
    mesh.userData = { x, y, z, color, kind, phase: Math.random() * Math.PI * 2 } satisfies AnimatedVoxelData;
    if (kind === "lava" || kind === "fire") {
      const glow = new THREE.PointLight(kind === "fire" ? "#ffcf46" : "#ff4b1f", kind === "fire" ? .75 : .55, 4);
      glow.position.set(0, .2, 0);
      mesh.add(glow);
      (mesh.userData as AnimatedVoxelData).light = glow;
    }
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
  const requestVoxel = (voxel: { x: number; y: number; z: number; color: number; remove: boolean }): boolean => (
    options.onVoxel?.(voxel) !== false
  );
  const render = (): void => {
    const time = clock.getElapsedTime();
    cubes.forEach((mesh) => {
      const data = mesh.userData as AnimatedVoxelData;
      const kind = data.kind;
      const meshMaterial = mesh.material as THREE.MeshPhysicalMaterial;
      const texture = meshMaterial.map;
      if (kind === "water") {
        if (texture) {
          texture.offset.x = (time * .055 + data.phase * .03) % 1;
          texture.offset.y = (time * .022 + Math.sin(time * .82 + data.phase) * .025 + data.phase * .025) % 1;
          texture.rotation = Math.sin(time * .62 + data.phase) * .075;
        }
        mesh.position.y = data.y + .5 + Math.sin(time * 1.45 + data.phase) * .025;
        meshMaterial.opacity = .67 + Math.sin(time * 1.45 + data.phase) * .055;
        meshMaterial.clearcoatRoughness = .08 + Math.sin(time * 1.1 + data.phase) * .035;
      } else if (kind === "lava" || kind === "fire") {
        if (texture) {
          texture.offset.y = (time * (kind === "fire" ? .06 : .032) + data.phase * .04) % 1;
          texture.offset.x = Math.sin(time * .75 + data.phase) * .016;
        }
        const flicker = Math.sin(time * 2.8 + data.phase) * .07 + Math.sin(time * 5.2 + data.phase * 2) * .035;
        meshMaterial.emissiveIntensity = (kind === "fire" ? .98 : .72) + flicker;
        mesh.scale.setScalar(1 + Math.max(0, flicker) * (kind === "fire" ? .012 : .008));
        data.light && (data.light.intensity = (kind === "fire" ? .58 : .45) + Math.max(0, flicker) * .55);
      }
    });
    const groundTexture = landscapeMaterial.map;
    if (landscapeKind === "water" && groundTexture) {
      groundTexture.offset.x = (time * .028) % 1;
      groundTexture.offset.y = (time * .015) % 1;
      landscapeMaterial.opacity = .78 + Math.sin(time * 1.1) * .04;
      landscape.position.y = -.04 + Math.sin(time * .9) * .01;
    }
    renderer.render(scene, camera);
  };
  const loop = (): void => { render(); requestAnimationFrame(loop); };
  const controller: VoxelWebglController = {
    applyVoxel: (v) => { if (v.remove) remove(v.x, v.y, v.z); else add(v.x, v.y, v.z, v.color); },
    replaceWorkspace: (voxels) => {
      [...cubes.values()].forEach((mesh) => {
        const data = mesh.userData as AnimatedVoxelData;
        remove(data.x, data.y, data.z);
      });
      voxels.forEach((voxel) => add(voxel.x, voxel.y, voxel.z, voxel.color));
      ghost.visible = false;
      render();
    },
    clearWorkspace: () => {
      const blocks = [...cubes.values()].map((mesh) => {
        const data = mesh.userData as AnimatedVoxelData;
        return { x: data.x, y: data.y, z: data.z, color: data.color };
      });
      blocks.forEach((block) => remove(block.x, block.y, block.z));
      ghost.visible = false;
      return blocks;
    },
    setSelectedColor: selectColor,
    setGridSize: (size) => {
      gridSize = Math.max(12, Math.min(40, size));
      scene.remove(grid);
      grid.geometry.dispose();
      if (Array.isArray(grid.material)) grid.material.forEach((material) => material.dispose());
      else grid.material.dispose();
      grid = createGrid(gridSize);
      scene.add(grid);
      updateLandscape();
      render();
    },
    setLandscape: updateLandscape,
  };
  canvas.addEventListener("pointerdown", (e) => { pointerDown = true; dragging = false; lastX = e.clientX; lastY = e.clientY; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener("pointermove", (e) => { const cell = point(e); if (pointerDown && Math.hypot(e.clientX-lastX, e.clientY-lastY) > 3) dragging = true; if (pointerDown && dragging) { ghost.visible = false; yaw += (e.clientX-lastX)*.01; pitch = Math.max(.15, Math.min(1.35, pitch+(e.clientY-lastY)*.008)); orbit(); lastX=e.clientX; lastY=e.clientY; } else updateGhost(cell); });
  canvas.addEventListener("pointerup", (event) => {
    pointerDown = false;
    if (!dragging) {
      const cell = point(event);
      if (cell && !options.onCellClick?.(cell)) {
        const column = [...cubes.values()].filter((mesh) => mesh.userData.x === cell.x && mesh.userData.z === cell.z);
        if (event.shiftKey) {
          const top = column.reduce<AnimatedVoxelData | null>((best, mesh) => {
            const data = mesh.userData as AnimatedVoxelData;
            return !best || data.y > best.y ? data : best;
          }, null);
          if (top) {
            const voxel = { x: top.x, y: top.y, z: top.z, color: top.color, remove: true };
            if (requestVoxel(voxel)) remove(top.x, top.y, top.z);
          }
        } else {
          const voxel = { x: cell.x, y: column.length, z: cell.z, color: selectedColor, remove: false };
          if (requestVoxel(voxel)) add(voxel.x, voxel.y, voxel.z, voxel.color);
        }
      }
    }
    dragging = false;
  });
  canvas.addEventListener("pointerleave", () => { if (!pointerDown) ghost.visible = false; });
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); distance=Math.max(8,Math.min(50,distance+e.deltaY*.02)); orbit(); }, { passive:false });
  document.querySelectorAll<HTMLButtonElement>("[data-voxel-color]").forEach((b) => b.addEventListener("click", () => { selectColor(Number(b.dataset.voxelColor)); document.querySelectorAll("[data-voxel-color]").forEach((item) => item.classList.remove("is-active")); b.classList.add("is-active"); }));
  new ResizeObserver(resize).observe(canvas); resize(); orbit(); loop();
  return controller;
}
