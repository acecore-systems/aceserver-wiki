<template>
  <div class="Error">
    <span class="Error_Emoji">😵</span>
    <h1 v-if="error.statusCode === 404" class="Error_Message">
      Page not found
    </h1>
    <h1 v-else class="Error_Message">An error occurred</h1>
    <NuxtLink to="/" class="Error_Link">Back to the home page</NuxtLink>
  </div>
</template>

<script>
export default {
  layout: 'empty', // FIXME: Prevent Nuxt from using the default layout
  props: {
    error: {
      type: Object,
      default: null,
    },
  },
}
</script>
