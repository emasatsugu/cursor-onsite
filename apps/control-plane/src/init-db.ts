import { initDb, sequelize } from "./db/index.js";

async function main() {
  const force = process.argv.includes("--force");
  await initDb({ force });
  const [tables] = await sequelize.query(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  );
  console.log(`SQLite ready at ${process.env.DATABASE_PATH ?? "./data/poc.sqlite"}`);
  console.log(
    "tables:",
    (tables as Array<{ name: string }>).map((t) => t.name).join(", ")
  );
  await sequelize.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
