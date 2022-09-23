<template>
  <section class="Logos">
    <h3 v-if="data.text" class="Logos_Title" v-html="data.text"></h3>
    <ul class="Logos_List">
      <li v-for="logo in data.logoImages" :key="logo._id">
        <img :src="logo.src" width="125" height="46" alt="" />
      </li>
    </ul>
  </section>
</template>

<script>
export default {
  props: {
    data: {
      type: Object,
      default() {
        return {
          text: '',
          logoImages: [],
        }
      },
    },
  },
}
</script>
