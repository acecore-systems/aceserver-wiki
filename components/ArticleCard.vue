<template>
  <NuxtLink v-if="article" class="card mb-3" :to="`/blog/article/${article.slug}`">
    <div class="row">
      <div class="col-5">
        <template v-if="article.coverImage">
          <img :src="article.coverImage.src" alt="" width="300" height="200"/>
        </template>
        <template v-else>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="40px"
            height="40px"
            viewBox="0 0 24 24"
            fill="#CCCCCC"
          >
            <path d="M0 0h24v24H0V0z" fill="none" />
            <path
              d="M19 5v14H5V5h14m0-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-4.86 8.86l-3 3.87L9 13.14 6 17h12l-3.86-5.14z"
            />
          </svg>
        </template>
      </div>
      <div class="col-7">
        <div class="card-body">
          <h3 class="card-title">{{ article.title }}</h3>
          <ul class="card-text">
            <li v-for="tag in article.tags" :key="tag._id">#{{ tag.name }}</li>
          </ul>
          <div class="row">
            <div class="col-2">
              <template v-if="article.author && article.author.profileImage">
              <img
                :src="article.author.profileImage.src"
                alt=""
                width="32"
                height="32"
              />
            </template>
            <template v-else>
              <div class="card-text">
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
              </div>
            </template>
            </div>
            <div class="col-10">
              <div class="row">
                {{ authorName }}
              </div>
              <div class="row">
                <time
                  :datetime="formatDate(article._sys.createdAt).replace(/\//gm, '-')"
                  >{{ formatDate(article._sys.createdAt) }}</time
                >
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </NuxtLink>
</template>

<script>
import { formatDate } from 'utils/date'

export default {
  props: {
    article: {
      type: Object,
      default: null,
    },
  },
  computed: {
    authorName() {
      return (this.article.author && this.article.author.fullName) || 'NO NAME'
    },
  },
  methods: {
    formatDate(dateStr) {
      return dateStr ? formatDate(dateStr) : ''
    },
  },
}
</script>
