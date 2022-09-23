<template>
  <div class="Container">
    <div class="Container_Inner">
      <main class="Articles">
        <div class="Articles_Inner">
          <h2 class="Articles_Heading">Articles in {{ year }}</h2>
          <ArticleCard
            v-for="article in articles"
            :key="article._id"
            :article="article"
          />
        </div>
        <Pagination
          :total="total"
          :current="1"
          :base-path="`/blog/archive/${year}`"
        />
      </main>
      <Side :tags="popularTags" :authors="authors" :archives="archives" />
    </div>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'
import { getSiteName } from 'utils/head'

export default {
  async asyncData({ $config, store, params, redirect }) {
    await store.dispatch('fetchApp', $config)
    await store.dispatch('fetchTags', $config)
    await store.dispatch('fetchAuthors', $config)
    await store.dispatch('fetchArchives', $config)

    const year = Number(params.slug)
    if (Number.isNaN(year)) return redirect(302, '/')
    await store.dispatch('fetchArticles', {
      ...$config,
      year,
    })

    return {
      year,
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
