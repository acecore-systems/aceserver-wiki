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

<script>
import { mapGetters } from 'vuex'
import {
  ROOT_DESCRIPTION,
  SITE_TITLE,
  SITE_URL,
  articlePath,
} from '~/utils/seo'

export default {
  async asyncData({ store, $config }) {
    await store.dispatch('fetchApp', $config)
    await store.dispatch('fetchCategories', $config)
    await store.dispatch('fetchLinks', $config)
    await store.dispatch('fetchArticles', $config)
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
      link: [{ hid: 'canonical', rel: 'canonical', href: `${SITE_URL}/` }],
    }
  },
  computed: {
    ...mapGetters(['categories', 'articles', 'topArticle']),
    ROOT_DESCRIPTION: () => ROOT_DESCRIPTION,
    SITE_TITLE: () => SITE_TITLE,
  },
  methods: {
    articlePath,
    getArticlesOfCategory(categoryId) {
      return this.articles.filter(
        (article) => article.category && article.category._id === categoryId
      )
    },
  },
}
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
