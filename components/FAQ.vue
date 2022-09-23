<template>
  <section class="Faq">
    <div class="Faq_Inner">
      <h3 v-if="data.titleCopy" class="Faq_Title" v-html="data.titleCopy"></h3>
      <QuestionAndAnswer
        v-for="item in data.items"
        :key="item._id"
        :item="item"
      />
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
          items: [],
        }
      },
    },
  },
}
</script>
