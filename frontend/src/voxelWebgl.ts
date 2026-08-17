import * as THREE from "three";

export type VoxelWebglOptions = {
  onVoxel?: (voxel: { x: number; z: number; color: number; remove: boolean }) => void;
  onCellClick?: (cell: { x: number; z: number }) => boolean;
};

export type VoxelWebglController = {
  applyVoxel: (voxel: { x: number; y: number; z: number; color: number; remove: boolean }) => void;
  setGridSize: (size: number) => void;
};

const COLORS = ["#ef4444", "#f97316", "#facc15", "#84cc16", "#14b8a6", "#38bdf8", "#6366f1", "#ec4899", "#a16207", "#f5f5f4"];

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
  let grid = new THREE.GridHelper(20, 20, darkTheme ? "#46505d" : "#cbd3dc", darkTheme ? "#2b323d" : "#e6ebf0");
  grid.position.set(.5, 0, .5);
  scene.add(grid);
  const cubes = new Map<string, THREE.Mesh>();
  let selectedColor = 0;
  const ghost = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: COLORS[selectedColor], transparent: true, opacity: .32, depthWrite: false, depthTest: false }),
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
    const base = new THREE.Color(COLORS[color % COLORS.length]);
    const type = color === 1 ? 1 : color === 4 ? 2 : color === 8 ? 3 : color === 5 ? 4 : color === 2 ? 5 : 0;
    return new THREE.MeshPhysicalMaterial({
      color: base,
      roughness: type === 2 ? .16 : type === 4 ? .08 : type === 3 ? .72 : .48,
      metalness: type === 5 ? .18 : 0,
      transmission: type === 4 ? .72 : type === 2 ? .12 : 0,
      opacity: type === 4 ? .7 : type === 2 ? .9 : 1,
      transparent: type === 2 || type === 4,
      clearcoat: type === 4 ? .5 : 0,
      emissive: type === 1 || type === 5 ? base : new THREE.Color("#000000"),
      emissiveIntensity: type === 1 ? .35 : type === 5 ? .5 : 0,
    });
  };
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const add = (x: number, y: number, z: number, color: number): void => {
    const id = key(x, y, z);
    if (cubes.has(id)) return;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material(color));
    mesh.position.set(x, y + .5, z);
    mesh.userData = { x, y, z };
    scene.add(mesh); cubes.set(id, mesh);
  };
  const remove = (x: number, y: number, z: number): void => {
    const mesh = cubes.get(key(x, y, z));
    if (!mesh) return;
    scene.remove(mesh); mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); cubes.delete(key(x, y, z));
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
  const render = (): void => { clock.getElapsedTime(); renderer.render(scene, camera); };
  const loop = (): void => { render(); requestAnimationFrame(loop); };
  const controller: VoxelWebglController = {
    applyVoxel: (v) => { if (v.remove) remove(v.x, v.y, v.z); else add(v.x, v.y, v.z, v.color); },
    setGridSize: (size) => {
      gridSize = Math.max(12, Math.min(40, size));
      scene.remove(grid);
      grid.geometry.dispose();
      if (Array.isArray(grid.material)) grid.material.forEach((material) => material.dispose());
      else grid.material.dispose();
      grid = new THREE.GridHelper(gridSize, gridSize, darkTheme ? "#46505d" : "#cbd3dc", darkTheme ? "#2b323d" : "#e6ebf0");
      grid.position.set(.5, 0, .5);
      scene.add(grid);
      render();
    },
  };
  canvas.addEventListener("pointerdown", (e) => { pointerDown = true; dragging = false; lastX = e.clientX; lastY = e.clientY; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener("pointermove", (e) => { const cell = point(e); if (pointerDown && Math.hypot(e.clientX-lastX, e.clientY-lastY) > 3) dragging = true; if (pointerDown && dragging) { ghost.visible = false; yaw += (e.clientX-lastX)*.01; pitch = Math.max(.15, Math.min(1.35, pitch+(e.clientY-lastY)*.008)); orbit(); lastX=e.clientX; lastY=e.clientY; } else updateGhost(cell); });
  canvas.addEventListener("pointerup", (e) => { pointerDown = false; if (!dragging) { const cell=point(e); if (cell && !options.onCellClick?.(cell)) { const y=[...cubes.values()].filter(m=>m.userData.x===cell.x&&m.userData.z===cell.z).length; add(cell.x,y,cell.z,selectedColor); options.onVoxel?.({x:cell.x,z:cell.z,color:selectedColor,remove:false}); } } dragging = false; });
  canvas.addEventListener("pointerleave", () => { if (!pointerDown) ghost.visible = false; });
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); distance=Math.max(8,Math.min(50,distance+e.deltaY*.02)); orbit(); }, { passive:false });
  document.querySelectorAll<HTMLButtonElement>("[data-voxel-color]").forEach((b) => b.addEventListener("click", () => { selectedColor=Number(b.dataset.voxelColor); document.querySelectorAll("[data-voxel-color]").forEach((item) => item.classList.remove("is-active")); b.classList.add("is-active"); (ghost.material as THREE.MeshBasicMaterial).color.set(COLORS[selectedColor]); }));
  new ResizeObserver(resize).observe(canvas); resize(); orbit(); loop();
  return controller;
}
