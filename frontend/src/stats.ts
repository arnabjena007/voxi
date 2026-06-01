// Minimal stats dashboard. Polls the server's `/stats` JSON endpoint and
// renders the running totals. Lives on its own route (`/stats.html`) so it
// never touches the game in `main.ts`.

type Stats = {
  rooms_active: number;
  total_plays: number;
  unique_players: number;
};

const fmt = (n: number) => n.toLocaleString();

const set = (id: string, value: string) => {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
};

async function load(): Promise<void> {
  try {
    const res = await fetch("/stats", { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const s = (await res.json()) as Stats;
    set("unique", fmt(s.unique_players));
    set("plays", fmt(s.total_plays));
    set("rooms", fmt(s.rooms_active));
    set("foot", `updated ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    set("foot", `couldn't load stats - ${err instanceof Error ? err.message : err}`);
  }
}

load();
setInterval(load, 5000);
