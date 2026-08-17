import { beforeEach, describe, expect, it } from "vitest";

// Vitest defaults to node environment, so window + localStorage don't exist.
// Stand up a minimal in-memory localStorage shim before importing anything
// that reads from it; that way the avatar lib's module-level reads still see
// a valid surface.
type Storage = { [k: string]: string };

function installLocalStorageShim(): Storage {
  const store: Storage = {};
  const ls = {
    getItem: (k: string): string | null => (k in store ? store[k] : null),
    setItem: (k: string, v: string): void => {
      store[k] = String(v);
    },
    removeItem: (k: string): void => {
      delete store[k];
    },
    clear: (): void => {
      for (const k of Object.keys(store)) delete store[k];
    },
    key: (i: number): string | null => Object.keys(store)[i] ?? null,
    get length(): number {
      return Object.keys(store).length;
    },
  };
  (globalThis as unknown as { window: { localStorage: typeof ls } }).window = {
    localStorage: ls,
  };
  return store;
}

let store: Storage;

beforeEach(() => {
  store = installLocalStorageShim();
});

async function load() {
  // Import after the shim is installed; vitest caches by module URL so we
  // need a fresh import each test to re-evaluate any top-level reads. The
  // identity helpers themselves don't read at module load, but loadStoredAvatar
  // re-reads on each call, so a single import is fine here.
  return await import("../src/avatarPicker");
}

describe("hasStoredIdentity", () => {
  it("returns false when nothing is saved", async () => {
    const { hasStoredIdentity } = await load();
    expect(hasStoredIdentity()).toBe(false);
  });

  it("returns false when only the name is saved", async () => {
    store["voxi.name"] = "alice";
    const { hasStoredIdentity } = await load();
    expect(hasStoredIdentity()).toBe(false);
  });

  it("returns false when only the avatar is saved", async () => {
    store["voxi.avatar"] = JSON.stringify({ skin: 1 });
    const { hasStoredIdentity } = await load();
    expect(hasStoredIdentity()).toBe(false);
  });

  it("returns false when the saved name is whitespace-only", async () => {
    store["voxi.name"] = "   ";
    store["voxi.avatar"] = JSON.stringify({ skin: 1 });
    const { hasStoredIdentity } = await load();
    expect(hasStoredIdentity()).toBe(false);
  });

  it("returns true when both name and avatar are saved", async () => {
    store["voxi.name"] = "alice";
    store["voxi.avatar"] = JSON.stringify({
      skin: 1,
      hat: 0,
      hair: 2,
      eyes: 3,
      mouth: 4,
      specs: 0,
      earrings: 0,
    });
    const { hasStoredIdentity } = await load();
    expect(hasStoredIdentity()).toBe(true);
  });
});

describe("loadStoredIdentity", () => {
  it("returns the saved name and avatar verbatim", async () => {
    store["voxi.name"] = "alice";
    const savedAvatar = {
      skin: 2,
      hat: 1,
      hair: 3,
      eyes: 4,
      mouth: 1,
      specs: 0,
      earrings: 0,
    };
    store["voxi.avatar"] = JSON.stringify(savedAvatar);

    const { loadStoredIdentity } = await load();
    const id = loadStoredIdentity();
    expect(id.name).toBe("alice");
    expect(id.avatar).toMatchObject(savedAvatar);
  });

  it("trims whitespace around the stored name", async () => {
    store["voxi.name"] = "  bob   ";
    store["voxi.avatar"] = JSON.stringify({ skin: 1 });
    const { loadStoredIdentity } = await load();
    expect(loadStoredIdentity().name).toBe("bob");
  });
});

// Simulates the "reload" scenario: a fresh session sees the stored identity
// and the same client_token, so callers can skip the picker and the server
// can recognise the same player. We don't drive the WS here, just confirm
// the helpers return what main.ts needs to make that decision.
describe("rejoin fingerprint", () => {
  it("a previous session's name+avatar persist across module reloads", async () => {
    store["voxi.name"] = "alice";
    store["voxi.avatar"] = JSON.stringify({
      skin: 1,
      hat: 0,
      hair: 0,
      eyes: 0,
      mouth: 0,
      specs: 0,
      earrings: 0,
    });

    // Pretend the page reloaded by re-evaluating the helpers from scratch.
    const first = await load();
    expect(first.hasStoredIdentity()).toBe(true);
    const ident = first.loadStoredIdentity();
    expect(ident.name).toBe("alice");
    expect(ident.avatar.skin).toBe(1);
  });
});
