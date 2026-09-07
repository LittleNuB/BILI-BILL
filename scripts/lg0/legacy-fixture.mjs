import { BiliAnalyticsDB } from "../../src/background/storage/db.ts";
import { canonical } from "./learning-lab.mjs";

export async function seedLegacy(name) {
  if (!/^lg0-[a-zA-Z0-9-]+$/.test(name)) throw new Error("lab_database_only");
  const db = new BiliAnalyticsDB(name);
  try {
    await db.open();
    if (db.verno !== 13) throw new Error("legacy_schema_drift");
    const stores = Object.fromEntries(
      db.tables.map((table) => [
        table.name,
        [
          table.schema.primKey.src,
          ...table.schema.indexes.map((index) => index.src),
        ].join(", "),
      ]),
    );
    for (const table of db.tables)
      await table.put({ id: 1, lg0SyntheticMarker: table.name });
    const before = await legacySnapshot(db, Object.keys(stores));
    return { stores, before };
  } finally {
    db.close();
  }
}

export async function legacySnapshot(db, names) {
  const result = {};
  for (const name of names) result[name] = await db.table(name).toArray();
  return canonical(result);
}
