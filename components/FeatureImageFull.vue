<template>
  <section class="Feature1">
    <h3
      v-if="data.titleCopy"
      class="Feature1_Title"
      v-html="data.titleCopy"
    ></h3>
    <p v-if="data.text" class="Feature1_Text" v-html="data.text"></p>
    <img
      v-if="data.image && data.image.src"
      :src="data.image.src"
      width="980"
      height="307"
      alt=""
      class="Feature1_Image"
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
