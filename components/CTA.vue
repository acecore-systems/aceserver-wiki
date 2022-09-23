<template>
  <section class="Cta">
    <h3 v-if="data.titleCopy" class="Cta_Title" v-html="data.titleCopy"></h3>
    <p v-if="data.text" class="Cta_Text" v-html="data.text"></p>
    <a
      v-if="data.ctaButton && data.ctaButton.label"
      class="Cta_Button"
      :href="data.ctaButton.url"
      rel="noreferrer noopener"
      :target="data.ctaButton.newTab ? '_blank' : ''"
      >{{ data.ctaButton.label }}</a
    >
  </section>
</template>

<script>
export default {
  props: {
    data: {
      type: Object,
      default() {
        return {
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
