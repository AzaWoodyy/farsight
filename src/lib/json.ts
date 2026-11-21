import { z } from "zod";

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export const JsonSchema: z.ZodType<Json> = z.json();
