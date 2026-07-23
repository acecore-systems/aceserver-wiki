<template>
  <section class="Home">
    <h1 class="Home_Title">{{ SITE_TITLE }}</h1>
    <p class="Home_Description">{{ ROOT_DESCRIPTION }}</p>

    <NuxtLink
      v-if="topArticle"
      class="Home_Start"
      :to="articlePath(topArticle.slug)"
    >
      Wikiを読む
    </NuxtLink>

    <section
      v-for="category in categories"
      :key="category._id"
      class="Home_Category"
    >
      <h2>{{ category.name }}</h2>
      <ul>
        <li
          v-for="article in getArticlesOfCategory(category._id)"
          :key="article.slug"
        >
          <NuxtLink :to="articlePath(article.slug)">
            {{ article.title }}
          </NuxtLink>
        </li>
      </ul>
    </section>
  </section>
</template>

<script setup>
import {
  ROOT_DESCRIPTION,
  ROOT_META_TITLE,
  SITE_TITLE,
  SITE_URL,
  articlePath,
} from '#shared/lib/seo'

const { data: wiki } = await useWikiData()
const categories = computed(() => wiki.value.categories)
const articles = computed(() => wiki.value.articles)
const topArticle = computed(() => {
  const topCategory = categories.value[0]
  if (!topCategory) return null
  return (
    articles.value.find(
      (article) => article.category?._id === topCategory._id,
    ) || null
  )
})

const getArticlesOfCategory = (categoryId) =>
  articles.value.filter((article) => article.category?._id === categoryId)

useSeoMeta({
  title: ROOT_META_TITLE,
  description: ROOT_DESCRIPTION,
  robots: 'index, follow',
})
useHead({
  link: [{ rel: 'canonical', href: `${SITE_URL}/` }],
})
</script>

<style scoped>
.Home {
  flex: 1;
  min-width: 0;
  padding: 84px 24px 52px;
}
.Home_Title {
  margin: 0 0 16px;
  font-size: 3.2rem;
  line-height: 1.4;
}
.Home_Description {
  margin: 0 0 24px;
  font-size: 1.6rem;
}
.Home_Start {
  display: inline-block;
  margin: 0 0 36px;
  padding: 10px 18px;
  border-radius: 4px;
  background: #006cdc;
  color: #fff;
  font-weight: bold;
  text-decoration: none;
}
.Home_Start:hover {
  background: #0059b8;
}
.Home_Category {
  margin: 0 0 32px;
}
.Home_Category h2 {
  margin: 0 0 12px;
  padding: 0 0 4px;
  border-bottom: 2px solid #333;
  font-size: 2rem;
}
.Home_Category ul {
  margin: 0;
  padding: 0 0 0 24px;
}
@media (min-width: 600px) {
  .Home {
    padding: 60px 0 52px;
  }
}
</style>
