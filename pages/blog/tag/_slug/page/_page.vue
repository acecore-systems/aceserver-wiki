<template>
  <div class="Container">
    <div class="Container_Inner">
      <main class="Articles">
        <div class="Articles_Inner">
          <h2 class="Articles_Heading">
            #{{ (currentTag && currentTag.name) || '' }}
          </h2>
          <ArticleCard
            v-for="article in articles"
            :key="article._id"
            :article="article"
          />
        </div>
        <Pagination
          :total="total"
          :current="pageNumber"
          :base-path="`/blog/tag/${(currentTag && currentTag.slug) || ''}`"
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
  async asyncData({ $config, store, redirect, params }) {
    await store.dispatch('fetchApp', $config)
    await store.dispatch('fetchTags', $config)
    await store.dispatch('fetchAuthors', $config)
    await store.dispatch('fetchArchives', $config)

    const pageNumber = Number(params.page)
    if (Number.isNaN(pageNumber)) return redirect(302, '/')
    const currentTag = store.getters.tags.find(
      (tag) => tag.slug === params.slug
    )
    if (!currentTag) return redirect(302, '/')
    await store.dispatch('fetchArticles', {
      ...$config,
      tag: (currentTag && currentTag._id) || '',
      page: pageNumber,
    })

    return {
      currentTag,
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
