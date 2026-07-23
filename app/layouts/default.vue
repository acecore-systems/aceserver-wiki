<template>
  <div class="Wrapper">
    <Header
      :app="wiki.app"
      :links="wiki.links"
      :articles="wiki.articles"
      :categories="wiki.categories"
    />
    <main class="Main">
      <Navigation
        :current="currentArticle"
        :articles="wiki.articles"
        :categories="wiki.categories"
      />
      <slot />
    </main>
  </div>
</template>

<script setup>
const route = useRoute()
const { data: wiki } = await useWikiData()
const currentArticle = computed(() =>
  wiki.value.articles.find(
    (article) => article.slug === String(route.params.slug || ''),
  ),
)
</script>

<style>
html {
  font-size: 62.5%;
  height: 100%;
  scroll-padding-top: 110px;
}
body {
  margin: 0;
  padding: 0;
  font-size: 1.4rem;
  line-height: 1.8;
  color: #333;
  font-family:
    'Segoe UI Emoji', 'Helvetica Neue', Arial, 'Hiragino Kaku Gothic ProN',
    'Hiragino Sans', Meiryo, sans-serif;
  -webkit-text-size-adjust: 100%;
  height: 100%;
  overflow-wrap: break-word;
}
a {
  color: #006cdc;
  text-decoration: underline;
}
a:hover {
  text-decoration: none;
}
</style>

<style scoped>
.Wrapper {
  width: 100%;
  position: relative;
}
.Main {
  max-width: 1024px;
  margin: 0 auto;
  align-items: flex-start;
  min-height: 0;
  display: block;
  padding: 0;
}
@media (min-width: 600px) {
  .Main {
    display: flex;
    padding: 50px 60px 0 60px;
  }
}
</style>
