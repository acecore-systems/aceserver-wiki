<template>
  <div class="SearchResult">
    <div class="SearchResult_Text">
      Found {{ numberOfSearchResult }} results for your search
    </div>
    <p v-if="isLoading" class="Empty">Searching...</p>
    <template v-else-if="searchResults.length > 0">
      <div
        v-for="article in searchResults"
        :key="article._id"
        class="SearchResult_Item"
      >
        <div class="SearchResult_ItemUrl">
          {{ `${origin}/article/${article.slug}/` }}
        </div>
        <NuxtLink
          :to="`/article/${article.slug}/`"
          class="SearchResult_ItemTitle"
        >
          {{ article.title }}
        </NuxtLink>
        <div class="SearchResult_ItemDescription">
          {{ article.text }}
        </div>
      </div>
    </template>
    <p v-else class="Empty">Please try again with different keywords.</p>
  </div>
</template>

<script setup>
import { SITE_TITLE, SITE_URL } from '#shared/lib/seo'

const route = useRoute()
const isLoading = ref(true)
const searchResults = ref([])
const numberOfSearchResult = computed(() => searchResults.value.length)
const origin = computed(() =>
  import.meta.client ? window.location.origin : SITE_URL,
)

const search = async () => {
  isLoading.value = true
  searchResults.value = []
  try {
    const articles = await $fetch('/search-index.json')
    const query = String(route.query.q || '')
      .trim()
      .toLocaleLowerCase()
    searchResults.value = query
      ? articles.filter((article) =>
          `${article.title} ${article.text}`
            .toLocaleLowerCase()
            .includes(query),
        )
      : []
  } finally {
    isLoading.value = false
  }
}

onMounted(search)
watch(() => route.query.q, search)

useSeoMeta({
  title: `サイト内検索 | ${SITE_TITLE}`,
  robots: 'noindex, follow',
})
useHead({
  link: [{ rel: 'canonical', href: `${SITE_URL}/search/` }],
})
</script>

<style scoped>
.SearchResult {
  padding: 74px 24px 52px 24px;
  flex: 1;
  min-width: 0;
}
.SearchResult_Text {
  margin: 0 0 28px 0;
}
.SearchResult_Item {
  margin: 0 0 28px 0;
}
.SearchResult_ItemUrl {
  font-size: 1.2rem;
}
.SearchResult_ItemTitle {
  font-size: 1.8rem;
  text-decoration: none;
}
.SearchResult_ItemTitle:hover {
  text-decoration: underline;
}
.SearchResult_ItemDescription {
  font-size: 1.4rem;
  display: -webkit-box;
  overflow: hidden;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
@media (min-width: 600px) {
  .SearchResult {
    padding: 60px 0 52px 0;
  }
}
.Empty {
  font-size: 1.6rem;
  margin: -20px 0 0 0;
  color: #888;
}
</style>
