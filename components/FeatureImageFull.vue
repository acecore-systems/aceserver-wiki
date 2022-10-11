<template>
  <section class="container mb-5">
    <h3
      v-if="data.titleCopy"
      v-html="data.titleCopy"
      class="text-center"
    ></h3>
    <p v-if="data.text" v-html="data.text" class="text-center"></p>
    <img
      v-if="data.image && data.image.src"
      :src="data.image.src"
      class="h-auto w-100"
    />
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
          image: null,
        }
      },
    },
  },
}
</script>
