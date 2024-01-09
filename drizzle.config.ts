import type { Config } from "drizzle-kit";
export default {
  schema: "./src/store/postgres/postgres.schema.ts",
  out: "./drizzle",
} satisfies Config;