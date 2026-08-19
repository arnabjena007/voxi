type Point = { x: number; y: number };

type FooterCube = {
  row: number;
  col: number;
  color: string;
  lift: number;
  targetLift: number;
  hitArea: Point[];
};

const COLOR_ROWS = [
  ["#f15b5d", "#df2f76", "#c74f6d", "#ff790d"],
  ["#f06a9e", "#e24f88", "#ff8a1a", "#c93b76"],
  ["#8f155f", "#6f1b78", "#b50f5a", "#7e245f"],
  ["#f15b5d", "#df2f76", "#c74f6d", "#ff790d"],
  ["#bd3d91", "#8d2187", "#aa177b", "#7250a2"],
  ["#24a5cb", "#087ba9", "#09528e", "#21418d"],
  ["#4db8b8", "#02a78d", "#3aaf80", "#0a8ea0"],
  ["#8fc714", "#bcd91e", "#72b728", "#46ab79"],
  ["#ffe70d", "#ffc20d", "#f38b00", "#d6db24"],
];

const TOP_PADDING = 14;
const PATTERN_HEIGHT_IN_TILE_WIDTHS = 4.5365;

export function mountLandingFooter(canvas: HTMLCanvasElement): () => void {
  const context = canvas.getContext("2d");
  if (!context) return () => undefined;

  const cubes: FooterCube[] = [];
  let columns = 0;
  let hovered: FooterCube | null = null;
  let animationFrame = 0;

  const rebuild = (): void => {
    const bounds = canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(bounds.width * ratio));
    canvas.height = Math.max(1, Math.round(bounds.height * ratio));
    context.setTransform(ratio, 0, 0, ratio, 0, 0);

    const tileWidth = getTileWidth(bounds.width, bounds.height);
    const nextColumns = Math.ceil(bounds.width / tileWidth) + 3;
    if (nextColumns === columns && cubes.length > 0) return;
    columns = nextColumns;
    cubes.length = 0;
    for (let row = COLOR_ROWS.length - 1; row >= 0; row -= 1) {
      for (let col = -2; col < columns; col += 1) {
        const colors = COLOR_ROWS[row];
        cubes.push({
          row,
          col,
          color: colors[positiveModulo(col * 3 + row * 2, colors.length)],
          lift: 0,
          targetLift: 0,
          hitArea: [],
        });
      }
    }
  };

  const draw = (): void => {
    const bounds = canvas.getBoundingClientRect();
    const tileWidth = getTileWidth(bounds.width, bounds.height);
    const topHeight = tileWidth * 0.43;
    const sideHeight = topHeight * 1.55;
    context.clearRect(0, 0, bounds.width, bounds.height);

    for (const cube of cubes) {
      cube.lift += (cube.targetLift - cube.lift) * 0.18;
      const centerX = cube.col * tileWidth + (cube.row % 2 ? tileWidth / 2 : 0);
      const visualRow = COLOR_ROWS.length - 1 - cube.row;
      const screenY = TOP_PADDING + topHeight / 2 + visualRow * topHeight - cube.lift;
      cube.hitArea = drawCube(context, centerX, screenY, tileWidth, topHeight, sideHeight, cube.color);
    }

    animationFrame = requestAnimationFrame(draw);
  };

  const onPointerMove = (event: PointerEvent): void => {
    const bounds = canvas.getBoundingClientRect();
    const point = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    const next = [...cubes].reverse().find((cube) => pointInPolygon(point, cube.hitArea)) ?? null;
    if (next === hovered) return;
    if (hovered) hovered.targetLift = 0;
    hovered = next;
    if (hovered) hovered.targetLift = 13;
    canvas.classList.toggle("is-hovering", hovered !== null);
  };

  const onPointerLeave = (): void => {
    if (hovered) hovered.targetLift = 0;
    hovered = null;
    canvas.classList.remove("is-hovering");
  };

  const resizeObserver = new ResizeObserver(rebuild);
  resizeObserver.observe(canvas);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerleave", onPointerLeave);
  rebuild();
  animationFrame = requestAnimationFrame(draw);

  return () => {
    cancelAnimationFrame(animationFrame);
    resizeObserver.disconnect();
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerleave", onPointerLeave);
  };
}

function drawCube(
  context: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  width: number,
  topHeight: number,
  sideHeight: number,
  color: string,
): Point[] {
  const halfWidth = width / 2;
  const halfTop = topHeight / 2;
  const top = { x: centerX, y: centerY - halfTop };
  const right = { x: centerX + halfWidth, y: centerY };
  const bottom = { x: centerX, y: centerY + halfTop };
  const left = { x: centerX - halfWidth, y: centerY };
  const bottomTip = { x: centerX, y: bottom.y + sideHeight };
  const leftTip = { x: left.x, y: left.y + sideHeight };
  const rightTip = { x: right.x, y: right.y + sideHeight };

  fillPolygon(context, [left, bottom, bottomTip, leftTip], shade(color, -28));
  fillPolygon(context, [bottom, right, rightTip, bottomTip], shade(color, -12));
  fillPolygon(context, [top, right, bottom, left], shade(color, 16));
  return [top, right, rightTip, bottomTip, leftTip, left];
}

function fillPolygon(context: CanvasRenderingContext2D, points: Point[], fill: string): void {
  context.beginPath();
  context.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length; index += 1) context.lineTo(points[index].x, points[index].y);
  context.closePath();
  context.fillStyle = fill;
  context.fill();
}

function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    const crosses = currentPoint.y > point.y !== previousPoint.y > point.y
      && point.x < (previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)
        / (previousPoint.y - currentPoint.y) + currentPoint.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function getTileWidth(_width: number, height: number): number {
  return Math.max(48, (height - TOP_PADDING - 2) / PATTERN_HEIGHT_IN_TILE_WIDTHS);
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function shade(hex: string, amount: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (shift: number): number => Math.max(0, Math.min(255, (value >> shift & 255) + amount));
  return `rgb(${channel(16)} ${channel(8)} ${channel(0)})`;
}
