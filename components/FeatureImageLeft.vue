<template>
  <section class="Feature3">
    <div class="Feature3_Inner">
      <div v-if="data.image && data.image.src" class="Feature3_Image">
        <img
          :src="data.image.src"
          width="407"
          height="248"
          alt=""
          class="Feature3_Image"
        />
      </div>
      <div class="Feature3_Data">
        <h3
          v-if="data.titleCopy"
          class="Feature3_Title"
          v-html="data.titleCopy"
        ></h3>
        <p v-if="data.text" class="Feature3_Text" v-html="data.text"></p>
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
