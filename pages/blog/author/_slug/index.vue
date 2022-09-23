<template>
  <div class="Container">
    <div class="Container_Inner">
      <main class="Articles">
        <div class="Articles_Inner">
          <h2 class="Articles_Heading">
            Articles by {{ (currentAuthor && currentAuthor.fullName) || '' }}
          </h2>
          <ArticleCard
            v-for="article in articles"
            :key="article._id"
            :article="article"
          />
        </div>
        <Pagination
          :total="total"
          :current="1"
          :base-path="`/blog/author/${(currentAuthor && currentAuthor.slug) || ''}`"
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

    const currentAuthor =
      store.getters.authors.find((author) => author.slug === params.slug) ||
      null
    if (!currentAuthor) return redirect(302, '/')
    await store.dispatch('fetchArticles', {
      ...$config,
      author: (currentAuthor && currentAuthor._id) || '',
    })

    return {
      currentAuthor,
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
