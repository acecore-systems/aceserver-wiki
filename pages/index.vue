<template>
  <div>Loading...</div>
</template>

<script>
import { ROOT_DESCRIPTION, SITE_TITLE, SITE_URL, articlePath } from '~/utils/seo'
export default {
  async asyncData({ store, $config, redirect }) {
    await store.dispatch('fetchCategories', $config)
    await store.dispatch('fetchLinks', $config)
    await store.dispatch('fetchArticles', $config)
    const article = store.getters.topArticle
    if (article) redirect(302, articlePath(article.slug))
    return {}
  },
  head() {
    return {
      title: SITE_TITLE,
      meta: [
        {
          hid: 'description',
          name: 'description',
          content: ROOT_DESCRIPTION,
        },
        {
          hid: 'robots',
          name: 'robots',
          content: 'index, follow',
        },
      ],
      link: [
        { hid: 'canonical', rel: 'canonical', href: `${SITE_URL}/` },
      ],
    }
  },
}
</script>
