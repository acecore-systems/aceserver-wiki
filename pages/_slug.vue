<template>
  <div v-if="page">
    <component
      :is="section.type"
      v-for="section in page.sections"
      :key="section._id"
      :data="section.data"
    />
  </div>
</template>

<script>
import { mapGetters } from 'vuex'
export default {
  async asyncData({ store, $config, params }) {
    await store.dispatch('fetchApp', $config)
    await store.dispatch('fetchPage', {
      ...$config,
      slug: params.slug,
    })
    return {}
  },
  head() {
    return {
      title: this.title,
      meta: [
        {
          hid: 'description',
          name: 'description',
          content: this.description,
        },
        {
          hid: 'og:type',
          property: 'og:type',
          content: 'article'
        },
        {
          hid: 'og:title',
          property: 'og:title',
          content: this.title,
        },
        {
          hid: 'og:description',
          property: 'og:description',
          content: this.description,
        },
        {
          hid: 'og:image',
          property: 'og:image',
          content: this.ogImage,
        },
        {
          name: 'twitter:card',
          content: 'summary_large_image'
        },
      ],
    }
  },
  computed: {
    ...mapGetters(['app', 'page']),
    meta() {
      if (this.page && this.page.meta) {
        return this.page.meta
      }
      return null
    },
    title() {
      if (this.meta && this.meta.title) {
        return this.meta.title
      }
      if (this.page && this.page.pageName) {
        return this.page.pageName
      }
      return this.app && (this.app.name || this.app.uid || 'Landing page')
    },
    description() {
      if (this.meta && this.meta.description) {
        return this.meta.description
      }
      return ''
    },
    ogImage() {
      if (this.meta && this.meta.ogImage) {
        return this.meta.ogImage.src
      }
      return ''
    },
  },
}
</script>
