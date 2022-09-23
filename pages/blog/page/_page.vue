<template>
  <div>
    <Cover v-if="app && app.cover && app.cover.value" :img="app.cover.value" />
    <div class="Container">
      <div class="Container_Inner">
        <main class="Articles">
          <div class="Articles_Inner">
            <h2 class="Articles_Heading">最新の記事</h2>
            <ArticleCard
              v-for="article in articles"
              :key="article._id"
              :article="article"
            />
          </div>
          <Pagination :total="total" :current="pageNumber" />
        </main>
        <Side :tags="popularTags" :authors="authors" :archives="archives" />
      </div>
    </div>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'
import { getSiteName } from 'utils/head'

export default {
  async asyncData({ $config, store, redirect, params }) {
    await store.dispatch('fetchApp', $config)
    await store.dispatch('fetchTags', $config)
    await store.dispatch('fetchAuthors', $config)
    await store.dispatch('fetchArchives', $config)

    const pageNumber = Number(params.page)
    if (Number.isNaN(pageNumber)) return redirect(302, '/')
    await store.dispatch('fetchArticles', {
      ...$config,
      page: pageNumber,
    })

    return {
      pageNumber,
    }
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
