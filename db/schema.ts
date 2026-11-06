import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const calls = sqliteTable(
  "calls",
  {
    id: text("id").primaryKey(),
    phoneNumber: text("phone_number").notNull(),
    state: text("state").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    data: text("data").notNull(),
  },
  (table) => [index("idx_calls_created_at").on(table.createdAt)],
);

export const distributors = sqliteTable(
  "distributors",
  {
    id: text("id").primaryKey(),
    company: text("company").notNull(),
    phoneNumber: text("phone_number").notNull(),
    state: text("state").notNull(),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    data: text("data").notNull(),
  },
  (table) => [
    index("idx_distributors_status_state").on(table.status, table.state),
  ],
);

export const relayConfig = sqliteTable("relay_config", {
  id: text("id").primaryKey(),
  data: text("data").notNull(),
  updatedAt: text("updated_at").notNull(),
});
