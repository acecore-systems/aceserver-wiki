<template>
  <div>
    <Cover v-if="app && app.cover && app.cover.value" :img="app.cover.value" />
    <div class="container">
      <div class="row mt-5">
        <main class="col-8">
          <h2 class="mb-4">最新の記事</h2>
          <ArticleCard
            v-for="article in articles"
            :key="article._id"
            :article="article"
          />
          <Pagination :total="total" :current="1" />
        </main>
        <Side :tags="popularTags" :authors="authors" :archives="archives" class="col-4"/>
      </div>
    </div>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'
import { getSiteName } from 'utils/head'

export default {
  async asyncData({ $config, store }) {
    await store.dispatch('fetchApp', $config)
    await store.dispatch('fetchArticles', $config)
    await store.dispatch('fetchTags', $config)
    await store.dispatch('fetchAuthors', $config)
    await store.dispatch('fetchArchives', $config)
    return {}
  },
  head() {
    return {
      title: getSiteName(this.app),
    }
  },
  computed: {
    ...mapGetters([
      'app',
      'articles',
      'total',
      'popularTags',
      'authors',
      'archives',
    ]),
  },
}
</script>
