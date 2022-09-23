<template>
  <section class="container mb-5">
    <div class="row">
      <div class="col-6 d-flex align-items-center">
        <div>
          <p
          v-if="data.shoulderCopy"
          class="text-muted"
          v-html="data.shoulderCopy"
        ></p>
        <h2
          v-if="data.titleCopy"
          v-html="data.titleCopy"
        ></h2>
        <p v-if="data.text" v-html="data.text"></p>
        <a
          v-if="data.ctaButton && data.ctaButton.label"
          class="btn btn-outline-primary"
          :href="data.ctaButton.url"
          rel="noreferrer noopener"
          :target="data.ctaButton.newTab ? '_blank' : ''"
          >{{ data.ctaButton.label }}</a
        >
        </div>
      </div>
      <div v-if="data.backgroundImage" class="col-6">
        <img :src="data.backgroundImage.src" width="540" height="370" alt="" />
      </div>
    </div>
  </section>
</template>

<script>
export default {
  props: {
    data: {
      type: Object,
      default() {
        return {
          shoulderCopy: '',
          titleCopy: '',
          text: '',
          ctaButton: {
            label: '',
            url: '',
            newTab: false,
          },
        }
      },
    },
  },
}
</script>
