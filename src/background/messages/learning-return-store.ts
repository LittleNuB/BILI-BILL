export interface LearningReturnPoint {
  tab: number;
  token: string | null;
  origin: number | null;
  expires: number;
}
const KEY = "bb-learning-return-points";
export class LearningReturnStore {
  private writes: Promise<unknown> = Promise.resolve();
  private storage: Pick<chrome.storage.StorageArea, "get" | "set">;
  constructor(storage: Pick<chrome.storage.StorageArea, "get" | "set">) {
    this.storage = storage;
  }
  async get(id: string): Promise<LearningReturnPoint | undefined> {
    const rows = ((await this.storage.get(KEY))[KEY] ?? {}) as Record<
      string,
      LearningReturnPoint
    >;
    const point = rows[id] as LearningReturnPoint | undefined;
    return point && point.expires > Date.now() ? point : undefined;
  }
  put(id: string, point: LearningReturnPoint | null) {
    const operation = this.writes
      .catch(() => {})
      .then(async () => {
        const current = (await this.storage.get(KEY))[KEY] ?? {};
        const rows: Record<string, LearningReturnPoint> = Object.fromEntries(
          Object.entries(current).filter(
            ([, value]) => (value as LearningReturnPoint).expires > Date.now(),
          ),
        );
        if (point) rows[id] = point;
        else delete rows[id];
        const bounded = Object.fromEntries(
          Object.entries(rows)
            .sort((a, b) => b[1].expires - a[1].expires)
            .slice(0, 16),
        );
        await this.storage.set({ [KEY]: bounded });
      });
    this.writes = operation;
    return operation;
  }
}
