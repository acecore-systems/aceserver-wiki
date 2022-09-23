<template>
  <section class="Feature2">
    <div class="Feature2_Inner">
      <div class="Feature2_Data">
        <h3
          v-if="data.titleCopy"
          class="Feature2_Title"
          v-html="data.titleCopy"
        ></h3>
        <p v-if="data.text" class="Feature2_Text" v-html="data.text"></p>
      </div>
      <div v-if="data.image && data.image.src" class="Feature2_Image">
        <img :src="data.image.src" width="407" height="248" alt="" />
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
          titleCopy: '',
          text: '',
          image: null,
        }
      },
    },
  },
}
</script>
