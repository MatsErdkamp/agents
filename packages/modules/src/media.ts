import { z } from "zod";

const binaryContentSchema = z.union([
  z.string(),
  z.instanceof(Uint8Array),
  z.instanceof(ArrayBuffer)
]);

const imageUrlSchema = z.object({
  type: z.literal("image"),
  url: z.string().url(),
  mediaType: z.string().optional()
});

const imageDataSchema = z.object({
  type: z.literal("image"),
  data: binaryContentSchema,
  mediaType: z.string().optional()
});

const fileUrlSchema = z.object({
  type: z.literal("file"),
  url: z.string().url(),
  mediaType: z.string(),
  filename: z.string().optional()
});

const fileDataSchema = z.object({
  type: z.literal("file"),
  data: binaryContentSchema,
  mediaType: z.string(),
  filename: z.string().optional()
});

const audioUrlSchema = z.object({
  type: z.literal("audio"),
  url: z.string().url(),
  mediaType: z.string(),
  filename: z.string().optional()
});

const audioDataSchema = z.object({
  type: z.literal("audio"),
  data: binaryContentSchema,
  mediaType: z.string(),
  filename: z.string().optional()
});

export type ImageInput =
  | z.infer<typeof imageUrlSchema>
  | z.infer<typeof imageDataSchema>;
export type FileInput =
  | z.infer<typeof fileUrlSchema>
  | z.infer<typeof fileDataSchema>;
export type AudioInput =
  | z.infer<typeof audioUrlSchema>
  | z.infer<typeof audioDataSchema>;
export type MediaInput = ImageInput | FileInput | AudioInput;

export function image() {
  return z.union([imageUrlSchema, imageDataSchema]);
}

export function file() {
  return z.union([fileUrlSchema, fileDataSchema]);
}

export function audio() {
  return z.union([audioUrlSchema, audioDataSchema]);
}

export function isMediaInput(value: unknown): value is MediaInput {
  return (
    image().safeParse(value).success ||
    file().safeParse(value).success ||
    audio().safeParse(value).success
  );
}
