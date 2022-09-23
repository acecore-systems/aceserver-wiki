<template>
  <dl class="Faq_Item">
    <dt @click="isOpen = !isOpen">
      <em>Q.</em>
      <span>{{ item.question }}</span>
      <svg
        v-if="isOpen"
        xmlns="http://www.w3.org/2000/svg"
        height="24px"
        viewBox="0 0 24 24"
        width="24px"
        fill="#333333"
      >
        <path d="M0 0h24v24H0V0z" fill="none" />
        <path d="M12 8l-6 6 1.41 1.41L12 10.83l4.59 4.58L18 14l-6-6z" />
      </svg>
      <svg
        v-else
        xmlns="http://www.w3.org/2000/svg"
        height="24px"
        viewBox="0 0 24 24"
        width="24px"
        fill="#333333"
      >
        <path d="M24 24H0V0h24v24z" fill="none" opacity=".87" />
        <path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6-1.41-1.41z" />
      </svg>
    </dt>
    <dd v-if="isOpen">
      <em>A.</em>
      <span>{{ item.answer }}</span>
    </dd>
  </dl>
</template>

<script>
export default {
  props: {
    item: {
      type: Object,
      default() {
        return {
          question: '',
          answer: '',
        }
      },
    },
  },
  data() {
    return {
      isOpen: false,
    }
  },
}
</script>
