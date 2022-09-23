<template>
  <section class="Feature4">
    <div class="Feature4_Inner">
      <div
        v-for="feature in data.features"
        :key="feature._id"
        class="Feature4_Item"
      >
        <img
          v-if="feature.iconImage && feature.iconImage.src"
          :src="feature.iconImage.src"
          width="41"
          height="41"
          alt=""
          class="Feature4_Icon"
        />
        <div class="Feature4_Data">
          <h3
            v-if="feature.titleCopy"
            class="Feature4_Title"
            v-html="feature.titleCopy"
          ></h3>
          <p
            v-if="feature.text"
            class="Feature4_Text"
            v-html="feature.text"
          ></p>
        </div>
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
          features: [],
        }
      },
    },
  },
}
</script>
