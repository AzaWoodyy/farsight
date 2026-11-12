import { z } from "zod";

/** Any JSON value: what JSON.parse can return once validated. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export const JsonSchema: z.ZodType<Json> = z.json();
