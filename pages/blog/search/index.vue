<template>
  <main class="Container">
    <div v-if="articles.length > 0" class="Search">
      <p class="Search_Text">Found {{ total }} results for your search</p>
      <div class="Search_Results">
        <article v-for="article in articles" :key="article._id" class="Article">
          <NuxtLink :to="`/blog/article/${article.slug}`" class="Article_Link">
            <h1 class="Article_Title">{{ article.title }}</h1>
            <p class="Article_Description">{{ htmlToText(article.body) }}</p>
          </NuxtLink>
        </article>
        <Pagination />
      </div>
    </div>
    <div v-else-if="isLoading === false" class="Empty">
      <div class="Empty_Emoji">😵</div>
      <h1 class="Empty_Title">Nothing found</h1>
      <p class="Empty_Description">
        Sorry, but nothing matched search terms…<br />Please try again with
        different keywords!
      </p>
    </div>
  </main>
</template>

<script>
import { mapGetters } from 'vuex'
import { getSiteName } from 'utils/head'
import { htmlToText } from 'html-to-text'

export default {
  async asyncData({ $config, store }) {
    await store.dispatch('fetchApp', $config)
    return {}
  },
  data() {
    return {
      isLoading: true,
    }
  },
  head() {
    return {
      title: getSiteName(this.app),
    }
  },
  computed: {
    ...mapGetters(['app', 'articles', 'total']),
  },
  async created() {
    await this.$store.dispatch('fetchArticles', {
      ...this.$config,
      search: this.$route.query.q || '',
      query: {
        limit: 100,
      },
    })
    this.isLoading = false
  },
  methods: {
    htmlToText(html) {
      return htmlToText(html, {
        selectors: [
          {
            selector: 'img',
            format: 'skip',
          },
        ],
      })
    },
  },
}
</script>
