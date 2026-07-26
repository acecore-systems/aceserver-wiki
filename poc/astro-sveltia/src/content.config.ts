import { defineCollection } from 'astro:content'
import { z } from 'astro/zod'
import { wikiMarkdownLoader } from './loaders/wiki-markdown-loader'

const wiki = defineCollection({
  loader: wikiMarkdownLoader(),
  schema: z
    .object({
      title: z.string().trim().min(1).max(100),
      description: z.string().trim().min(1).max(240),
      category: z.string().trim().min(1).max(60),
      order: z.number().int().min(0).max(9999),
      draft: z.boolean().default(false),
    })
    .strict(),
})

export const collections = { wiki }
