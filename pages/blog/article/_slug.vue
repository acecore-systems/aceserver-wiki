<template>
  <main class="container">
    <article v-if="currentArticle">
      <img :src="currentArticle.coverImage.src" alt="" class="w-100 mb-5"/>
      <h1 class="mb-3">{{ currentArticle.title }}</h1>
      <ul class="mb-3">
        <li v-for="tag in currentArticle.tags" :key="tag._id">
          <NuxtLink :to="`/blog/tag/${tag.slug}`">#{{ tag.name }}</NuxtLink>
        </li>
      </ul>
      <div class="row mb-5 d-flex align-items-center">
        <a href="#" class="col-2">
          <template
            v-if="
              currentArticle.author && currentArticle.author.profileImage
            "
          >
            <img
              :src="currentArticle.author.profileImage.src"
              alt=""
              width="32"
              height="32"
            />
          </template>
          <template v-else>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20px"
              height="20px"
              viewBox="0 0 24 24"
              fill="#CCCCCC"
            >
              <path d="M0 0h24v24H0V0z" fill="none" />
              <path
                d="M12 6c1.1 0 2 .9 2 2s-.9 2-2 2-2-.9-2-2 .9-2 2-2m0 10c2.7 0 5.8 1.29 6 2H6c.23-.72 3.31-2 6-2m0-12C9.79 4 8 5.79 8 8s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm0 10c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"
              />
            </svg>
          </template>
        </a>
        <div class="col-6">
          <NuxtLink
            :to="`/blog/author/${currentArticle.author.slug}`"
            class="Article_AuthorName"
            >{{ authorName }}</NuxtLink
          >
          <time :datetime="publishDateForAttr" class="Article_Date">{{
            publishDate
          }}</time>
        </div>
        <div class="col-4">
          <div class="row d-flex align-items-center">
            <div class="text-muted">この記事を共有</div>
            <button type="button" @click="shareOnTwitter" class="btn">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                height="24px"
                viewBox="0 0 24 24"
                width="24px"
                fill="#cccccc"
              >
                <path
                  d="M22.46 6c-.77.35-1.6.58-2.46.69.88-.53 1.56-1.37 1.88-2.38-.83.5-1.75.85-2.72 1.05C18.37 4.5 17.26 4 16 4c-2.35 0-4.27 1.92-4.27 4.29 0 .34.04.67.11.98C8.28 9.09 5.11 7.38 3 4.79c-.37.63-.58 1.37-.58 2.15 0 1.49.75 2.81 1.91 3.56-.71 0-1.37-.2-1.95-.5v.03c0 2.08 1.48 3.82 3.44 4.21a4.22 4.22 0 0 1-1.93.07 4.28 4.28 0 0 0 4 2.98 8.521 8.521 0 0 1-5.33 1.84c-.34 0-.68-.02-1.02-.06C3.44 20.29 5.7 21 8.12 21 16 21 20.33 14.46 20.33 8.79c0-.19 0-.37-.01-.56.84-.6 1.56-1.36 2.14-2.23z"
                />
              </svg>
            </button>
            <button type="button" @click="shareOnFacebook" class="btn">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                height="24px"
                viewBox="0 0 24 24"
                width="24px"
                fill="#cccccc"
              >
                <path
                  d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2m13 2h-2.5A3.5 3.5 0 0 0 12 8.5V11h-2v3h2v7h3v-7h3v-3h-3V9a1 1 0 0 1 1-1h2V5z"
                />
              </svg>
            </button>
          </div>
        </div>
      </div>
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div class="mb-5" v-html="currentArticle.body"></div>

      <div class="row border-top pt-4 mb-4">
        <div class="row d-flex align-items-center">
            <div class="col text-muted">この記事を共有</div>
            <button type="col button" @click="shareOnTwitter" class="btn">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                height="24px"
                viewBox="0 0 24 24"
                width="24px"
                fill="#cccccc"
              >
                <path
                  d="M22.46 6c-.77.35-1.6.58-2.46.69.88-.53 1.56-1.37 1.88-2.38-.83.5-1.75.85-2.72 1.05C18.37 4.5 17.26 4 16 4c-2.35 0-4.27 1.92-4.27 4.29 0 .34.04.67.11.98C8.28 9.09 5.11 7.38 3 4.79c-.37.63-.58 1.37-.58 2.15 0 1.49.75 2.81 1.91 3.56-.71 0-1.37-.2-1.95-.5v.03c0 2.08 1.48 3.82 3.44 4.21a4.22 4.22 0 0 1-1.93.07 4.28 4.28 0 0 0 4 2.98 8.521 8.521 0 0 1-5.33 1.84c-.34 0-.68-.02-1.02-.06C3.44 20.29 5.7 21 8.12 21 16 21 20.33 14.46 20.33 8.79c0-.19 0-.37-.01-.56.84-.6 1.56-1.36 2.14-2.23z"
                />
              </svg>
            </button>
            <button type="col button" @click="shareOnFacebook" class="btn">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                height="24px"
                viewBox="0 0 24 24"
                width="24px"
                fill="#cccccc"
              >
                <path
                  d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2m13 2h-2.5A3.5 3.5 0 0 0 12 8.5V11h-2v3h2v7h3v-7h3v-3h-3V9a1 1 0 0 1 1-1h2V5z"
                />
              </svg>
            </button>
          </div>
      </div>


      <NuxtLink
          :to="`/blog/author/${currentArticle.author.slug}`"
          class="card mb-5"
          >
        <div class="row d-flex align-items-center">
          <div class="col-2 text-center">
            <template
              v-if="currentArticle.author && currentArticle.author.profileImage"
            >
              <img
                :src="currentArticle.author.profileImage.src"
                alt=""
                width="48"
                height="48"
              />
            </template>
            <template v-else>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="28px"
                height="28px"
                viewBox="0 0 24 24"
                fill="#CCCCCC"
              >
                <path d="M0 0h24v24H0V0z" fill="none" />
                <path
                  d="M12 6c1.1 0 2 .9 2 2s-.9 2-2 2-2-.9-2-2 .9-2 2-2m0 10c2.7 0 5.8 1.29 6 2H6c.23-.72 3.31-2 6-2m0-12C9.79 4 8 5.79 8 8s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm0 10c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"
                />
              </svg>
            </template>
          </div>
          <div class="col-10">
            <div class="card-body">
              <div class="card-title">
                {{ authorName }}
              </div>
              <div class="card-text">
                <!-- eslint-disable vue/no-v-html -->
                <div class="Author_Description" v-html="authorBio"></div>
                <!-- eslint-enable vue/no-v-html -->
              </div>
            </div>
          </div>
        </div>
      </NuxtLink>

      <nav class="pb-5 mb-3 w-100">
        <NuxtLink
          v-if="previousArticle"
          :to="`/blog/article/${previousArticle.slug}`"
          class="float-left"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            height="24px"
            viewBox="0 0 24 24"
            width="24px"
            fill="#333333"
          >
            <path d="M0 0h24v24H0V0z" fill="none" opacity=".87" />
            <path
              d="M17.51 3.87L15.73 2.1 5.84 12l9.9 9.9 1.77-1.77L9.38 12l8.13-8.13z"
            />
          </svg>
          前の記事
        </NuxtLink>
        <NuxtLink
          v-if="nextArticle"
          :to="`/blog/article/${nextArticle.slug}`"
          href="#"
          class="float-right"
        >
          次の記事
          <svg
            xmlns="http://www.w3.org/2000/svg"
            enable-background="new 0 0 24 24"
            height="24px"
            viewBox="0 0 24 24"
            width="24px"
            fill="#333333"
          >
            <g><path d="M0,0h24v24H0V0z" fill="none" /></g>
            <g>
              <polygon points="6.23,20.23 8,22 18,12 8,2 6.23,3.77 14.46,12" />
            </g>
          </svg>
        </NuxtLink>
      </nav>
    </article>
  </main>
</template>

<script>
import { mapGetters } from 'vuex'
import { formatDate } from 'utils/date'
import { htmlToText } from 'html-to-text'

export default {
  async asyncData({ $config, store, params, redirect }) {
    await store.dispatch('fetchApp', $config)
    await store.dispatch('fetchCurrentArticle', {
      ...$config,
      slug: params.slug,
    })
    if (!store.getters.currentArticle) return redirect(302, '/')
    await store.dispatch('fetchPreviousArticle', {
      ...$config,
      createdAt: store.getters.currentArticle._sys.createdAt,
    })
    await store.dispatch('fetchNextArticle', {
      ...$config,
      createdAt: store.getters.currentArticle._sys.createdAt,
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
    ...mapGetters(['app', 'currentArticle', 'previousArticle', 'nextArticle']),
    meta() {
      if (this.currentArticle && this.currentArticle.meta) {
        return this.currentArticle.meta
      }
      return null
    },
    title() {
      if (this.meta && this.meta.title) {
        return this.meta.title
      }
      if (this.currentArticle && this.currentArticle.title) {
        return this.currentArticle.title
      }
      return this.app && (this.app.name || this.app.uid || 'Docs')
    },
    description() {
      if (this.meta && this.meta.description) {
        return this.meta.description
      }
      if (this.currentArticle && this.currentArticle.body) {
        return htmlToText(this.currentArticle.body, {
          selectors: [
            {
              selector: 'img',
              format: 'skip',
            },
          ],
        }).slice(0, 200)
      }
      return ''
    },
    ogImage() {
      if (this.meta && this.meta.ogImage) {
        return this.meta.ogImage.src
      }
      if (this.currentArticle && this.currentArticle.coverImage) {
        return this.currentArticle.coverImage.src
      }
      return ''
    },
    publishDate() {
      return this.currentArticle && this.currentArticle._sys.createdAt
        ? formatDate(this.currentArticle._sys.createdAt)
        : ''
    },
    publishDateForAttr() {
      return this.publishDate.replace(/\//g, '-')
    },
    authorName() {
      return (
        (this.currentArticle &&
          this.currentArticle.author &&
          this.currentArticle.author.fullName) ||
        'NO NAME'
      )
    },
    authorBio() {
      return (
        (this.currentArticle &&
          this.currentArticle.author &&
          this.currentArticle.author.biography) ||
        ''
      )
    },
  },
  methods: {
    shareOnTwitter() {
      window.open(
        'https://twitter.com/share?url=' +
          encodeURIComponent(window.location.href) +
          '&text=' +
          document.title,
        '',
        'menubar=no,toolbar=no,resizable=yes,scrollbars=yes,height=400,width=600'
      )
    },
    shareOnFacebook() {
      window.open(
        '//www.facebook.com/sharer.php?src=bm&u=' +
          encodeURIComponent(location.href),
        '_blank',
        'menubar=no,toolbar=no,resizable=yes,scrollbars=yes,height=400,width=600'
      )
    },
  },
}
</script>
