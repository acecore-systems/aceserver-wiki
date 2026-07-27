import { defineCollection } from 'astro:content'
import { z } from 'astro/zod'
import { wikiMarkdownLoader } from './loaders/wiki-markdown-loader'

const wiki = defineCollection({
  loader: wikiMarkdownLoader(),
  schema: z
    .object({
      title: z.string().trim().min(1).max(100),
      seoTitle: z.string().trim().min(1).max(100).optional(),
      description: z.string().trim().min(1).max(240),
      category: z.string().trim().min(1).max(60),
      order: z.number().int().min(0).max(9999),
      ogImage: z
        .string()
        .trim()
        .regex(
          /^\/uploads\/wiki\/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*\.(?:avif|gif|jpe?g|png|webp)$/u,
        )
        .optional(),
      draft: z.boolean().default(false),
    })
    .strict(),
})

export const collections = { wiki }
