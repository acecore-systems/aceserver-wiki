<template>
  <Article v-if="currentArticle" :article="currentArticle" />
</template>

<script setup>
import {
  articlePath,
  buildArticleMetaDescription,
  buildArticleMetaTitle,
  canonicalUrl,
} from '#shared/lib/seo'

const route = useRoute()
const slug = computed(() => String(route.params.slug || ''))
const { data: wiki } = await useWikiData()
const { data: currentArticle, error } = await useAsyncData(
  () => `article:${slug.value}`,
  () => $fetch(`/api/articles/${encodeURIComponent(slug.value)}`),
  {
    deep: false,
    watch: [slug],
  },
)

if (error.value) {
  throw createError(error.value)
}

const meta = computed(() => currentArticle.value?.meta || null)
const canonical = computed(() =>
  canonicalUrl(articlePath(currentArticle.value?.slug || slug.value)),
)
const articleTitle = computed(
  () =>
    meta.value?.title ||
    currentArticle.value?.title ||
    wiki.value.app?.name ||
    wiki.value.app?.uid ||
    'Docs',
)
const title = computed(() => buildArticleMetaTitle(articleTitle.value))
const description = computed(() =>
  buildArticleMetaDescription({
    title: articleTitle.value,
    description: meta.value?.description || '',
    body: currentArticle.value?.body || '',
  }),
)
const ogImage = computed(() => meta.value?.ogImage?.src || '')

useSeoMeta({
  title: () => title.value,
  description: () => description.value,
  robots: 'index, follow',
  ogType: 'article',
  ogTitle: () => title.value,
  ogDescription: () => description.value,
  ogImage: () => ogImage.value,
  twitterCard: 'summary_large_image',
})
useHead(() => ({
  link: [{ rel: 'canonical', href: canonical.value }],
}))
</script>
