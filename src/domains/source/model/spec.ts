import { z } from "zod";
import { SOURCE_KINDS, SOURCE_MODES } from "./types.ts";

export const sourceAddInputSchema = z
  .object({
    input: z.string().min(1),
    kind: z.enum(SOURCE_KINDS).default("auto"),
    mode: z.enum(SOURCE_MODES).default("snapshot"),
    name: z.string().trim().min(1).max(200).optional(),
    recursive: z.boolean().default(false),
    include: z.array(z.string().min(1)).default([]),
    exclude: z.array(z.string().min(1)).default([]),
    noBuild: z.boolean().default(false),
    stdinBytes: z.instanceof(Uint8Array).optional(),
  })
  .strict();

export type SourceAddInput = z.infer<typeof sourceAddInputSchema>;
