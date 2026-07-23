import { DataTypes, Model, Sequelize } from "sequelize";
import path from "node:path";
import fs from "node:fs";

const databasePath =
  process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "poc.sqlite");

fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });

export const sequelize = new Sequelize({
  dialect: "sqlite",
  storage: path.resolve(databasePath),
  logging: false,
});

// NOTE: VirtualMachine + Assignment models are unused at runtime for now.
// Pool / sticky assignment / availability live in memory/state.ts.
// Kept so we can reintroduce durable shared state when scaling to multiple CPs.

export class VirtualMachine extends Model {
  declare id: string;
  declare externalId: string;
  declare status: "healthy" | "unhealthy";
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

export class Thread extends Model {
  declare id: string;
  declare userId: string;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

export class Assignment extends Model {
  declare id: string;
  declare vmId: string;
  declare threadId: string;
  declare status: "active" | "completed";
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

export class Transcript extends Model {
  declare id: string;
  declare threadId: string;
  declare key: string;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

export class BlobStorage extends Model {
  declare key: string;
  declare value: string;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

VirtualMachine.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    externalId: { type: DataTypes.STRING, allowNull: false, unique: true },
    status: {
      type: DataTypes.ENUM("healthy", "unhealthy"),
      allowNull: false,
      defaultValue: "healthy",
    },
  },
  { sequelize, tableName: "virtual_machines", underscored: true }
);

Thread.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    userId: { type: DataTypes.STRING, allowNull: false },
  },
  { sequelize, tableName: "threads", underscored: true }
);

Assignment.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    vmId: { type: DataTypes.UUID, allowNull: false },
    threadId: { type: DataTypes.UUID, allowNull: false, unique: true },
    status: {
      type: DataTypes.ENUM("active", "completed"),
      allowNull: false,
      defaultValue: "active",
    },
  },
  { sequelize, tableName: "assignments", underscored: true }
);

Transcript.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    threadId: { type: DataTypes.UUID, allowNull: false },
    key: { type: DataTypes.STRING, allowNull: false, unique: true },
  },
  { sequelize, tableName: "transcripts", underscored: true }
);

BlobStorage.init(
  {
    key: { type: DataTypes.STRING, primaryKey: true },
    value: { type: DataTypes.TEXT, allowNull: false },
  },
  { sequelize, tableName: "blob_storage", underscored: true }
);

Assignment.belongsTo(VirtualMachine, { foreignKey: "vmId", as: "vm" });
Assignment.belongsTo(Thread, { foreignKey: "threadId", as: "thread" });
VirtualMachine.hasMany(Assignment, { foreignKey: "vmId", as: "assignments" });
Thread.hasOne(Assignment, { foreignKey: "threadId", as: "assignment" });
Thread.hasMany(Transcript, { foreignKey: "threadId", as: "transcripts" });
Transcript.belongsTo(Thread, { foreignKey: "threadId", as: "thread" });

export async function initDb(options?: { force?: boolean }): Promise<void> {
  await sequelize.authenticate();
  await sequelize.sync(options?.force ? { force: true } : undefined);
}
