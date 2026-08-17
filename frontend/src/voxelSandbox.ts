type Point = { x: number; y: number };
type Face = { points: Point[]; fill: string; depth: number };

export type VoxelSandboxOptions = {
  onVoxel?: (voxel: { x: number; z: number; color: number; remove: boolean }) => void;
  onCellClick?: (cell: { x: number; z: number }) => boolean;
};

export type VoxelSandboxController = {
  applyVoxel: (voxel: { x: number; y: number; z: number; color: number; remove: boolean }) => void;
  setGridSize: (next: number) => void;
};

const COLORS = [
  "#ef4444", "#f97316", "#facc15", "#84cc16", "#14b8a6",
  "#38bdf8", "#6366f1", "#ec4899", "#a16207", "#f5f5f4",
];

export function mountVoxelSandbox(canvas: HTMLCanvasElement, options: VoxelSandboxOptions = {}): VoxelSandboxController {
  const context = canvas.getContext("2d");
  if (!context) return { applyVoxel: () => undefined, setGridSize: () => undefined };
  const ctx: CanvasRenderingContext2D = context;

  let size = 20;
  const cameraDistance = 34;
  const stacks = new Map<string, string[]>();
  let yaw = -Math.PI / 4;
  let pitch = .48;
  let scale = 30;
  let color = 5;
  let width = 0;
  let height = 0;
  let dragStart: Point | null = null;
  let lastPointer: Point | null = null;
  let dragged = false;
  let hoverCell: { x: number; z: number } | null = null;

  const key = (x: number, z: number) => `${x},${z}`;
  function project(x: number, y: number, z: number): Point {
    const rx = x * Math.cos(yaw) - z * Math.sin(yaw);
    const rz = x * Math.sin(yaw) + z * Math.cos(yaw);
    const cameraDepth = rz * Math.cos(pitch) + y * Math.sin(pitch);
    const perspective = scale * cameraDistance / Math.max(8, cameraDistance - cameraDepth);
    return {
      x: width / 2 + rx * perspective,
      y: height * 0.56 + (rz * Math.sin(pitch) - y * Math.cos(pitch)) * perspective,
    };
  }

  function polygon(points: Point[], fill: string, stroke = "rgba(0,0,0,.22)"): void {
    ctx.beginPath();
    points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function shade(hex: string, amount: number): string {
    const n = Number.parseInt(hex.slice(1), 16);
    const channel = (shift: number) => Math.max(0, Math.min(255, ((n >> shift) & 255) + amount));
    return `rgb(${channel(16)}, ${channel(8)}, ${channel(0)})`;
  }

  function cubeFaces(x: number, y: number, z: number, fill: string): Face[] {
    const vertices = [
      [x - .5, y, z - .5], [x + .5, y, z - .5],
      [x + .5, y, z + .5], [x - .5, y, z + .5],
      [x - .5, y + 1, z - .5], [x + .5, y + 1, z - .5],
      [x + .5, y + 1, z + .5], [x - .5, y + 1, z + .5],
    ] as const;
    const make = (indices: number[], faceFill: string): Face => {
      const corners = indices.map((index) => vertices[index]);
      return {
        points: corners.map(([vx, vy, vz]) => project(vx, vy, vz)),
        fill: faceFill,
        depth: corners.reduce((sum, [vx, vy, vz]) =>
          sum + (vx * Math.sin(yaw) + vz * Math.cos(yaw)) * Math.cos(pitch)
            + vy * Math.sin(pitch), 0) / corners.length,
      };
    };
    const zSide = Math.cos(yaw) >= 0
      ? make([2, 3, 7, 6], shade(fill, -42))
      : make([0, 1, 5, 4], shade(fill, -42));
    const xSide = Math.sin(yaw) >= 0
      ? make([1, 2, 6, 5], shade(fill, -28))
      : make([3, 0, 4, 7], shade(fill, -28));
    return [zSide, xSide, make([4, 5, 6, 7], shade(fill, 18))];
  }

  function render(): void {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#f7f3df";
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = "rgba(0,0,0,.19)";
    ctx.lineWidth = 1;
    for (let i = -size / 2; i <= size / 2; i++) {
      const a = project(i, 0, -size / 2);
      const b = project(i, 0, size / 2);
      const c = project(-size / 2, 0, i);
      const d = project(size / 2, 0, i);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.stroke();
    }

    const cells = [...stacks.entries()].map(([position, colors]) => {
      const [x, z] = position.split(",").map(Number);
      const depth = (x * Math.sin(yaw) + z * Math.cos(yaw)) * Math.cos(pitch);
      return { x, z, colors, depth };
    }).sort((a, b) => a.depth - b.depth);
    for (const cell of cells) {
      cell.colors.forEach((fill, y) => {
        // Keep each voxel atomic: sides are painted first and its top closes
        // the shape last, preventing face sorting from making it look hollow.
        for (const face of cubeFaces(cell.x + .5, y, cell.z + .5, fill)) {
          polygon(face.points, face.fill);
        }
      });
    }

    if (hoverCell) {
      const stackHeight = stacks.get(key(hoverCell.x, hoverCell.z))?.length ?? 0;
      const preview = cubeFaces(hoverCell.x + .5, stackHeight, hoverCell.z + .5, COLORS[color]);
      ctx.save();
      ctx.globalAlpha = .34;
      for (const face of preview) polygon(face.points, face.fill, "rgba(0,0,0,.5)");
      ctx.restore();
    }
  }

  function applyVoxel(voxel: { x: number; y: number; z: number; color: number; remove: boolean }): void {
    const stack = stacks.get(key(voxel.x, voxel.z)) ?? [];
    if (voxel.remove) stack.splice(Math.max(0, voxel.y), 1);
    else stack[voxel.y] = COLORS[voxel.color % COLORS.length];
    if (stack.length) stacks.set(key(voxel.x, voxel.z), stack); else stacks.delete(key(voxel.x, voxel.z));
    render();
  }

  function resize(): void {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = rect.width;
    height = rect.height;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    scale = Math.max(18, Math.min(34, width / 34));
    render();
  }

  function pickCell(p: Point): { x: number; z: number } | null {
    const u = (p.x - width / 2) / (scale * cameraDistance);
    const v = (p.y - height * .56) / (scale * cameraDistance);
    const divisor = Math.sin(pitch) + v * Math.cos(pitch);
    if (Math.abs(divisor) < .001) return null;
    const rz = v * cameraDistance / divisor;
    const rx = u * (cameraDistance - rz * Math.cos(pitch));
    const x = rx * Math.cos(yaw) + rz * Math.sin(yaw);
    const z = -rx * Math.sin(yaw) + rz * Math.cos(yaw);
    const cell = { x: Math.floor(x), z: Math.floor(z) };
    return cell.x >= -size / 2 && cell.x < size / 2 && cell.z >= -size / 2 && cell.z < size / 2
      ? cell
      : null;
  }

  canvas.addEventListener("pointerdown", (event) => {
    dragStart = { x: event.clientX, y: event.clientY };
    lastPointer = dragStart;
    dragged = false;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    const rect = canvas.getBoundingClientRect();
    if (!lastPointer) {
      hoverCell = pickCell({ x: event.clientX - rect.left, y: event.clientY - rect.top });
      render();
      return;
    }
    const dx = event.clientX - lastPointer.x;
    const dy = event.clientY - lastPointer.y;
    const totalDx = event.clientX - (dragStart?.x ?? 0);
    const totalDy = event.clientY - (dragStart?.y ?? 0);
    if (Math.hypot(totalDx, totalDy) > 4) dragged = true;
    if (dragged) {
      hoverCell = null;
      yaw += dx * .009;
      pitch = Math.max(.18, Math.min(1.24, pitch + dy * .007));
      render();
    }
    lastPointer = { x: event.clientX, y: event.clientY };
  });
  canvas.addEventListener("pointerup", (event) => {
    if (!dragged) {
      const rect = canvas.getBoundingClientRect();
      const cell = pickCell({ x: event.clientX - rect.left, y: event.clientY - rect.top });
      if (cell) {
        if (options.onCellClick?.(cell)) {
          dragStart = null;
          lastPointer = null;
          hoverCell = null;
          render();
          return;
        }
        const stack = stacks.get(key(cell.x, cell.z)) ?? [];
        const remove = event.shiftKey;
        if (remove) stack.pop(); else if (stack.length < 10) stack.push(COLORS[color]);
        if (stack.length) stacks.set(key(cell.x, cell.z), stack); else stacks.delete(key(cell.x, cell.z));
        render();
        options.onVoxel?.({ x: cell.x, z: cell.z, color, remove });
      }
    }
    dragStart = null;
    lastPointer = null;
    const rect = canvas.getBoundingClientRect();
    hoverCell = pickCell({ x: event.clientX - rect.left, y: event.clientY - rect.top });
    render();
  });
  canvas.addEventListener("pointerleave", () => {
    hoverCell = null;
    dragStart = null;
    lastPointer = null;
    render();
  });
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    scale = Math.max(16, Math.min(48, scale - event.deltaY * .025));
    render();
  }, { passive: false });
  canvas.addEventListener("dblclick", () => {
    yaw = -Math.PI / 4;
    pitch = .48;
    render();
  });
  function selectColor(next: number): void {
    color = next;
    document.querySelectorAll<HTMLElement>("[data-voxel-color]").forEach((button) => {
      button.classList.toggle("is-active", Number(button.dataset.voxelColor) === color);
    });
  }
  document.querySelectorAll<HTMLButtonElement>("[data-voxel-color]").forEach((button) => {
    button.addEventListener("click", () => selectColor(Number(button.dataset.voxelColor)));
  });
  window.addEventListener("keydown", (event) => {
    if (/^[0-9]$/.test(event.key)) selectColor(Number(event.key));
  });
  selectColor(color);
  new ResizeObserver(resize).observe(canvas);
  resize();
  return {
    applyVoxel,
    setGridSize: (next: number) => {
      size = Math.max(12, Math.min(40, next));
      render();
    },
  };
}
